import type { Expression, Node, ObjectExpression } from "@babel/types";
import { loadBabelParser } from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";
import { type ArgvWord, classify } from "./classify.ts";
import { ALLOW, type Dialect, type Rule, type Verdict } from "./verdict.ts";

/** API names only fs uses: blocked wherever code names them, so aliases made in earlier cells are caught too. */
const DISTINCTIVE_DELETE: Readonly<Record<string, true>> = { rmSync: true, unlinkSync: true, rmdirSync: true, unlink: true, rmdir: true };

/** child_process launch names only it uses: matched as bare calls too, so imports from earlier cells are caught. */
const DISTINCTIVE_LAUNCH: Readonly<Record<string, true>> = { execSync: true, spawnSync: true, execFileSync: true };

type Module = "fs" | "fs/promises" | "child_process" | "bun";

/** Names bound in this cell: whole-module bindings, imported members (`module.export`), and `Bun.file(…)` results. */
type Bindings = {
	readonly modules: Map<string, Module>;
	readonly members: Map<string, string>;
	readonly bunFiles: Set<string>;
};

type Context = { readonly code: string; readonly bindings: Bindings; readonly shell: Dialect; readonly brush: Dialect };

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function moduleOf(source: string): Module | null {
	const name = source.startsWith("node:") ? source.slice(5) : source;
	return name === "fs" || name === "fs/promises" || name === "child_process" || name === "bun" ? name : null;
}

/** `require("m")`, `await import("m")`, `require("fs").promises`: the module the expression yields. */
function moduleExpression(node: Node | null | undefined): Module | null {
	if (!node) return null;
	if (node.type === "AwaitExpression") return moduleExpression(node.argument);
	if (node.type === "CallExpression") {
		const [first] = node.arguments;
		const source = first?.type === "StringLiteral" ? first.value : null;
		if (source === null) return null;
		if ((node.callee.type === "Identifier" && node.callee.name === "require") || node.callee.type === "Import") return moduleOf(source);
		return null;
	}
	if (node.type === "MemberExpression" && propertyName(node) === "promises" && moduleExpression(node.object) === "fs") return "fs/promises";
	return null;
}

/** The property a member access names: `a.b`, `a?.b`, `a["b"]`. */
function propertyName(node: Node): string | null {
	if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (node.property.type === "StringLiteral") return node.property.value;
	return null;
}

/** The module an object expression stands for: a bound name or a module expression. */
function receiverModule(node: Node, bindings: Bindings): Module | null {
	if (node.type === "Identifier") return bindings.modules.get(node.name) ?? null;
	return moduleExpression(node);
}

/** `object.name` on a global such as `Bun` or `JSON`. */
const isMember = (node: Node, object: string, name: string): boolean =>
	(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
	node.object.type === "Identifier" &&
	node.object.name === object &&
	propertyName(node) === name;

const isBunMember = (node: Node, name: string): boolean => isMember(node, "Bun", name);

function isBunFile(node: Node, bindings: Bindings): boolean {
	if (node.type === "AwaitExpression") return isBunFile(node.argument, bindings);
	if (node.type === "Identifier") return bindings.bunFiles.has(node.name);
	return node.type === "CallExpression" && isBunMember(node.callee, "file");
}

function collectBindings(root: Node): Bindings {
	const bindings: Bindings = { modules: new Map(), members: new Map(), bunFiles: new Set() };
	walk(root, null, (node) => {
		if (node.type === "ImportDeclaration") {
			const module = moduleOf(node.source.value);
			if (module === null) return;
			for (const specifier of node.specifiers) {
				if (specifier.type === "ImportSpecifier") {
					const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
					bindings.members.set(specifier.local.name, `${module}.${imported}`);
				} else bindings.modules.set(specifier.local.name, module);
			}
			return;
		}
		if (node.type !== "VariableDeclarator" || !node.init) return;
		if (node.id.type === "Identifier") {
			const module = moduleExpression(node.init);
			if (module !== null) bindings.modules.set(node.id.name, module);
			if (isBunFile(node.init, bindings)) bindings.bunFiles.add(node.id.name);
			return;
		}
		if (node.id.type !== "ObjectPattern") return;
		const module = moduleExpression(node.init);
		if (module === null) return;
		for (const property of node.id.properties) {
			if (property.type !== "ObjectProperty" || property.key.type !== "Identifier") continue;
			if (property.value.type === "Identifier") bindings.members.set(property.value.name, `${module}.${property.key.name}`);
		}
	});
	return bindings;
}

/** Visits every node depth first with its parent. */
function walk(node: Node, parent: Node | null, visit: (node: Node, parent: Node | null) => void): void {
	visit(node, parent);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) walk(item, node, visit);
		} else if (isNode(value)) walk(value, node, visit);
	}
}

/** A string the code spells out completely: a string literal or a template without `${}`. */
function literalString(node: Node | null | undefined): string | null {
	if (!node) return null;
	if (node.type === "StringLiteral") return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
	return null;
}

function objectProperty(node: ObjectExpression, key: string): Node | null {
	for (const property of node.properties) {
		if (property.type !== "ObjectProperty") continue;
		const name =
			property.key.type === "Identifier" && !property.computed
				? property.key.name
				: property.key.type === "StringLiteral"
					? property.key.value
					: null;
		if (name === key) return property.value;
	}
	return null;
}

function argvOf(nodes: readonly (Node | null)[]): ArgvWord[] {
	return nodes.map((node) => {
		const text = literalString(node);
		return text === null ? { text: "", literal: false } : { text, literal: true };
	});
}

/** What a call hands to a shell or runs as a program, by the API it calls. */
type ShellCall =
	| { readonly kind: "script"; readonly dialect: Dialect; readonly arg: Node | null | undefined }
	| { readonly kind: "spawn"; readonly args: readonly Node[] }
	| { readonly kind: "bunSpawn"; readonly arg: Node | null | undefined }
	| { readonly kind: "bridge"; readonly arg: Node | null | undefined }
	| { readonly kind: "deviceWrite"; readonly arg: Node | null | undefined };

/** The child_process / Bun / bridge API a callee names, if any. */
function shellCallOf(callee: Node, args: readonly Node[], ctx: Context): ShellCall | null {
	const { bindings } = ctx;
	let api: string | null = null;
	if (callee.type === "Identifier")
		api = bindings.members.get(callee.name) ?? (DISTINCTIVE_LAUNCH[callee.name] ? `child_process.${callee.name}` : null);
	else if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
		const property = propertyName(callee);
		if (property === null) return null;
		if (callee.object.type === "Identifier" && callee.object.name === "tool") {
			if (property === "bash") return { kind: "bridge", arg: args[0] };
			if (property === "write") return { kind: "deviceWrite", arg: args[0] };
			return null;
		}
		if (isBunMember(callee, "spawn") || isBunMember(callee, "spawnSync")) return { kind: "bunSpawn", arg: args[0] };
		const module = receiverModule(callee.object, bindings);
		if (module !== null) api = `${module}.${property}`;
		else if (property === "execSync") api = "child_process.execSync";
		else if (property === "spawnSync" || property === "execFileSync") api = `child_process.${property}`;
	}
	switch (api) {
		case "child_process.exec":
		case "child_process.execSync":
			return { kind: "script", dialect: ctx.shell, arg: args[0] };
		case "child_process.spawn":
		case "child_process.spawnSync":
		case "child_process.execFile":
		case "child_process.execFileSync":
			return { kind: "spawn", args };
		case "bun.spawn":
		case "bun.spawnSync":
			return { kind: "bunSpawn", arg: args[0] };
		default:
			return null;
	}
}

function judgeShellCall(call: ShellCall, fragment: string, ctx: Context): Verdict {
	const nonLiteral = (what: string): Verdict => block("nonLiteral", fragment, `${what} is not a literal string`);
	switch (call.kind) {
		case "script": {
			const text = literalString(call.arg);
			return text === null ? nonLiteral("the command handed to a shell") : classify(call.dialect, { kind: "script", text }, 1);
		}
		case "spawn": {
			const [command, second, third] = call.args;
			const list = second?.type === "ArrayExpression" ? second.elements : [];
			const options = second?.type === "ObjectExpression" ? second : third?.type === "ObjectExpression" ? third : null;
			const shell = options === null ? null : objectProperty(options, "shell");
			const words = argvOf([command ?? null, ...list.map((item) => (item?.type === "SpreadElement" ? null : item))]);
			if (shell?.type === "BooleanLiteral" && shell.value) {
				if (words.some((word) => !word.literal)) return nonLiteral("the command handed to a shell");
				return classify(ctx.shell, { kind: "script", text: words.map((word) => word.text).join(" ") }, 1);
			}
			if (second && second.type !== "ArrayExpression" && second.type !== "ObjectExpression") return nonLiteral("the argument list");
			return classify(ctx.brush, { kind: "argv", words }, 1);
		}
		case "bunSpawn": {
			const arg = call.arg;
			const list = arg?.type === "ArrayExpression" ? arg : arg?.type === "ObjectExpression" ? objectProperty(arg, "cmd") : null;
			if (list?.type !== "ArrayExpression") return nonLiteral("the command list");
			return classify(
				ctx.brush,
				{ kind: "argv", words: argvOf(list.elements.map((item) => (item?.type === "SpreadElement" ? null : item))) },
				1,
			);
		}
		case "bridge": {
			const command = call.arg?.type === "ObjectExpression" ? literalString(objectProperty(call.arg, "command")) : null;
			return command === null ? nonLiteral("the bash bridge command") : classify(ctx.brush, { kind: "script", text: command }, 1);
		}
		case "deviceWrite": {
			if (call.arg?.type !== "ObjectExpression" || literalString(objectProperty(call.arg, "path")) !== "xd://bash") return ALLOW;
			const content = objectProperty(call.arg, "content");
			const command = payloadCommand(content);
			return command === null ? nonLiteral("the xd://bash payload") : classify(ctx.brush, { kind: "script", text: command }, 1);
		}
		default: {
			const unreachable: never = call;
			return unreachable;
		}
	}
}

/** The command of an `xd://bash` payload written as a JSON string or as `JSON.stringify({ command: … })`. */
function payloadCommand(content: Node | null): string | null {
	if (content?.type === "CallExpression" && isMember(content.callee, "JSON", "stringify")) {
		const [object] = content.arguments;
		return object?.type === "ObjectExpression" ? literalString(objectProperty(object, "command")) : null;
	}
	const text = literalString(content);
	return text === null ? null : bridgeCommand(text);
}

/** The `command` of an `xd://bash` JSON payload, or null when it is not literal JSON with a string command. */
function bridgeCommand(content: string): string | null {
	try {
		const payload: unknown = JSON.parse(content);
		if (typeof payload === "object" && payload !== null && "command" in payload && typeof payload.command === "string")
			return payload.command;
	} catch {
		// Malformed payload: the device would reject it too; treat it as non-literal.
	}
	return null;
}

/** Whether a name in this position refers to something, rather than declaring a property or method key. */
function isReference(node: Node, parent: Node | null): boolean {
	if (parent === null) return true;
	if (
		(parent.type === "ObjectProperty" ||
			parent.type === "ObjectMethod" ||
			parent.type === "ClassMethod" ||
			parent.type === "ClassProperty") &&
		parent.key === node &&
		!parent.computed
	) {
		return false;
	}
	return !(
		(parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
		parent.property === node &&
		!parent.computed
	);
}

/** Judges one node; `statement` is the top-level statement holding it, quoted for deletion APIs. */
function judgeNode(node: Node, parent: Node | null, statement: Node, ctx: Context): Verdict {
	const fragment = (target: Node): string => ctx.code.slice(target.start ?? 0, target.end ?? 0);
	const quoted = fragment(statement);
	const { bindings } = ctx;
	if (node.type === "Identifier" && isReference(node, parent)) {
		if (DISTINCTIVE_DELETE[node.name]) return block("delete", quoted, `\`${node.name}\` deletes files`);
		const member = bindings.members.get(node.name);
		const exported = member?.slice(member.lastIndexOf(".") + 1) ?? "";
		const fromFs = member?.startsWith("fs.") === true || member?.startsWith("fs/promises.") === true;
		if (fromFs && (exported === "rm" || DISTINCTIVE_DELETE[exported])) return block("delete", quoted, `\`${member}\` deletes files`);
	}
	if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
		const property = propertyName(node);
		if (property !== null && DISTINCTIVE_DELETE[property]) return block("delete", quoted, `\`${property}\` deletes files`);
		if (property === "rm") {
			const module = receiverModule(node.object, bindings);
			if (module === "fs" || module === "fs/promises") return block("delete", quoted, `\`${module}.rm\` deletes files`);
		}
		if (property === "delete" && isBunFile(node.object, bindings)) return block("delete", quoted, "`Bun.file(…).delete()` deletes files");
	}
	if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
		const args = node.arguments.filter((arg): arg is Expression => arg.type !== "SpreadElement" && arg.type !== "ArgumentPlaceholder");
		const call = shellCallOf(node.callee, args, ctx);
		if (call !== null) return judgeShellCall(call, fragment(node), ctx);
	}
	if (node.type === "TaggedTemplateExpression") {
		const tag = node.tag;
		const isShellTag = isBunMember(tag, "$") || (tag.type === "Identifier" && bindings.members.get(tag.name) === "bun.$");
		if (isShellTag) {
			const text = literalString(node.quasi);
			if (text === null)
				return block("nonLiteral", fragment(node), "the `Bun.$` template interpolates values, so it is not a literal command");
			return classify(ctx.brush, { kind: "script", text }, 1);
		}
	}
	return ALLOW;
}

/**
 * Classifies a js eval cell: fs deletion APIs block, and every command handed to
 * a shell or spawned is classified (`shell` for child_process strings, `brush`
 * for `Bun.$`, `Bun.spawn` argv and the `tool.bash` bridge). Parse failures throw
 * to the hook boundary, which blocks the call.
 */
export async function classifyJs(code: string, shell: Dialect, brush: Dialect): Promise<Verdict> {
	const { parse } = await loadBabelParser();
	const file = parse(code, {
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		allowImportExportEverywhere: true,
		allowNewTargetOutsideFunction: true,
		allowSuperOutsideMethod: true,
		allowUndeclaredExports: true,
		errorRecovery: true,
		plugins: ["typescript"],
	});
	const ctx: Context = { code, bindings: collectBindings(file.program), shell, brush };
	let verdict: Verdict = ALLOW;
	for (const statement of file.program.body) {
		walk(statement, file.program, (node, parent) => {
			if (verdict.kind === "block") return;
			verdict = judgeNode(node, parent, statement, ctx);
		});
		if (verdict.kind === "block") return verdict;
	}
	return verdict;
}
