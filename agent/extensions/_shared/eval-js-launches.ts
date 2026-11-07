/**
 * JavaScript eval cells, parsed with omp's own Babel parser and the kernel's
 * options: the cell's module bindings (`import`, `require`, destructuring,
 * `Bun.file(…)` results), the launcher aliases it binds (`const $ = Bun.$`,
 * `const e = require("child_process").execSync`, …) and the process launch a
 * node starts. Mechanics only: what to do with a parse error, a non-literal
 * command or an alias is the caller's decision. Used by delete-guard (fail
 * closed) and tool-policy-nag's pty lane (fail open).
 */
import type { ArrayExpression, Expression, Node, ObjectExpression, ObjectProperty, Program } from "@babel/types";
import { loadBabelParser } from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";
import type { LaunchVia, LaunchWord } from "./eval-py-launches.ts";

// Loaded once when this module loads, so the parser is synchronous for every caller (delete-guard classifies bash
// calls on the hook path, which cannot await).
const { parse: babelParse } = await loadBabelParser();

/**
 * A process launch at one node. `childScript`: child_process `exec`/`execSync`
 * text for the system shell; `childSpawn`: `spawn`/`spawnSync`/`execFile`/
 * `execFileSync` argv (`words` null when the argument list is not an array),
 * `shell` when the options may start a shell; `bunSpawn`: `Bun.spawn` argv
 * (null when not an array or `{ cmd: [...] }`); `bunShell`: a `Bun.$` template
 * (null text when it interpolates); `bridge`: `tool.bash({ command })` and
 * `tool.write` to `xd://bash`, which run as real `bash` tool calls. A `null`
 * command or word text is not a literal the code spells out.
 * `indeterminate`: a launch whose command the source does not determine — a
 * spread argument, a spread element in an argv array, or an argument object
 * with a spread, method or accessor, computed non-literal key or duplicate key.
 * `what` names the unreadable part.
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
	| { readonly kind: "bridge"; readonly source: "bash" | "deviceWrite"; readonly command: string | null }
	| { readonly kind: "indeterminate"; readonly what: string };

export type JsCell = { readonly program: Program; readonly bindings: Bindings; readonly carry: JsCarry };

/**
 * Module and launcher names a session's earlier cells bound and ran. Only the
 * names that can reach a launcher are carried: `child_process` and `bun` module
 * aliases, and launcher members.
 */
export type JsCarry = {
	readonly modules: ReadonlyMap<string, Module>;
	readonly members: ReadonlyMap<string, string>;
};

/** The carry of a session with no earlier cells. */
export const EMPTY_CARRY: JsCarry = { modules: new Map(), members: new Map() };

/** Parses a cell the way the kernel does; a syntax error Babel cannot recover from throws. `prior` seeds the names earlier cells of the session carried. */
export function parseJs(code: string, prior: JsCarry = EMPTY_CARRY): JsCell {
	const file = babelParse(code, {
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
	return collectBindings(file.program, prior);
}

/** The launch a node starts — a child_process, Bun or harness-bridge call, or a `Bun.$` template — or null. */
export function jsLaunchOf(node: Node, bindings: Bindings): JsLaunch | null {
	if (node.type === "TaggedTemplateExpression") {
		const tag = node.tag;
		const isShellTag = isBunMember(tag, "$") || (tag.type === "Identifier" && memberName(bindings, tag.name) === "bun.$");
		return isShellTag ? { kind: "bunShell", text: literalString(node.quasi) } : null;
	}
	if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return null;
	const target = calleeApi(node.callee, bindings);
	if (target === null) return null;
	const { api, via } = target;
	const args = node.arguments.filter((arg): arg is Expression => arg.type !== "SpreadElement" && arg.type !== "ArgumentPlaceholder");
	// A spread argument reorders or widens every positional slot at runtime, so the
	// command the call hands its launcher cannot be read from the source.
	const opaque = args.length !== node.arguments.length;
	switch (api) {
		case "tool.bash":
			return opaque ? unknownLaunch(api) : bashBridge(args[0]);
		case "tool.write":
			return opaque ? unknownLaunch(api) : deviceWriteBridge(args[0]);
		case "child_process.exec":
		case "child_process.execSync":
			return opaque ? unknownLaunch(api) : { kind: "childScript", api, via, text: literalString(args[0]) };
		case "child_process.spawn":
		case "child_process.spawnSync":
		case "child_process.execFile":
		case "child_process.execFileSync": {
			if (opaque) return unknownLaunch(api);
			const shape = spawnArguments(args);
			return shape.kind === "indeterminate" ? unknownLaunch(`${api} options`) : { kind: "childSpawn", api, via, ...shape.value };
		}
		case "bun.spawn":
		case "bun.spawnSync": {
			if (opaque) return unknownLaunch(api);
			const words = bunSpawnWords(args[0]);
			return words.kind === "indeterminate" ? unknownLaunch(`${api} command list`) : { kind: "bunSpawn", words: words.value };
		}
		default:
			return null;
	}
}

/** The API a callee names, with how the cell reached it: a bound launcher name, `tool.*`, `Bun.spawn*`, or a module member. */
function calleeApi(callee: Node, bindings: Bindings): { readonly api: string; readonly via: LaunchVia } | null {
	if (callee.type === "Identifier") {
		const member = memberName(bindings, callee.name);
		if (member !== undefined) return { api: member, via: member.endsWith(`.${callee.name}`) ? "direct" : "alias" };
		return DISTINCTIVE_LAUNCH.has(callee.name) ? { api: `child_process.${callee.name}`, via: "distinctive" } : null;
	}
	if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return null;
	const property = propertyName(callee);
	if (property === null) return null;
	if (callee.object.type === "Identifier" && callee.object.name === "tool") return { api: `tool.${property}`, via: "direct" };
	if (isBunMember(callee, "spawn") || isBunMember(callee, "spawnSync")) return { api: `bun.${property}`, via: "direct" };
	const module = receiverModule(callee.object, bindings);
	if (module !== null)
		return {
			api: `${module}.${property}`,
			via: callee.object.type === "Identifier" && callee.object.name !== module ? "alias" : "direct",
		};
	return DISTINCTIVE_LAUNCH.has(property) ? { api: `child_process.${property}`, via: "distinctive" } : null;
}

const unknownLaunch = (what: string): JsLaunch => ({ kind: "indeterminate", what });

/** `tool.bash({ command })`; any other argument is a bridge with an unknown command. */
function bashBridge(arg: Node | undefined): JsLaunch {
	if (arg?.type !== "ObjectExpression") return { kind: "bridge", source: "bash", command: null };
	const props = propsOf(arg);
	if (props.kind === "indeterminate") return unknownLaunch("the `tool.bash` arguments");
	return { kind: "bridge", source: "bash", command: literalString(props.value.get("command")) };
}

/** `tool.write` to `xd://bash`; other paths start no shell. */
function deviceWriteBridge(arg: Node | undefined): JsLaunch | null {
	if (arg?.type !== "ObjectExpression") return null;
	const props = propsOf(arg);
	if (props.kind === "indeterminate") return unknownLaunch("the `tool.write` arguments");
	if (literalString(props.value.get("path")) !== "xd://bash") return null;
	const command = payloadCommand(props.value.get("content"));
	if (command.kind === "indeterminate") return unknownLaunch("the xd://bash payload");
	return { kind: "bridge", source: "deviceWrite", command: command.value };
}

/** child_process spawn arguments: `(command, [args], options)` or `(command, options)`; an argument list that is not an array is unknown. */
function spawnArguments(args: readonly Expression[]): Read<{ readonly shell: boolean; readonly words: readonly LaunchWord[] | null }> {
	const [command, second, third] = args;
	if (second !== undefined && second.type !== "ArrayExpression" && second.type !== "ObjectExpression") {
		return read({ shell: false, words: null });
	}
	const list = second?.type === "ArrayExpression" ? second : null;
	const options = list === null ? second : third;
	const words = argvOf([command], list);
	const shell = mayUseShell(options);
	if (words.kind === "indeterminate" || shell.kind === "indeterminate") return UNKNOWN;
	return read({ shell: shell.value, words: words.value });
}

/** `Bun.spawn([...])` or `Bun.spawn({ cmd: [...] })`; anything else is unknown. */
function bunSpawnWords(arg: Node | undefined): Read<readonly LaunchWord[] | null> {
	if (arg?.type === "ArrayExpression") return argvOf([], arg);
	if (arg?.type !== "ObjectExpression") return read(null);
	const props = propsOf(arg);
	if (props.kind === "indeterminate") return UNKNOWN;
	const cmd = props.value.get("cmd");
	return cmd?.type === "ArrayExpression" ? argvOf([], cmd) : read(null);
}

/** child_process launch names only it uses: matched as bare calls too, so imports from earlier cells are caught. */
const DISTINCTIVE_LAUNCH: ReadonlySet<string> = new Set(["execSync", "spawnSync", "execFileSync"]);

/** Launcher members a binding may hold: a name bound to one of them is a launcher wherever it is called. */
const LAUNCHER_MEMBERS: ReadonlySet<string> = new Set([
	"bun.$",
	"bun.spawn",
	"bun.spawnSync",
	"tool.bash",
	"child_process.exec",
	"child_process.execSync",
	"child_process.spawn",
	"child_process.spawnSync",
	"child_process.execFile",
	"child_process.execFileSync",
]);

/** Modules whose functions can start a process; their aliases are carried between cells. */
const LAUNCHER_MODULES: ReadonlySet<Module> = new Set<Module>(["child_process", "bun"]);

export type Module = "fs" | "fs/promises" | "child_process" | "bun";

/**
 * Names bound in this cell only: whole-module bindings, imported or destructured
 * members (`module.export`), launcher aliases, and `Bun.file(…)` results, plus
 * `prior`, the names earlier cells carried. Reads fall through to `prior`, so a
 * fresh cell does not copy the names it was seeded with.
 */
export type Bindings = {
	readonly modules: Map<string, Module>;
	readonly members: Map<string, string>;
	readonly bunFiles: Set<string>;
	readonly prior: JsCarry;
};

/** The module `name` resolves to: this cell's binding, else the carried one. */
const moduleName = (bindings: Bindings, name: string): Module | undefined => bindings.modules.get(name) ?? bindings.prior.modules.get(name);

/** The member `name` resolves to: this cell's binding, else the carried one. */
const memberName = (bindings: Bindings, name: string): string | undefined => bindings.members.get(name) ?? bindings.prior.members.get(name);

/** A value the source determines, or a shape the runtime may change (spread, method, accessor, computed or duplicate key, spread array element). */
type Read<T> = { readonly kind: "read"; readonly value: T } | { readonly kind: "indeterminate" };
const read = <T>(value: T): Read<T> => ({ kind: "read", value });
const UNKNOWN: { readonly kind: "indeterminate" } = { kind: "indeterminate" };

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
	if (node.type === "Identifier") return moduleName(bindings, node.name) ?? null;
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

/** The launcher member a value names: `Bun.$`, `Bun.spawn`, `tool.bash`, a child_process function, or a launcher name already bound. */
function launcherMemberOf(node: Node, bindings: Bindings): string | null {
	let member: string | null = null;
	if (node.type === "Identifier") member = memberName(bindings, node.name) ?? null;
	else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
		const property = propertyName(node);
		if (property !== null) {
			if (isBunMember(node, "$") || isBunMember(node, "spawn") || isBunMember(node, "spawnSync")) member = `bun.${property}`;
			else if (node.object.type === "Identifier" && node.object.name === "tool") member = `tool.${property}`;
			else if (receiverModule(node.object, bindings) === "child_process") member = `child_process.${property}`;
		}
	}
	return member !== null && LAUNCHER_MEMBERS.has(member) ? member : null;
}

/** Binds a declared or assigned name to the module, Bun file or launcher its value is. */
function bindName(bindings: Bindings, name: string, init: Node, { launchersOnly }: { readonly launchersOnly: boolean }): void {
	if (!launchersOnly) {
		const module = receiverModule(init, bindings);
		if (module !== null) bindings.modules.set(name, module);
		if (isBunFile(init, bindings)) bindings.bunFiles.add(name);
	}
	const launcher = launcherMemberOf(init, bindings);
	if (launcher !== null) bindings.members.set(name, launcher);
}

/**
 * The cell's own bindings and the carry it leaves later cells. `bindings`
 * records only what this cell binds; `carry` is `prior` itself when the cell
 * binds nothing launcher-reaching, so a session of plain cells copies nothing.
 */
function collectBindings(root: Program, prior: JsCarry): JsCell {
	const bindings: Bindings = { modules: new Map(), members: new Map(), bunFiles: new Set(), prior };
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
		// Assignments to a name carry launcher aliases only: `s = Bun.spawn`.
		if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type === "Identifier") {
			bindName(bindings, node.left.name, node.right, { launchersOnly: true });
			return;
		}
		if (node.type !== "VariableDeclarator" || !node.init) return;
		if (node.id.type === "Identifier") {
			bindName(bindings, node.id.name, node.init, { launchersOnly: false });
			return;
		}
		if (node.id.type !== "ObjectPattern") return;
		// `const { spawn, $ } = Bun` destructures the global Bun object.
		const module = node.init.type === "Identifier" && node.init.name === "Bun" ? "bun" : receiverModule(node.init, bindings);
		if (module === null) return;
		for (const property of node.id.properties) {
			if (property.type !== "ObjectProperty" || property.key.type !== "Identifier") continue;
			if (property.value.type === "Identifier") bindMember(bindings, property.value.name, module, property.key.name);
		}
	});
	return { program: root, bindings, carry: carryOf(bindings) };
}

/**
 * The launcher-reaching names `bindings` leaves for later cells: `prior`
 * unchanged when the cell binds nothing, else `prior` with this cell's names
 * applied — a name the cell binds to a launcher is kept, a name it rebinds to a
 * non-launcher module (or member) is dropped from the same kind of entry, the
 * rest of `prior` survives. A name rebound to a plain value, or to the other
 * kind (a module for a member name, a member for a module name), keeps its
 * `prior` entry, as it did before the carry was incremental.
 */
function carryOf(bindings: Bindings): JsCarry {
	const { modules, members, prior } = bindings;
	if (modules.size === 0 && members.size === 0) return prior;
	const carryModules = new Map(prior.modules);
	for (const [name, module] of modules) {
		if (LAUNCHER_MODULES.has(module)) carryModules.set(name, module);
		else carryModules.delete(name);
	}
	const carryMembers = new Map(prior.members);
	for (const [name, member] of members) {
		if (LAUNCHER_MEMBERS.has(member)) carryMembers.set(name, member);
		else carryMembers.delete(name);
	}
	return { modules: carryModules, members: carryMembers };
}

/**
 * Visits every node depth first with its parent, returning `true` once a visit
 * ended the walk: a visit returning `true` visits no sibling or descendant
 * after it, and the stop propagates to the caller. Children come from the
 * node's own fields in declaration order — the same order `Object.values`
 * enumerated, without the per-node array; `Object.hasOwn` drops inherited
 * helpers such as Babel's `__clone`.
 */
export function walk(node: Node, parent: Node | null, visit: (node: Node, parent: Node | null) => boolean | undefined): boolean {
	if (visit(node, parent) === true) return true;
	for (const key in node as Node & Record<string, unknown>) {
		if (!Object.hasOwn(node, key)) continue;
		const value = (node as Node & Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item) && walk(item, node, visit)) return true;
		} else if (isNode(value) && walk(value, node, visit)) return true;
	}
	return false;
}

/** A string the code spells out completely: a string literal or a template without `${}`. */
function literalString(node: Node | null | undefined): string | null {
	if (!node) return null;
	if (node.type === "StringLiteral") return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
	return null;
}

/** The static key of an object property, or null when the runtime key is not fixed by the source. */
function keyOf(property: ObjectProperty): string | null {
	const key = property.key;
	if (key.type === "Identifier") return property.computed ? null : key.name;
	if (key.type === "NumericLiteral") return String(key.value);
	return literalString(key);
}

/** An object literal's properties, or indeterminate when a spread, method, accessor, computed non-literal key or duplicate key makes the runtime value differ from the source. */
function propsOf(node: ObjectExpression): Read<ReadonlyMap<string, Node>> {
	const props = new Map<string, Node>();
	for (const property of node.properties) {
		if (property.type !== "ObjectProperty") return UNKNOWN;
		const name = keyOf(property);
		if (name === null || props.has(name)) return UNKNOWN;
		props.set(name, property.value);
	}
	return read(props);
}

/**
 * Whether child_process options may start a shell: a `shell` that is not literally `false`, `null` or `undefined`
 * (`shell: "/bin/sh"`, `shell: flag`), or options the code does not spell out (a variable); indeterminate when the
 * options object's shape is not fixed by the source.
 */
function mayUseShell(options: Node | undefined): Read<boolean> {
	if (options === undefined) return read(false);
	if (options.type !== "ObjectExpression") return read(true);
	const props = propsOf(options);
	if (props.kind === "indeterminate") return UNKNOWN;
	const shell = props.value.get("shell");
	if (shell === undefined) return read(false);
	if (shell.type === "BooleanLiteral") return read(shell.value);
	return read(shell.type !== "NullLiteral" && !(shell.type === "Identifier" && shell.name === "undefined"));
}

const wordOf = (node: Node | null | undefined): LaunchWord => {
	const text = literalString(node);
	return text === null ? { text: "", literal: false } : { text, literal: true };
};

/** The argv words: `head` then `array`'s elements; a spread element makes the list indeterminate. */
function argvOf(head: readonly (Node | null | undefined)[], array: ArrayExpression | null): Read<readonly LaunchWord[]> {
	const elements = array?.elements ?? [];
	if (elements.some((item) => item?.type === "SpreadElement")) return UNKNOWN;
	return read([...head, ...elements].map(wordOf));
}

/** The command of an `xd://bash` payload written as a JSON string or as `JSON.stringify({ command: … })`. */
function payloadCommand(content: Node | null | undefined): Read<string | null> {
	if (content?.type === "CallExpression" && isMember(content.callee, "JSON", "stringify")) {
		const [object] = content.arguments;
		if (object?.type !== "ObjectExpression") return read(null);
		const props = propsOf(object);
		return props.kind === "indeterminate" ? UNKNOWN : read(literalString(props.value.get("command")));
	}
	const text = literalString(content);
	return read(text === null ? null : bridgeCommand(text));
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
