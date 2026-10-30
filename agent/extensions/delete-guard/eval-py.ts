import { type ArgvWord, classify } from "./classify.ts";
import { ALLOW, type Dialect, type Rule, type Verdict } from "./verdict.ts";

/** API names only filesystem deletion uses: blocked wherever code names them, so aliases from earlier cells are caught too. */
const DISTINCTIVE_DELETE: Readonly<Record<string, true>> = { rmtree: true, removedirs: true, unlink: true, rmdir: true };

/** Shell handoffs whose first argument is a shell script. */
const SCRIPT_CALLS: Readonly<Record<string, true>> = {
	"os.system": true,
	"os.popen": true,
	"subprocess.getoutput": true,
	"subprocess.getstatusoutput": true,
	"asyncio.create_subprocess_shell": true,
};

/** Process launches taking an argv list (a script with `shell=True`). */
const ARGV_CALLS: Readonly<Record<string, true>> = {
	"subprocess.run": true,
	"subprocess.call": true,
	"subprocess.check_call": true,
	"subprocess.check_output": true,
	"subprocess.Popen": true,
};

/** Launch names only subprocess/asyncio use, matched whatever the receiver. */
const DISTINCTIVE_LAUNCH: Readonly<Record<string, "script" | "argv" | "execArgs">> = {
	Popen: "argv",
	check_output: "argv",
	check_call: "argv",
	getoutput: "script",
	getstatusoutput: "script",
	create_subprocess_shell: "script",
	create_subprocess_exec: "execArgs",
};

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

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v" };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const ASSIGN_MAGIC = /^[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*\s*=\s*([!%])(?![=%])/;

/** Line magics whose argument is Python; `%%capture`/`%%timeit` bodies are Python too. `%run`/`%load` run script files (K5). */
const PYTHON_LINE_MAGICS: Readonly<Record<string, true>> = { time: true, timeit: true };
const PYTHON_CELL_MAGICS: Readonly<Record<string, true>> = { capture: true, timeit: true };

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

	/** At the start of a logical line: kernel magics. Returns true when the rest of the cell was consumed. */
	private lineStart(): boolean {
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
			else if (PYTHON_CELL_MAGICS[name]) this.pythonSnippets.push(body);
			this.i = this.src.length;
			return true;
		}
		if (rest.startsWith("!")) {
			this.shellScripts.push(this.takeLine(j + 1).trim());
			return false;
		}
		if (rest.startsWith("%")) {
			this.lineMagic(this.takeLine(j + 1));
			return false;
		}
		const assign = ASSIGN_MAGIC.exec(rest);
		if (assign !== null) {
			const marker = assign[1];
			const payload = this.takeLine(j + assign[0].length);
			if (marker === "!") this.shellScripts.push(payload.trim());
			else this.lineMagic(payload);
		}
		return false;
	}

	private lineMagic(text: string): void {
		const match = /^\s*([A-Za-z_]\w*)\s*(.*)$/.exec(text);
		const name = match?.[1] ?? "";
		if (PYTHON_LINE_MAGICS[name]) this.pythonSnippets.push(match?.[2] ?? "");
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
				} else if (next !== "\n") value += ESCAPES[next] ?? next;
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
				this.pythonSnippets.push(this.readPlaceholder());
				literal = false;
				continue;
			}
			value += ch;
			this.i++;
		}
		this.fail("unterminated string");
	}

	/** An f-string placeholder `{…}` (cursor on `{`): its code, without a `!r` conversion or `:spec` at nesting zero. */
	private readPlaceholder(): string {
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
					this.i++;
					return code;
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
			if (atLineStart && this.depth === 0 && this.lineStart()) break;
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

/** A call argument, reduced to what the guard needs. */
type Arg =
	| { readonly kind: "string"; readonly value: string; readonly literal: boolean }
	| { readonly kind: "seq"; readonly items: readonly Arg[] }
	| { readonly kind: "dict"; readonly entries: ReadonlyMap<string, Arg> }
	| { readonly kind: "true" }
	| { readonly kind: "expr" };

type CallArgs = { readonly positional: readonly Arg[]; readonly keywords: ReadonlyMap<string, Arg>; readonly end: number };

const isOp = (token: Token | undefined, value: string): boolean => token?.kind === "op" && token.value === value;

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

function argOf(tokens: readonly Token[]): Arg {
	const [first] = tokens;
	if (first === undefined) return { kind: "expr" };
	if (tokens.every((token) => token.kind === "string")) {
		const strings = tokens.filter((token): token is Extract<Token, { kind: "string" }> => token.kind === "string");
		return { kind: "string", value: strings.map((token) => token.value).join(""), literal: strings.every((token) => token.literal) };
	}
	if (tokens.length === 1 && first.kind === "name" && first.value === "True") return { kind: "true" };
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
	return { kind: "expr" };
}

function callArgs(tokens: readonly Token[], open: number): CallArgs {
	const end = closing(tokens, open);
	const positional: Arg[] = [];
	const keywords = new Map<string, Arg>();
	for (const part of splitTopLevel(tokens, open + 1, end)) {
		const [first, second] = part;
		if (first?.kind === "name" && isOp(second, "=")) keywords.set(first.value, argOf(part.slice(2)));
		else positional.push(argOf(part));
	}
	return { positional, keywords, end };
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

/** `import a.b as c`, `from m import x as y`: local name → module, or → `module.name`. */
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
	return { modules, members };
}

type Context = {
	readonly code: string;
	readonly tokens: readonly Token[];
	readonly bindings: Bindings;
	readonly shell: Dialect;
	readonly brush: Dialect;
};

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

/** The source line holding offset `at`, for the reason. */
function lineAt(code: string, at: number): string {
	const start = code.lastIndexOf("\n", at - 1) + 1;
	const end = code.indexOf("\n", at);
	return code.slice(start, end === -1 ? code.length : end).trim();
}

/** The dotted callee ending at the name `tokens[k]`, resolved through this cell's imports (`sp.run` → `subprocess.run`). */
function qualifiedCallee(tokens: readonly Token[], k: number, bindings: Bindings): readonly string[] {
	const names: string[] = [];
	for (let j = k; ; j -= 2) {
		const name = nameAt(tokens, j);
		if (name === null) break;
		names.unshift(name);
		if (!isOp(tokens[j - 1], ".")) break;
	}
	const [head = "", ...rest] = names;
	const resolved = bindings.members.get(head) ?? bindings.modules.get(head) ?? head;
	return [...resolved.split("."), ...rest];
}

const argvWords = (arg: Arg): ArgvWord[] | null => {
	switch (arg.kind) {
		case "string":
			return [{ text: arg.value, literal: arg.literal }];
		case "seq":
			return arg.items.map((item) =>
				item.kind === "string" && item.literal ? { text: item.value, literal: true } : { text: "", literal: false },
			);
		case "dict":
		case "true":
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

function judgeCall(ctx: Context, k: number): Verdict {
	const { tokens, bindings } = ctx;
	const nameToken = tokens[k];
	if (nameToken?.kind !== "name") return ALLOW;
	const fragment = lineAt(ctx.code, nameToken.start);
	const args = callArgs(tokens, k + 1);
	const qualified = qualifiedCallee(tokens, k, bindings).join(".");
	const last = nameToken.value;
	const nonLiteral = (what: string): Verdict => block("nonLiteral", fragment, `${what} is not a literal string`);
	if (qualified === "tool.bash") {
		const command = args.positional[0]?.kind === "dict" ? args.positional[0].entries.get("command") : args.keywords.get("command");
		return command?.kind === "string" && command.literal
			? classify(ctx.brush, { kind: "script", text: command.value }, 1)
			: nonLiteral("the bash bridge command");
	}
	const shellTrue = args.keywords.get("shell")?.kind === "true";
	const kind = SCRIPT_CALLS[qualified] ? "script" : ARGV_CALLS[qualified] ? "argv" : (DISTINCTIVE_LAUNCH[last] ?? null);
	if (kind === null && !shellTrue) return ALLOW;
	const first = args.positional[0] ?? args.keywords.get("args");
	if (kind === "script" || shellTrue) {
		const script = scriptOf(first);
		return script === null ? nonLiteral("the command handed to a shell") : classify(ctx.shell, { kind: "script", text: script }, 1);
	}
	if (kind === "execArgs") {
		const words = args.positional.map((arg) =>
			arg.kind === "string" && arg.literal ? { text: arg.value, literal: true } : { text: "", literal: false },
		);
		return classify(ctx.brush, { kind: "argv", words }, 1);
	}
	const words = first === undefined ? null : argvWords(first);
	return words === null ? nonLiteral("the command") : classify(ctx.brush, { kind: "argv", words }, 1);
}

function judgeTokens(ctx: Context): Verdict {
	const { tokens, bindings } = ctx;
	for (let k = 0; k < tokens.length; k++) {
		const token = tokens[k];
		if (token?.kind !== "name") continue;
		const previous = tokens[k - 1];
		const next = tokens[k + 1];
		const declares = previous?.kind === "name" && (previous.value === "def" || previous.value === "class");
		const assignedTo = isOp(next, "=");
		if (DISTINCTIVE_DELETE[token.value] && !declares && !assignedTo)
			return block("delete", lineAt(ctx.code, token.start), `\`${token.value}\` deletes files`);
		if (token.value === "remove" && !declares) {
			const receiver = isOp(previous, ".") ? tokens[k - 2] : undefined;
			const fromOs =
				(receiver?.kind === "name" && (receiver.value === "os" || bindings.modules.get(receiver.value) === "os")) ||
				(!isOp(previous, ".") && bindings.members.get("remove") === "os.remove");
			if (fromOs) return block("delete", lineAt(ctx.code, token.start), "`os.remove` deletes files");
		}
		if (isOp(next, "(")) {
			const verdict = judgeCall(ctx, k);
			if (verdict.kind === "block") return verdict;
		}
	}
	return ALLOW;
}

/**
 * Classifies a py eval cell: filesystem deletion APIs block, and every command
 * handed to a shell or launched is classified — `subprocess`/`os`/`asyncio`
 * launches, `!cmd` and `%%bash` (rewritten by the kernel into shell calls), and
 * the `tool.bash` bridge. `%time`/`%timeit` arguments, `%%capture`/`%%timeit`
 * bodies and f-string placeholders are classified as Python. Text that cannot
 * be tokenized (unterminated string or bracket) is blocked: it cannot run.
 */
export function classifyPy(code: string, shell: Dialect, brush: Dialect, depth = 0): Verdict {
	let lexed: Lexed;
	try {
		lexed = new Lexer(code).run();
	} catch (error) {
		if (error instanceof LexFailure) return block("nonLiteral", code, `the cell cannot be tokenized (${error.message})`);
		throw error;
	}
	for (const script of lexed.shellScripts) {
		const verdict = classify(shell, { kind: "script", text: script }, 1);
		if (verdict.kind === "block") return verdict;
	}
	const verdict = judgeTokens({ code, tokens: lexed.tokens, bindings: collectBindings(lexed.tokens), shell, brush });
	if (verdict.kind === "block") return verdict;
	if (depth >= 8)
		return lexed.pythonSnippets.length > 0
			? block("nonLiteral", code, "Python code nested more than 8 levels deep is not classified")
			: ALLOW;
	for (const snippet of lexed.pythonSnippets) {
		const nested = classifyPy(snippet, shell, brush, depth + 1);
		if (nested.kind === "block") return nested;
	}
	return ALLOW;
}
