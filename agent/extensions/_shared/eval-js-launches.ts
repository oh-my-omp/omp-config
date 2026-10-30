/**
 * JavaScript eval cells, parsed with omp's own Babel parser and the kernel's
 * options: the cell's module bindings (`import`, `require`, destructuring,
 * `Bun.file(…)` results) and the process launch a node starts. Mechanics only:
 * what to do with a parse error, a non-literal command or an alias is the
 * caller's decision. Used by delete-guard (fail closed) and tool-policy-nag's
 * pty lane (fail open).
 */
import type { Expression, Node, ObjectExpression, Program } from "@babel/types";
import { loadBabelParser } from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";
import type { LaunchVia, LaunchWord } from "./eval-py-launches.ts";

/**
 * A process launch at one node. `childScript`: child_process `exec`/`execSync`
 * text for the system shell; `childSpawn`: `spawn`/`spawnSync`/`execFile`/
 * `execFileSync` argv (`words` null when the argument list is not an array),
 * `shell` when the options may start a shell; `bunSpawn`: `Bun.spawn` argv
 * (null when not an array or `{ cmd: [...] }`); `bunShell`: a `Bun.$` template
 * (null text when it interpolates); `bridge`: `tool.bash({ command })` and
 * `tool.write` to `xd://bash`, which run as real `bash` tool calls. A `null`
 * command or word text is not a literal the code spells out.
 */
export type JsLaunch =
	| { readonly kind: "childScript"; readonly api: string; readonly via: LaunchVia; readonly text: string | null }
	| {
			readonly kind: "childSpawn";
			readonly api: string;
			readonly via: LaunchVia;
			readonly shell: boolean;
			readonly words: readonly LaunchWord[] | null;
	  }
	| { readonly kind: "bunSpawn"; readonly words: readonly LaunchWord[] | null }
	| { readonly kind: "bunShell"; readonly text: string | null }
	| { readonly kind: "bridge"; readonly source: "bash" | "deviceWrite"; readonly command: string | null };

export type JsCell = { readonly program: Program; readonly bindings: Bindings };

/** Parses a cell the way the kernel does; a syntax error Babel cannot recover from throws. */
export async function parseJs(code: string): Promise<JsCell> {
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
	return { program: file.program, bindings: collectBindings(file.program) };
}

/** The launch a node starts — a child_process, Bun or harness-bridge call, or a `Bun.$` template — or null. */
export function jsLaunchOf(node: Node, bindings: Bindings): JsLaunch | null {
	if (node.type === "TaggedTemplateExpression") {
		const tag = node.tag;
		const isShellTag = isBunMember(tag, "$") || (tag.type === "Identifier" && bindings.members.get(tag.name) === "bun.$");
		return isShellTag ? { kind: "bunShell", text: literalString(node.quasi) } : null;
	}
	if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return null;
	const args = node.arguments.filter((arg): arg is Expression => arg.type !== "SpreadElement" && arg.type !== "ArgumentPlaceholder");
	const callee = node.callee;
	let api: string | null = null;
	let via: LaunchVia = "direct";
	if (callee.type === "Identifier") {
		const member = bindings.members.get(callee.name);
		if (member !== undefined) {
			api = member;
			via = member.endsWith(`.${callee.name}`) ? "direct" : "alias";
		} else if (DISTINCTIVE_LAUNCH.has(callee.name)) {
			api = `child_process.${callee.name}`;
			via = "distinctive";
		}
	} else if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
		const property = propertyName(callee);
		if (property === null) return null;
		if (callee.object.type === "Identifier" && callee.object.name === "tool") return bridgeLaunch(property, args[0]);
		if (isBunMember(callee, "spawn") || isBunMember(callee, "spawnSync")) return { kind: "bunSpawn", words: bunSpawnWords(args[0]) };
		const module = receiverModule(callee.object, bindings);
		if (module !== null) {
			api = `${module}.${property}`;
			via = callee.object.type === "Identifier" && callee.object.name !== module ? "alias" : "direct";
		} else if (property === "execSync" || property === "spawnSync" || property === "execFileSync") {
			api = `child_process.${property}`;
			via = "distinctive";
		}
	}
	switch (api) {
		case "child_process.exec":
		case "child_process.execSync":
			return { kind: "childScript", api, via, text: literalString(args[0]) };
		case "child_process.spawn":
		case "child_process.spawnSync":
		case "child_process.execFile":
		case "child_process.execFileSync":
			return { kind: "childSpawn", api, via, ...spawnArguments(args) };
		case "bun.spawn":
		case "bun.spawnSync":
			return { kind: "bunSpawn", words: bunSpawnWords(args[0]) };
		default:
			return null;
	}
}

/** `tool.bash({ command })`, or `tool.write` to `xd://bash`; other `tool.*` calls and device paths start no shell. */
function bridgeLaunch(property: string, arg: Node | undefined): JsLaunch | null {
	if (property === "bash")
		return {
			kind: "bridge",
			source: "bash",
			command: arg?.type === "ObjectExpression" ? literalString(objectProperty(arg, "command")) : null,
		};
	if (property !== "write" || arg?.type !== "ObjectExpression" || literalString(objectProperty(arg, "path")) !== "xd://bash") return null;
	return { kind: "bridge", source: "deviceWrite", command: payloadCommand(objectProperty(arg, "content")) };
}

/** child_process spawn arguments: `(command, [args], options)` or `(command, options)`; an argument list that is not an array is unknown. */
function spawnArguments(args: readonly Node[]): { readonly shell: boolean; readonly words: readonly LaunchWord[] | null } {
	const [command, second, third] = args;
	if (second && second.type !== "ArrayExpression" && second.type !== "ObjectExpression") return { shell: false, words: null };
	const list = second?.type === "ArrayExpression" ? second.elements : [];
	const options = second?.type === "ArrayExpression" ? third : second;
	const words = argvOf([command ?? null, ...list.map((item) => (item?.type === "SpreadElement" ? null : item))]);
	return { shell: mayUseShell(options), words };
}

/** `Bun.spawn([...])` or `Bun.spawn({ cmd: [...] })`; anything else is unknown. */
function bunSpawnWords(arg: Node | undefined): readonly LaunchWord[] | null {
	const list = arg?.type === "ArrayExpression" ? arg : arg?.type === "ObjectExpression" ? objectProperty(arg, "cmd") : null;
	if (list?.type !== "ArrayExpression") return null;
	return argvOf(list.elements.map((item) => (item?.type === "SpreadElement" ? null : item)));
}

/** child_process launch names only it uses: matched as bare calls too, so imports from earlier cells are caught. */
const DISTINCTIVE_LAUNCH: ReadonlySet<string> = new Set(["execSync", "spawnSync", "execFileSync"]);

type Module = "fs" | "fs/promises" | "child_process" | "bun";

/** Names bound in this cell: whole-module bindings, imported members (`module.export`), and `Bun.file(…)` results. */
type Bindings = {
	readonly modules: Map<string, Module>;
	readonly members: Map<string, string>;
	readonly bunFiles: Set<string>;
};

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
export function propertyName(node: Node): string | null {
	if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (node.property.type === "StringLiteral") return node.property.value;
	return null;
}

/** The module an object expression stands for: a bound name, `<fs>.promises`, or a module expression. */
export function receiverModule(node: Node, bindings: Bindings): Module | null {
	if (node.type === "Identifier") return bindings.modules.get(node.name) ?? null;
	if (node.type === "AwaitExpression") return receiverModule(node.argument, bindings);
	if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && propertyName(node) === "promises")
		return receiverModule(node.object, bindings) === "fs" ? "fs/promises" : null;
	return moduleExpression(node);
}

/** Binds `local` to `module.imported`; `promises` of fs binds a whole `fs/promises` module. */
function bindMember(bindings: Bindings, local: string, module: Module, imported: string): void {
	if (module === "fs" && imported === "promises") bindings.modules.set(local, "fs/promises");
	else bindings.members.set(local, `${module}.${imported}`);
}

/** `object.name` on a global such as `Bun` or `JSON`. */
const isMember = (node: Node, object: string, name: string): boolean =>
	(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
	node.object.type === "Identifier" &&
	node.object.name === object &&
	propertyName(node) === name;

const isBunMember = (node: Node, name: string): boolean => isMember(node, "Bun", name);

export function isBunFile(node: Node, bindings: Bindings): boolean {
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
					bindMember(bindings, specifier.local.name, module, imported);
				} else bindings.modules.set(specifier.local.name, module);
			}
			return;
		}
		if (node.type !== "VariableDeclarator" || !node.init) return;
		if (node.id.type === "Identifier") {
			const module = receiverModule(node.init, bindings);
			if (module !== null) bindings.modules.set(node.id.name, module);
			if (isBunFile(node.init, bindings)) bindings.bunFiles.add(node.id.name);
			return;
		}
		if (node.id.type !== "ObjectPattern") return;
		const module = receiverModule(node.init, bindings);
		if (module === null) return;
		for (const property of node.id.properties) {
			if (property.type !== "ObjectProperty" || property.key.type !== "Identifier") continue;
			if (property.value.type === "Identifier") bindMember(bindings, property.value.name, module, property.key.name);
		}
	});
	return bindings;
}

/** Visits every node depth first with its parent. */
export function walk(node: Node, parent: Node | null, visit: (node: Node, parent: Node | null) => void): void {
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

/**
 * Whether child_process options may start a shell: a `shell` that is not literally `false`, `null` or `undefined`
 * (`shell: "/bin/sh"`, `shell: flag`), or options the code does not spell out (a variable, a spread).
 */
function mayUseShell(options: Node | undefined): boolean {
	if (options === undefined) return false;
	if (options.type !== "ObjectExpression") return true;
	if (options.properties.some((property) => property.type === "SpreadElement")) return true;
	const shell = objectProperty(options, "shell");
	if (shell === null) return false;
	if (shell.type === "BooleanLiteral") return shell.value;
	return shell.type !== "NullLiteral" && !(shell.type === "Identifier" && shell.name === "undefined");
}

function argvOf(nodes: readonly (Node | null | undefined)[]): LaunchWord[] {
	return nodes.map((node) => {
		const text = literalString(node);
		return text === null ? { text: "", literal: false } : { text, literal: true };
	});
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
