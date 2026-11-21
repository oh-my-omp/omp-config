export type LaunchWord = { readonly text: string; readonly literal: boolean };

export type LaunchVia = "direct" | "alias" | "distinctive";

export type PyLaunch =
	| { readonly kind: "bridge"; readonly command: string | null }
	| { readonly kind: "script"; readonly api: string; readonly via: LaunchVia; readonly text: string | null }
	| { readonly kind: "shellHelper"; readonly api: string; readonly via: LaunchVia; readonly text: string | null }
	| { readonly kind: "argv"; readonly api: string; readonly via: LaunchVia; readonly words: readonly LaunchWord[] | null }
	| { readonly kind: "execEval"; readonly api: string; readonly code: string | null }
	| { readonly kind: "opaque"; readonly api: string };

export type PyScan = {
	readonly tokens: readonly Token[];
	readonly shellScripts: readonly string[];
	readonly pythonSnippets: readonly string[];
	readonly bindings: Bindings;
};

type PyScanResult = { readonly kind: "scanned"; readonly scan: PyScan } | { readonly kind: "unlexable"; readonly reason: string };

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

export function pyLaunchAt(scan: PyScan, k: number): PyLaunch | null {
	const { tokens, bindings } = scan;
	const nameToken = tokens[k];
	if (nameToken?.kind !== "name" || !isOp(tokens[k + 1], "(")) return null;
	const previous = tokens[k - 1];
	if (previous?.kind === "name" && (previous.value === "def" || previous.value === "class")) return null;
	const callee = qualifiedCallee(tokens, k, bindings);
	const qualified = callee.names.join(".");
	const known: LaunchKind | null = SCRIPT_CALLS.has(qualified) ? "script" : ARGV_CALLS.has(qualified) ? "argv" : null;
	const kind = known ?? DISTINCTIVE_LAUNCH.get(nameToken.value) ?? null;
	const needsArgs =
		qualified === "tool.bash" ||
		qualified === "sh" ||
		EXEC_EVAL.has(qualified) ||
		qualified === "__import__" ||
		qualified === "importlib.import_module" ||
		kind !== null ||
		keywordArg(tokens, k + 1, "shell") !== null;
	if (!needsArgs) return null;
	const args = callArgs(tokens, k + 1);
	const imported = importCall(qualified, args);
	if (imported?.kind === "opaque") return { kind: "opaque", api: qualified };
	if (imported !== null) return null;
	const launch = launchOf(nameToken.value, qualified, callee.renamed, args);
	if (launch === null) return null;
	return args.keywordSplat ? withUnknownPayload(launch) : launch;
}

const SHELL_POSITION = 8;

function launchOf(name: string, qualified: string, renamed: boolean, args: CallArgs): PyLaunch | null {
	if (qualified === "tool.bash") {
		const device = args.positional[0];
		const command = device?.kind === "dict" ? device.entries.get("command") : args.keywords.get("command");
		return { kind: "bridge", command: literalSource(command) };
	}
	if (EXEC_EVAL.has(qualified)) return { kind: "execEval", api: qualified, code: literalSource(args.positional[0]) };
	if (qualified === "sh")
		return {
			kind: "shellHelper",
			api: qualified,
			via: renamed ? "alias" : "direct",
			text: literalSource(args.positional[0] ?? args.keywords.get("command")),
		};
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

function withUnknownPayload(launch: PyLaunch): PyLaunch {
	switch (launch.kind) {
		case "bridge":
			return { kind: "bridge", command: null };
		case "script":
		case "shellHelper":
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

type ImportCall = { readonly kind: "module"; readonly name: string } | { readonly kind: "opaque" };

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

const SCRIPT_CALLS: ReadonlySet<string> = new Set([
	"os.system",
	"os.popen",
	"subprocess.getoutput",
	"subprocess.getstatusoutput",
	"asyncio.create_subprocess_shell",
]);

const ARGV_CALLS: ReadonlySet<string> = new Set([
	"subprocess.run",
	"subprocess.call",
	"subprocess.check_call",
	"subprocess.check_output",
	"subprocess.Popen",
]);

const EXEC_EVAL: ReadonlySet<string> = new Set(["exec", "eval", "builtins.exec", "builtins.eval"]);

type LaunchKind = "script" | "argv" | "execArgs";

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

const PYTHON_LINE_MAGICS: ReadonlySet<string> = new Set(["time", "timeit"]);
const SHELL_LINE_MAGICS: ReadonlySet<string> = new Set(["sx", "system"]);
const PYTHON_CELL_MAGICS: ReadonlySet<string> = new Set(["capture", "timeit"]);

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
		let last = this.i;
		let value = "";
		let literal = true;
		while (this.i < this.src.length) {
			if (this.src.startsWith(delimiter, this.i)) {
				if (last < this.i) value += this.src.slice(last, this.i);
				this.i += delimiter.length;
				this.tokens.push({ kind: "string", value, literal, start });
				return;
			}
			const ch = this.src.charAt(this.i);
			if (!triple && ch === "\n") this.fail("unterminated string");
			if (ch === "\\") {
				const next = this.src.charAt(this.i + 1);
				if (raw) {
					this.i += 2;
					continue;
				}
				if (last < this.i) value += this.src.slice(last, this.i);
				if (next === "x") {
					value += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 2, this.i + 4), 16));
					this.i += 4;
				} else if (next === "u") {
					value += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 2, this.i + 6), 16));
					this.i += 6;
				} else {
					if (next !== "\n") value += ESCAPES.get(next) ?? next;
					this.i += 2;
				}
				last = this.i;
				continue;
			}
			if (formatted && (ch === "{" || ch === "}")) {
				if (this.src.charAt(this.i + 1) === ch) {
					if (last < this.i) value += this.src.slice(last, this.i);
					value += ch;
					this.i += 2;
					last = this.i;
					continue;
				}
				if (ch === "}") this.fail("single `}` in f-string");
				if (last < this.i) value += this.src.slice(last, this.i);
				this.pythonSnippets.push(...this.readPlaceholder());
				literal = false;
				last = this.i;
				continue;
			}
			this.i++;
		}
		this.fail("unterminated string");
	}

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

type Arg =
	| { readonly kind: "string"; readonly value: string; readonly literal: boolean }
	| { readonly kind: "seq"; readonly items: readonly Arg[] }
	| { readonly kind: "dict"; readonly entries: ReadonlyMap<string, Arg> }
	| { readonly kind: "true" }
	| { readonly kind: "false" }
	| { readonly kind: "expr" };

type CallArgs = {
	readonly positional: readonly Arg[];
	readonly keywords: ReadonlyMap<string, Arg>;
	readonly keywordSplat: boolean;
};

export const isOp = (token: Token | undefined, value: string): boolean => token?.kind === "op" && token.value === value;

type Part = readonly [start: number, end: number];

function partRanges(tokens: readonly Token[], from: number, to: number): Part[] {
	const parts: Part[] = [];
	let start = from;
	let depth = 0;
	for (let k = from; k < to; k++) {
		const token = tokens[k];
		if (token === undefined) break;
		if (token.kind === "op" && "([{".includes(token.value)) depth++;
		if (token.kind === "op" && ")]}".includes(token.value)) depth--;
		if (depth === 0 && isOp(token, ",")) {
			parts.push([start, k]);
			start = k + 1;
		}
	}
	if (start < to) parts.push([start, to]);
	return parts;
}

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

function keywordArg(tokens: readonly Token[], open: number, name: string): Part | null {
	let depth = 0;
	let start = open + 1;
	let k = open + 1;
	for (; k < tokens.length; k++) {
		const token = tokens[k];
		if (token === undefined) break;
		if (token.kind === "op" && ")]}".includes(token.value)) {
			if (depth === 0) break;
			depth--;
		} else if (token.kind === "op" && "([{".includes(token.value)) depth++;
		if (depth === 0 && isOp(token, ",")) {
			const first = tokens[start];
			if (first?.kind === "name" && first.value === name && isOp(tokens[start + 1], "=")) return [start + 2, k];
			start = k + 1;
		}
	}
	const first = tokens[start];
	return first?.kind === "name" && first.value === name && isOp(tokens[start + 1], "=") ? [start + 2, k] : null;
}

function argOf(tokens: readonly Token[], from: number, to: number): Arg {
	if (from >= to) return { kind: "expr" };
	const first = tokens[from];
	if (first === undefined) return { kind: "expr" };
	let strings = first.kind === "string";
	let joined = "";
	let literal = true;
	if (strings) {
		for (let k = from; k < to; k++) {
			const token = tokens[k];
			if (token?.kind !== "string") {
				strings = false;
				break;
			}
			joined += token.value;
			literal = literal && token.literal;
		}
	}
	if (strings) return { kind: "string", value: joined, literal };
	if (to - from === 1 && first.kind === "name" && first.value === "True") return { kind: "true" };
	if (to - from === 1 && first.kind === "name" && (first.value === "False" || first.value === "None")) return { kind: "false" };
	if (first.kind === "op" && (first.value === "[" || first.value === "(") && closing(tokens, from) === to - 1) {
		return { kind: "seq", items: partRanges(tokens, from + 1, to - 1).map(([start, end]) => argOf(tokens, start, end)) };
	}
	if (isOp(first, "{") && closing(tokens, from) === to - 1) {
		const entries = new Map<string, Arg>();
		for (const [start, end] of partRanges(tokens, from + 1, to - 1)) {
			const key = tokens[start];
			if (isOp(tokens[start + 1], ":") && key?.kind === "string" && key.literal) entries.set(key.value, argOf(tokens, start + 2, end));
		}
		return { kind: "dict", entries };
	}
	return { kind: "expr" };
}

function callArgs(tokens: readonly Token[], open: number): CallArgs {
	const positional: Arg[] = [];
	const keywords = new Map<string, Arg>();
	let keywordSplat = false;
	let depth = 0;
	let start = open + 1;
	let k = open + 1;
	const part = (end: number): void => {
		const first = tokens[start];
		if (isOp(first, "**")) keywordSplat = true;
		else if (first?.kind === "name" && isOp(tokens[start + 1], "=")) keywords.set(first.value, argOf(tokens, start + 2, end));
		else positional.push(argOf(tokens, start, end));
	};
	for (; k < tokens.length; k++) {
		const token = tokens[k];
		if (token === undefined) break;
		if (token.kind === "op" && ")]}".includes(token.value)) {
			if (depth === 0) break;
			depth--;
		} else if (token.kind === "op" && "([{".includes(token.value)) depth++;
		if (depth === 0 && isOp(token, ",")) {
			part(k);
			start = k + 1;
		}
	}
	if (start < k) part(k);
	return { positional, keywords, keywordSplat };
}

type Bindings = { readonly modules: ReadonlyMap<string, string>; readonly members: ReadonlyMap<string, string> };

function nameAt(tokens: readonly Token[], k: number): string | null {
	const token = tokens[k];
	return token?.kind === "name" ? token.value : null;
}

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
	for (let k = 0; k < tokens.length; k++) {
		const name = nameAt(tokens, k);
		if (name === null || !isOp(tokens[k + 1], "=") || isOp(tokens[k - 1], ".")) continue;
		const callee = dottedName(tokens, k + 2);
		if (callee.name === "sh" && !isOp(tokens[callee.next], "(") && !isOp(tokens[callee.next], ".")) members.set(name, "sh");
		if (!isOp(tokens[callee.next], "(")) continue;
		const loaded = importCall(
			qualifiedCallee(tokens, callee.next - 1, { modules, members }).names.join("."),
			callArgs(tokens, callee.next),
		);
		if (loaded?.kind === "module") modules.set(name, loaded.name);
	}
	return { modules, members };
}

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

function literalSource(arg: Arg | undefined): string | null {
	return arg?.kind === "string" && arg.literal ? arg.value : null;
}
