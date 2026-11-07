/**
 * Python eval cells, read the way the eval kernel runs them: a tokenizer that
 * knows strings, f-strings, comments and the kernel's rewrites (`!cmd`,
 * `x = !cmd`, `%sx`, `%system`, `%%bash`, `%time`), the cell's import bindings,
 * and the process launch a call at a given token starts. Mechanics only: what
 * to do with an untokenizable cell, a non-literal command or an alias is the
 * caller's decision. Used by delete-guard (fail closed) and tool-policy-nag's
 * pty lane (fail open).
 */

/** One argv word; `literal` is false when its runtime text cannot be read from the source. */
export type LaunchWord = { readonly text: string; readonly literal: boolean };

/**
 * How a launch call was recognized: `direct` spells the API under its own name
 * (`subprocess.run`; `import os` then `os.system`; `from subprocess import run`
 * then `run`); `alias` reaches it through a binding of this cell that renames
 * it (`import subprocess as sp`, `from os import system as sh`); `distinctive`
 * matched a launch-only name without a binding (`Popen(…)` imported in an
 * earlier cell), or a callee given a `shell=` that may start a shell.
 */
export type LaunchVia = "direct" | "alias" | "distinctive";

/**
 * What a call at a given token does at run time, as far as the cell spells it
 * out. A `null` command, words or code means the value is not a literal the
 * source shows: a non-literal argument, or a `**` splat that may carry the
 * `shell=` or the command itself.
 *
 * - `bridge`: the `tool.bash` harness bridge, or `tool.write` to `xd://bash`;
 *   its command runs as a real `bash` tool call.
 * - `script`: text handed to the system shell (`os.system`, `shell=True`,
 *   `getoutput`).
 * - `argv`: an argument list run without a shell.
 * - `execEval`: builtin `exec` or `eval`; `code` is the Python the cell runs.
 * - `opaque`: `__import__` or `importlib.import_module` whose module name is not
 *   a literal, so the module, and any launch made through it, is unknown.
 */
export type PyLaunch =
	| { readonly kind: "bridge"; readonly command: string | null }
	| { readonly kind: "script"; readonly api: string; readonly via: LaunchVia; readonly text: string | null }
	| { readonly kind: "argv"; readonly api: string; readonly via: LaunchVia; readonly words: readonly LaunchWord[] | null }
	| { readonly kind: "execEval"; readonly api: string; readonly code: string | null }
	| { readonly kind: "opaque"; readonly api: string };

export type PyScan = {
	readonly tokens: readonly Token[];
	/** `!cmd`, `x = !cmd`, `%sx`/`%system` and `%%bash` bodies: shell text the kernel runs. */
	readonly shellScripts: readonly string[];
	/** f-string placeholder code, `%time`/`%timeit` arguments, `%%capture`/`%%timeit` bodies: Python the cell also runs. */
	readonly pythonSnippets: readonly string[];
	readonly bindings: Bindings;
};

type PyScanResult = { readonly kind: "scanned"; readonly scan: PyScan } | { readonly kind: "unlexable"; readonly reason: string };

/** Tokenizes a cell; an unterminated string or bracket cannot run and is `unlexable`. */
export function scanPy(code: string): PyScanResult {
	let lexed: Lexed;
	try {
		lexed = new Lexer(code).run();
	} catch (error) {
		if (error instanceof LexFailure) return { kind: "unlexable", reason: error.message };
		throw error;
	}
	return { kind: "scanned", scan: { ...lexed, bindings: collectBindings(lexed.tokens) } };
}

/** The launch the call at name token `k` starts, or null when `k` is not a call or the call starts no process. */
export function pyLaunchAt(scan: PyScan, k: number): PyLaunch | null {
	const { tokens, bindings } = scan;
	const nameToken = tokens[k];
	if (nameToken?.kind !== "name" || !isOp(tokens[k + 1], "(")) return null;
	const previous = tokens[k - 1];
	// `def exec(…)` and `class run(…)` declare a name; they call nothing.
	if (previous?.kind === "name" && (previous.value === "def" || previous.value === "class")) return null;
	const args = callArgs(tokens, k + 1);
	const callee = qualifiedCallee(tokens, k, bindings);
	const qualified = callee.names.join(".");
	const imported = importCall(qualified, args);
	if (imported?.kind === "opaque") return { kind: "opaque", api: qualified };
	if (imported !== null) return null;
	if (qualified === "tool.write") return toolWriteLaunch(args);
	const launch = launchOf(nameToken.value, qualified, callee.renamed, args);
	if (launch === null) return null;
	return args.keywordSplat ? withUnknownPayload(launch) : launch;
}

/** Position of `shell` among the positional arguments of the subprocess calls, which forward them to `Popen`. */
const SHELL_POSITION = 8;

/** `tool.bash` and `tool.write` bridges, builtin `exec`/`eval`, and process launches; null for any other call. */
function launchOf(name: string, qualified: string, renamed: boolean, args: CallArgs): PyLaunch | null {
	if (qualified === "tool.bash") {
		const device = args.positional[0];
		const command = device?.kind === "dict" ? device.entries.get("command") : args.keywords.get("command");
		return { kind: "bridge", command: literalSource(command) };
	}
	if (EXEC_EVAL.has(qualified)) return { kind: "execEval", api: qualified, code: literalSource(args.positional[0]) };
	// `shell=` that is not a literal `False`/`None` may start a shell (`shell=flag`), so the command is a script.
	const known: LaunchKind | null = SCRIPT_CALLS.has(qualified) ? "script" : ARGV_CALLS.has(qualified) ? "argv" : null;
	const kind = known ?? DISTINCTIVE_LAUNCH.get(name) ?? null;
	const shellArg = args.keywords.get("shell") ?? (kind === "argv" ? args.positional[SHELL_POSITION] : undefined);
	const shell = shellArg !== undefined && shellArg.kind !== "false";
	if (kind === null && !shell) return null;
	const via: LaunchVia = known === null ? "distinctive" : renamed ? "alias" : "direct";
	const first = args.positional[0] ?? args.keywords.get("args");
	if (kind === "script" || shell) return { kind: "script", api: qualified, via, text: scriptOf(first) };
	if (kind === "execArgs") {
		const words = args.positional.map((arg) =>
			arg.kind === "string" && arg.literal ? { text: arg.value, literal: true } : { text: "", literal: false },
		);
		return { kind: "argv", api: qualified, via, words };
	}
	return { kind: "argv", api: qualified, via, words: first === undefined ? null : argvWords(first) };
}

/**
 * `tool.write({'path': 'xd://bash', 'content': …})`: the device bridge, whose
 * command is the `command` of a literal JSON payload or of a `json.dumps({…})`
 * with a literal command. A `**` splat may carry the path, so it is a bridge
 * whose command is unknown. Any other path is not a bridge.
 */
function toolWriteLaunch(args: CallArgs): PyLaunch | null {
	if (args.keywordSplat) return { kind: "bridge", command: null };
	const device = args.positional[0];
	const fields = device?.kind === "dict" ? device.entries : new Map<string, Arg>();
	const path = fields.get("path");
	if (path?.kind !== "string" || !path.literal || path.value !== "xd://bash") return null;
	return { kind: "bridge", command: bridgeCommandOf(fields.get("content")) };
}

/** The command of an `xd://bash` payload: literal JSON text, or `json.dumps` of a dict with a literal `command`. */
function bridgeCommandOf(content: Arg | undefined): string | null {
	if (content?.kind === "string") return content.literal ? bridgeCommand(content.value) : null;
	if (content?.kind === "dumps") return content.payload.kind === "dict" ? literalSource(content.payload.entries.get("command")) : null;
	return null;
}

/** The `command` of a JSON payload with a string `command`, or null when the text is not one. */
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

/** The same launch with its payload unknown: a `**` splat may carry the `shell=` or the command itself. */
function withUnknownPayload(launch: PyLaunch): PyLaunch {
	switch (launch.kind) {
		case "bridge":
			return { kind: "bridge", command: null };
		case "script":
			return { ...launch, text: null };
		case "argv":
			return { ...launch, words: null };
		case "execEval":
			return { ...launch, code: null };
		case "opaque":
			return launch;
		default: {
			const unreachable: never = launch;
			return unreachable;
		}
	}
}

/** A module name a call loads: `__import__('a.b')` loads `a` unless a fromlist names the submodule. */
type ImportCall = { readonly kind: "module"; readonly name: string } | { readonly kind: "opaque" };

/**
 * `__import__(name, …)` and `importlib.import_module(name, …)`: the module a
 * literal name loads, or opaque when the name is not literal. Null for any other call.
 */
function importCall(callee: string, args: CallArgs): ImportCall | null {
	if (callee !== "__import__" && callee !== "importlib.import_module") return null;
	const name = args.positional[0] ?? args.keywords.get("name");
	if (name?.kind !== "string" || !name.literal) return { kind: "opaque" };
	if (callee === "importlib.import_module") return name.value.startsWith(".") ? { kind: "opaque" } : { kind: "module", name: name.value };
	const fromlist = args.positional[3] ?? args.keywords.get("fromlist");
	if (fromlist === undefined || fromlist.kind === "false" || (fromlist.kind === "seq" && fromlist.items.length === 0))
		return { kind: "module", name: name.value.split(".")[0] ?? name.value };
	if (fromlist.kind === "seq" && fromlist.items.every((item) => item.kind === "string" && item.literal))
		return { kind: "module", name: name.value };
	return { kind: "opaque" };
}

/** Shell handoffs whose first argument is a shell script. */
const SCRIPT_CALLS: ReadonlySet<string> = new Set([
	"os.system",
	"os.popen",
	"subprocess.getoutput",
	"subprocess.getstatusoutput",
	"asyncio.create_subprocess_shell",
]);

/** Process launches taking an argv list (a script when `shell` is anything but a literal false). */
const ARGV_CALLS: ReadonlySet<string> = new Set([
	"subprocess.run",
	"subprocess.call",
	"subprocess.check_call",
	"subprocess.check_output",
	"subprocess.Popen",
]);

/** Builtin code runners, whose first argument is Python the cell runs. */
const EXEC_EVAL: ReadonlySet<string> = new Set(["exec", "eval", "builtins.exec", "builtins.eval"]);

type LaunchKind = "script" | "argv" | "execArgs";

/** Launch names only subprocess/asyncio use, matched whatever the receiver. */
const DISTINCTIVE_LAUNCH: ReadonlyMap<string, LaunchKind> = new Map([
	["Popen", "argv"],
	["check_output", "argv"],
	["check_call", "argv"],
	["getoutput", "script"],
	["getstatusoutput", "script"],
	["create_subprocess_shell", "script"],
	["create_subprocess_exec", "execArgs"],
]);

type Token =
	| { readonly kind: "name"; readonly value: string; readonly start: number }
	| { readonly kind: "op"; readonly value: string; readonly start: number }
	| { readonly kind: "number"; readonly start: number }
	| { readonly kind: "string"; readonly value: string; readonly literal: boolean; readonly start: number };

/** What the kernel rewrites before Python sees it (`!cmd`, `%%bash`, `%time`, …), plus f-string placeholder code. */
type Lexed = {
	readonly tokens: readonly Token[];
	readonly shellScripts: readonly string[];
	readonly pythonSnippets: readonly string[];
};

class LexFailure extends Error {}

const ESCAPES: ReadonlyMap<string, string> = new Map([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
	["0", "\0"],
	["a", "\x07"],
	["b", "\b"],
	["f", "\f"],
	["v", "\v"],
]);

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const ASSIGN_MAGIC = /^[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*\s*=\s*([!%])(?![=%])/;

/** Line magics whose argument is Python; `%%capture`/`%%timeit` bodies are Python too. `%run`/`%load` run script files (K5). */
const PYTHON_LINE_MAGICS: ReadonlySet<string> = new Set(["time", "timeit"]);
/** Line magics whose argument the kernel runs as a shell command. */
const SHELL_LINE_MAGICS: ReadonlySet<string> = new Set(["sx", "system"]);
const PYTHON_CELL_MAGICS: ReadonlySet<string> = new Set(["capture", "timeit"]);

/** The contents of each top-level `{…}` in an f-string format spec: expressions Python evaluates. */
function bracedParts(spec: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let k = 0; k < spec.length; k++) {
		const ch = spec.charAt(k);
		if (ch === "{") {
			if (depth === 0) start = k + 1;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0) parts.push(spec.slice(start, k));
		}
	}
	return parts;
}

/** What the line at a logical line start was: the cell's end, a line the magics consumed (the cursor is on the next line), or ordinary code. */
type LineStart = "stop" | "consumed" | "plain";

class Lexer {
	private i = 0;
	private depth = 0;
	readonly tokens: Token[] = [];
	readonly shellScripts: string[] = [];
	readonly pythonSnippets: string[] = [];

	constructor(private readonly src: string) {}

	private fail(detail: string): never {
		throw new LexFailure(detail);
	}

	/** The rest of the line from `from`, joining `\`-continued lines; the cursor moves past it. */
	private takeLine(from: number): string {
		let text = "";
		let j = from;
		for (;;) {
			const end = this.src.indexOf("\n", j);
			const line = this.src.slice(j, end === -1 ? this.src.length : end);
			j = end === -1 ? this.src.length : end + 1;
			if (line.endsWith("\\") && end !== -1) {
				text += `${line.slice(0, -1)} `;
				continue;
			}
			text += line;
			break;
		}
		this.i = j;
		return text;
	}

	/** At the start of a logical line: kernel magics. */
	private lineStart(): LineStart {
		let j = this.i;
		while (this.src.charAt(j) === " " || this.src.charAt(j) === "\t") j++;
		const indented = j > this.i;
		const rest = this.src.slice(j);
		if (rest.startsWith("%%") && !indented) {
			const newline = this.src.indexOf("\n", j);
			const head = this.src.slice(j + 2, newline === -1 ? this.src.length : newline).trim();
			const body = newline === -1 ? "" : this.src.slice(newline + 1);
			const name = head.split(/\s+/)[0] ?? "";
			if (name === "bash") this.shellScripts.push(body);
			else if (PYTHON_CELL_MAGICS.has(name)) this.pythonSnippets.push(body);
			this.i = this.src.length;
			return "stop";
		}
		if (rest.startsWith("!")) {
			this.shellScripts.push(this.takeLine(j + 1).trim());
			return "consumed";
		}
		if (rest.startsWith("%")) {
			this.lineMagic(this.takeLine(j + 1));
			return "consumed";
		}
		const assign = ASSIGN_MAGIC.exec(rest);
		if (assign !== null) {
			const marker = assign[1];
			const payload = this.takeLine(j + assign[0].length);
			if (marker === "!") this.shellScripts.push(payload.trim());
			else this.lineMagic(payload);
			return "consumed";
		}
		return "plain";
	}

	private lineMagic(text: string): void {
		const match = /^\s*([A-Za-z_]\w*)\s*(.*)$/.exec(text);
		const name = match?.[1] ?? "";
		const argument = match?.[2] ?? "";
		if (PYTHON_LINE_MAGICS.has(name)) this.pythonSnippets.push(argument);
		else if (SHELL_LINE_MAGICS.has(name)) this.shellScripts.push(argument.trim());
	}

	private readString(start: number, prefix: string): void {
		const quote = this.src.charAt(this.i);
		const triple = this.src.startsWith(quote.repeat(3), this.i);
		const delimiter = triple ? quote.repeat(3) : quote;
		const raw = /r/i.test(prefix);
		const formatted = /f/i.test(prefix);
		this.i += delimiter.length;
		let value = "";
		let literal = true;
		while (this.i < this.src.length) {
			if (this.src.startsWith(delimiter, this.i)) {
				this.i += delimiter.length;
				this.tokens.push({ kind: "string", value, literal, start });
				return;
			}
			const ch = this.src.charAt(this.i);
			if (!triple && ch === "\n") this.fail("unterminated string");
			if (ch === "\\") {
				const next = this.src.charAt(this.i + 1);
				if (raw) value += `\\${next}`;
				else if (next === "x") {
					value += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 2, this.i + 4), 16));
					this.i += 2;
				} else if (next === "u") {
					value += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 2, this.i + 6), 16));
					this.i += 4;
				} else if (next !== "\n") value += ESCAPES.get(next) ?? next;
				this.i += 2;
				continue;
			}
			if (formatted && (ch === "{" || ch === "}")) {
				if (this.src.charAt(this.i + 1) === ch) {
					value += ch;
					this.i += 2;
					continue;
				}
				if (ch === "}") this.fail("single `}` in f-string");
				this.pythonSnippets.push(...this.readPlaceholder());
				literal = false;
				continue;
			}
			value += ch;
			this.i++;
		}
		this.fail("unterminated string");
	}

	/**
	 * An f-string placeholder `{…}` (cursor on `{`): its code, without a `!r` conversion or `:spec` at nesting zero,
	 * followed by the expressions nested in the spec (`{x:{width}}`), which Python evaluates too.
	 */
	private readPlaceholder(): readonly string[] {
		this.i++;
		const start = this.i;
		let codeEnd: number | null = null;
		let depth = 0;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			const next = this.src.charAt(this.i + 1);
			if (ch === "'" || ch === '"') {
				const end = this.src.indexOf(ch, this.i + 1);
				if (end === -1) this.fail("unterminated string in f-string placeholder");
				this.i = end + 1;
				continue;
			}
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]") depth--;
			else if (ch === "}") {
				if (depth === 0) {
					const code = this.src.slice(start, codeEnd ?? this.i);
					const spec = codeEnd === null ? "" : this.src.slice(codeEnd, this.i);
					this.i++;
					return [code, ...bracedParts(spec)];
				}
				depth--;
			} else if (depth === 0 && codeEnd === null && ((ch === "!" && next !== "=") || (ch === ":" && next !== "="))) codeEnd = this.i;
			this.i++;
		}
		this.fail("unterminated f-string placeholder");
	}

	run(): Lexed {
		let atLineStart = true;
		while (this.i < this.src.length) {
			if (atLineStart && this.depth === 0) {
				const at = this.lineStart();
				if (at === "stop") break;
				// A consumed magic line leaves the cursor at the next line start, which is again a line start.
				if (at === "consumed") continue;
			}
			atLineStart = false;
			if (this.i >= this.src.length) break;
			const ch = this.src.charAt(this.i);
			const start = this.i;
			if (ch === "\n") {
				this.i++;
				atLineStart = this.depth === 0;
				continue;
			}
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.i++;
				continue;
			}
			if (ch === "\\" && this.src.charAt(this.i + 1) === "\n") {
				this.i += 2;
				continue;
			}
			if (ch === "#") {
				while (this.i < this.src.length && this.src.charAt(this.i) !== "\n") this.i++;
				continue;
			}
			if (ch === "'" || ch === '"') {
				this.readString(start, "");
				continue;
			}
			if (NAME_START.test(ch)) {
				let j = this.i;
				while (j < this.src.length && NAME_CHAR.test(this.src.charAt(j))) j++;
				const word = this.src.slice(this.i, j);
				const next = this.src.charAt(j);
				if (/^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/.test(word) && (next === "'" || next === '"')) {
					this.i = j;
					this.readString(start, word);
					continue;
				}
				this.tokens.push({ kind: "name", value: word, start });
				this.i = j;
				continue;
			}
			if (/[0-9]/.test(ch)) {
				while (this.i < this.src.length && /[0-9A-Za-z_.]/.test(this.src.charAt(this.i))) this.i++;
				this.tokens.push({ kind: "number", start });
				continue;
			}
			if ("([{".includes(ch)) this.depth++;
			else if (")]}".includes(ch)) this.depth = Math.max(0, this.depth - 1);
			const two = this.src.slice(this.i, this.i + 2);
			const op = two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "**" || two === ":=" || two === "->" ? two : ch;
			this.tokens.push({ kind: "op", value: op, start });
			this.i += op.length;
		}
		if (this.depth > 0) this.fail("unclosed bracket");
		return { tokens: this.tokens, shellScripts: this.shellScripts, pythonSnippets: this.pythonSnippets };
	}
}

/** A call argument, reduced to what launch recognition needs. */
type Arg =
	| { readonly kind: "string"; readonly value: string; readonly literal: boolean }
	| { readonly kind: "seq"; readonly items: readonly Arg[] }
	| { readonly kind: "dict"; readonly entries: ReadonlyMap<string, Arg> }
	/** `json.dumps(payload)`: the payload is what gets serialized. */
	| { readonly kind: "dumps"; readonly payload: Arg }
	| { readonly kind: "true" }
	/** `False` or `None`: a `shell=` that certainly does not start a shell. */
	| { readonly kind: "false" }
	| { readonly kind: "expr" };

type CallArgs = {
	readonly positional: readonly Arg[];
	readonly keywords: ReadonlyMap<string, Arg>;
	/** A `**` expansion among the arguments: keywords it carries are unknown. */
	readonly keywordSplat: boolean;
	readonly end: number;
};

export const isOp = (token: Token | undefined, value: string): boolean => token?.kind === "op" && token.value === value;

/** Splits `tokens[from, to)` at top-level commas. */
function splitTopLevel(tokens: readonly Token[], from: number, to: number): Token[][] {
	const parts: Token[][] = [];
	let current: Token[] = [];
	let depth = 0;
	for (let k = from; k < to; k++) {
		const token = tokens[k];
		if (token === undefined) break;
		if (token.kind === "op" && "([{".includes(token.value)) depth++;
		if (token.kind === "op" && ")]}".includes(token.value)) depth--;
		if (depth === 0 && isOp(token, ",")) {
			parts.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

/** Index of the bracket closing the one at `open`. */
function closing(tokens: readonly Token[], open: number): number {
	let depth = 0;
	for (let k = open; k < tokens.length; k++) {
		const token = tokens[k];
		if (token?.kind === "op" && "([{".includes(token.value)) depth++;
		if (token?.kind === "op" && ")]}".includes(token.value)) {
			depth--;
			if (depth === 0) return k;
		}
	}
	return tokens.length;
}

/** Index of the bracket opening the one at `close`, or null when it has no opener. */
function openingOf(tokens: readonly Token[], close: number): number | null {
	let depth = 0;
	for (let k = close; k >= 0; k--) {
		const token = tokens[k];
		if (token?.kind === "op" && ")]}".includes(token.value)) depth++;
		if (token?.kind === "op" && "([{".includes(token.value)) {
			depth--;
			if (depth === 0) return k;
		}
	}
	return null;
}

function argOf(tokens: readonly Token[]): Arg {
	const [first] = tokens;
	if (first === undefined) return { kind: "expr" };
	if (tokens.every((token) => token.kind === "string")) {
		const strings = tokens.filter((token): token is Extract<Token, { kind: "string" }> => token.kind === "string");
		return { kind: "string", value: strings.map((token) => token.value).join(""), literal: strings.every((token) => token.literal) };
	}
	if (tokens.length === 1 && first.kind === "name" && first.value === "True") return { kind: "true" };
	if (tokens.length === 1 && first.kind === "name" && (first.value === "False" || first.value === "None")) return { kind: "false" };
	const last = tokens[tokens.length - 1];
	if (
		first.kind === "op" &&
		(first.value === "[" || first.value === "(") &&
		closing(tokens, 0) === tokens.length - 1 &&
		last !== undefined
	) {
		return { kind: "seq", items: splitTopLevel(tokens, 1, tokens.length - 1).map(argOf) };
	}
	if (isOp(first, "{") && closing(tokens, 0) === tokens.length - 1) {
		const entries = new Map<string, Arg>();
		for (const part of splitTopLevel(tokens, 1, tokens.length - 1)) {
			const colon = part.findIndex((token) => isOp(token, ":"));
			const key = part[0];
			if (colon === 1 && key?.kind === "string" && key.literal) entries.set(key.value, argOf(part.slice(2)));
		}
		return { kind: "dict", entries };
	}
	if (
		first.kind === "name" &&
		first.value === "json" &&
		isOp(tokens[1], ".") &&
		nameAt(tokens, 2) === "dumps" &&
		isOp(tokens[3], "(") &&
		closing(tokens, 3) === tokens.length - 1
	) {
		const [payload] = splitTopLevel(tokens, 4, tokens.length - 1);
		return { kind: "dumps", payload: argOf(payload ?? []) };
	}
	return { kind: "expr" };
}

function callArgs(tokens: readonly Token[], open: number): CallArgs {
	const end = closing(tokens, open);
	const positional: Arg[] = [];
	const keywords = new Map<string, Arg>();
	let keywordSplat = false;
	for (const part of splitTopLevel(tokens, open + 1, end)) {
		const [first, second] = part;
		if (isOp(first, "**")) keywordSplat = true;
		else if (first?.kind === "name" && isOp(second, "=")) keywords.set(first.value, argOf(part.slice(2)));
		else positional.push(argOf(part));
	}
	return { positional, keywords, keywordSplat, end };
}

type Bindings = { readonly modules: ReadonlyMap<string, string>; readonly members: ReadonlyMap<string, string> };

/** The name at `tokens[k]`, or null when that token is not a name. */
function nameAt(tokens: readonly Token[], k: number): string | null {
	const token = tokens[k];
	return token?.kind === "name" ? token.value : null;
}

/** A dotted module name starting at `k` (`os.path`), and the index after it. */
function dottedName(tokens: readonly Token[], k: number): { readonly name: string; readonly next: number } {
	const parts: string[] = [];
	let j = k;
	for (;;) {
		const part = nameAt(tokens, j);
		if (part === null) break;
		parts.push(part);
		j++;
		if (!isOp(tokens[j], ".")) break;
		j++;
	}
	return { name: parts.join("."), next: j };
}

/**
 * `import a.b as c`, `from m import x as y`, and `name = __import__('m')` /
 * `name = importlib.import_module('m')`: local name → module, or → `module.name`.
 */
function collectBindings(tokens: readonly Token[]): Bindings {
	const modules = new Map<string, string>();
	const members = new Map<string, string>();
	for (let k = 0; k < tokens.length; k++) {
		const keyword = nameAt(tokens, k);
		if (keyword === "import") {
			let j = k + 1;
			for (;;) {
				const module = dottedName(tokens, j);
				j = module.next;
				const head = module.name.split(".")[0] ?? module.name;
				if (nameAt(tokens, j) === "as") {
					modules.set(nameAt(tokens, j + 1) ?? head, module.name);
					j += 2;
				} else modules.set(head, head);
				if (!isOp(tokens[j], ",")) break;
				j++;
			}
			k = j - 1;
		} else if (keyword === "from") {
			const module = dottedName(tokens, k + 1);
			let j = module.next;
			if (nameAt(tokens, j) !== "import") continue;
			j++;
			if (isOp(tokens[j], "(")) j++;
			for (let imported = nameAt(tokens, j); imported !== null; imported = nameAt(tokens, j)) {
				j++;
				let local = imported;
				if (nameAt(tokens, j) === "as") {
					local = nameAt(tokens, j + 1) ?? imported;
					j += 2;
				}
				members.set(local, `${module.name}.${imported}`);
				if (!isOp(tokens[j], ",")) break;
				j++;
			}
			k = j - 1;
		}
	}
	// Runs after the imports, so a loader named through an import of this cell (`importlib.import_module`) resolves.
	for (let k = 0; k < tokens.length; k++) {
		const name = nameAt(tokens, k);
		if (name === null || !isOp(tokens[k + 1], "=") || isOp(tokens[k - 1], ".")) continue;
		const callee = dottedName(tokens, k + 2);
		if (!isOp(tokens[callee.next], "(")) continue;
		const loaded = importCall(
			qualifiedCallee(tokens, callee.next - 1, { modules, members }).names.join("."),
			callArgs(tokens, callee.next),
		);
		if (loaded?.kind === "module") modules.set(name, loaded.name);
	}
	return { modules, members };
}

/**
 * The dotted callee ending at the name `tokens[k]`, resolved through this cell's
 * imports (`sp.run` → `subprocess.run`); `renamed` when a binding gives it
 * another local name. A receiver that is a literal-name module load
 * (`__import__('subprocess').run`) resolves to that module.
 */
function qualifiedCallee(
	tokens: readonly Token[],
	k: number,
	bindings: Bindings,
): { readonly names: readonly string[]; readonly renamed: boolean } {
	const names: string[] = [];
	let receiver: readonly string[] | null = null;
	for (let j = k; ; j -= 2) {
		const name = nameAt(tokens, j);
		if (name === null) break;
		names.unshift(name);
		if (!isOp(tokens[j - 1], ".")) break;
		if (isOp(tokens[j - 2], ")")) {
			receiver = importedReceiver(tokens, j - 2, bindings);
			break;
		}
	}
	if (receiver !== null) return { names: [...receiver, ...names], renamed: false };
	const [head = "", ...rest] = names;
	const member = bindings.members.get(head);
	const module = bindings.modules.get(head);
	const resolved = member ?? module ?? head;
	const renamed = member !== undefined ? !member.endsWith(`.${head}`) : module !== undefined && module !== head;
	return { names: [...resolved.split("."), ...rest], renamed };
}

/** The module the call whose closing bracket is at `close` loads, when it is a literal-name `__import__`/`import_module`. */
function importedReceiver(tokens: readonly Token[], close: number, bindings: Bindings): readonly string[] | null {
	const open = openingOf(tokens, close);
	if (open === null || nameAt(tokens, open - 1) === null) return null;
	const loaded = importCall(qualifiedCallee(tokens, open - 1, bindings).names.join("."), callArgs(tokens, open));
	return loaded?.kind === "module" ? loaded.name.split(".") : null;
}

const argvWords = (arg: Arg): LaunchWord[] | null => {
	switch (arg.kind) {
		case "string":
			return [{ text: arg.value, literal: arg.literal }];
		case "seq":
			return arg.items.map((item) =>
				item.kind === "string" && item.literal ? { text: item.value, literal: true } : { text: "", literal: false },
			);
		case "dict":
		case "dumps":
		case "true":
		case "false":
		case "expr":
			return null;
		default: {
			const unreachable: never = arg;
			return unreachable;
		}
	}
};

function scriptOf(arg: Arg | undefined): string | null {
	if (arg?.kind === "string") return arg.literal ? arg.value : null;
	if (arg?.kind === "seq") {
		const [first] = arg.items;
		return first?.kind === "string" && first.literal ? first.value : null;
	}
	return null;
}

/** The text of a literal string argument, or null. */
function literalSource(arg: Arg | undefined): string | null {
	return arg?.kind === "string" && arg.literal ? arg.value : null;
}
