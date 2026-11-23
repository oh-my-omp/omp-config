import { absurd } from "./verdict.ts";

export type Word = { readonly text: string; readonly raw: string; readonly literal: boolean };

export const STDIN_SCRIPT = /^\/dev\/(?:stdin|fd\/\d+)$|^\/proc\/self\/fd\/\d+$/;

export function stdinLabel(stdin: StdinSource | null): string {
	if (stdin === null) return "no script given";
	switch (stdin.kind) {
		case "pipe":
			return "a pipe";
		case "file":
			return "a file";
		case "other":
			return "a descriptor other than a file";
		case "herestring":
			return "a here-string";
		case "heredoc":
			return stdin.quoted ? "a quoted here-document" : "an unquoted here-document";
		default:
			return absurd(stdin);
	}
}

export type HeredocBody = {
	readonly src: string;
	readonly start: number;
	readonly end: number;
	readonly stripTabs: boolean;
};

const LEADING_TABS = /^\t+/gm;

export function heredocText(body: HeredocBody): string {
	if (body.start === body.end) return "";
	const text = body.src.slice(body.start, body.end);
	const complete = text.endsWith("\n") ? text : `${text}\n`;
	return body.stripTabs ? complete.replace(LEADING_TABS, "") : complete;
}

export type StdinSource =
	| { readonly kind: "pipe" }
	| { readonly kind: "file" }
	| { readonly kind: "other" }
	| { readonly kind: "herestring" }
	| { readonly kind: "heredoc"; readonly quoted: boolean; readonly body: HeredocBody };

export type SimpleCommand = {
	readonly words: readonly Word[];
	readonly stdin: StdinSource | null;
	readonly src: string;
	readonly start: number;
	readonly end: number;
};

export type Script = { readonly commands: readonly SimpleCommand[]; readonly nested: readonly Script[] };

type ParseResult = { readonly kind: "parsed"; readonly script: Script } | { readonly kind: "invalid"; readonly detail: string };

class ParseFailure extends Error {}

type Builder = { readonly commands: SimpleCommand[]; readonly nested: Script[] };

type HeredocSlot = { readonly kind: "heredoc"; readonly quoted: boolean; body: HeredocBody };

const NO_BODY: HeredocBody = { src: "", start: 0, end: 0, stripTabs: false };

type CommandBuilder = { readonly start: number; readonly words: Word[]; stdin: StdinSource | null };

type PendingDoc = { readonly slot: HeredocSlot; readonly delimiter: string; readonly stripTabs: boolean; readonly owner: Builder };

type Case = "pattern" | "body";

type ScriptState = {
	readonly closer: ")" | "}" | null;
	readonly builder: Builder;
	command: CommandBuilder | null;
	braces: number;
	piped: boolean;
	groups: number;
	readonly cases: Case[];
};

const isBlank = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\r";

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
const REDIRECT = /(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/y;
const SPECIAL_PARAMETER = /[0-9@*#?$!-]/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const GLOB = /[*?]|\[[^\]\0]+\]/;
const BRACE = /\{[^{}\0]*(,|\.\.)[^{}\0]*\}/;
const RESERVED_OPENERS: ReadonlySet<string> = new Set(["!", "if", "then", "elif", "else", "while", "until", "do", "{", "time"]);

const isReservedOpener = (word: Word): boolean => word.literal && RESERVED_OPENERS.has(word.text);

class Parser {
	i = 0;
	private readonly pending: PendingDoc[] = [];

	constructor(private readonly src: string) {}

	private fail(detail: string): never {
		throw new ParseFailure(detail);
	}

	private skipBlanks(): void {
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (isBlank(ch)) this.i++;
			else if (ch === "\\" && this.src.charAt(this.i + 1) === "\n") this.i += 2;
			else return;
		}
	}

	parseScript(closer: ")" | "}" | null): Script {
		const state: ScriptState = {
			closer,
			builder: { commands: [], nested: [] },
			command: null,
			braces: 0,
			piped: false,
			groups: 0,
			cases: [],
		};
		for (;;) {
			this.skipBlanks();
			if (this.i >= this.src.length) return this.endOfInput(state);
			const ch = this.src.charAt(this.i);
			if (ch === "#") {
				while (this.i < this.src.length && this.src.charAt(this.i) !== "\n") this.i++;
			} else if (state.cases.at(-1) === "pattern") {
				this.casePatternStep(state, ch);
			} else if (this.step(state, ch)) {
				return state.builder;
			}
		}
	}

	private finishCommand(state: ScriptState): void {
		const command = state.command;
		if (command !== null && command.words.length > 0) {
			state.builder.commands.push({ words: command.words, stdin: command.stdin, src: this.src, start: command.start, end: this.i });
		}
		state.command = null;
	}

	private openCommand(state: ScriptState): CommandBuilder {
		if (state.command === null) {
			state.command = { start: this.i, words: [], stdin: state.piped ? { kind: "pipe" } : null };
			state.piped = false;
		}
		return state.command;
	}

	private endOfInput(state: ScriptState): Script {
		if (state.closer === ")") this.fail("unterminated `$(` or `<(`");
		if (state.closer === "}") this.fail(`unterminated \`\${ …; }\``);
		if (state.groups > 0) this.fail("unterminated `(` group");
		this.finishCommand(state);
		this.readPendingDocs();
		return state.builder;
	}

	private casePatternStep(state: ScriptState, ch: string): void {
		if (ch === "\n") {
			this.i++;
			this.readPendingDocs();
		} else if (this.readCasePattern(state.builder)) {
			state.cases.pop();
		} else {
			state.cases[state.cases.length - 1] = "body";
		}
	}

	private step(state: ScriptState, ch: string): boolean {
		if (ch === "\n") {
			this.finishCommand(state);
			this.i++;
			state.piped = false;
			this.readPendingDocs();
			return false;
		}
		if (ch === ")") return this.closeParen(state);
		if (ch === "(") {
			this.openParen(state);
			return false;
		}
		if (ch === ";") {
			this.semicolon(state);
			return false;
		}
		if (ch === "|" || (ch === "&" && !this.src.startsWith("&>", this.i))) {
			this.finishCommand(state);
			const doubled = this.src.startsWith(ch + ch, this.i);
			state.piped = ch === "|" && !doubled;
			this.i += doubled || this.src.startsWith("|&", this.i) ? 2 : 1;
			return false;
		}
		if (state.closer === "}" && ch === "}" && state.command === null) {
			if (state.braces === 0) {
				this.i++;
				return true;
			}
			state.braces--;
		}
		if (!this.readRedirect(state.builder, () => this.openCommand(state))) this.readCommandWord(state);
		return false;
	}

	private closeParen(state: ScriptState): boolean {
		this.finishCommand(state);
		this.i++;
		if (state.groups > 0) {
			state.groups--;
			return false;
		}
		if (state.closer === ")") return true;
		this.fail("unexpected `)`");
	}

	private openParen(state: ScriptState): void {
		const before = state.command;
		if (before !== null && !before.words.every(isReservedOpener)) {
			if (before.words[0]?.text === "for" && this.src.charAt(this.i + 1) === "(") {
				this.skipArithmetic(state.builder, 2);
				return;
			}
			if (!this.isFunctionHeader(before)) this.fail("unexpected `(`");
			this.i++;
			this.skipBlanks();
			if (this.src.charAt(this.i) !== ")") this.fail("unexpected `(`");
			this.i++;
			state.command = null;
			return;
		}
		if (this.src.charAt(this.i + 1) === "(") {
			const arithmetic = this.openCommand(state);
			const start = this.i;
			this.skipArithmetic(state.builder, 2);
			arithmetic.words.push({ text: "((", raw: this.src.slice(start, this.i), literal: true });
			return;
		}
		this.i++;
		state.groups++;
	}

	private semicolon(state: ScriptState): void {
		const terminator = [";;&", ";;", ";&"].find((op) => this.src.startsWith(op, this.i));
		this.finishCommand(state);
		state.piped = false;
		if (terminator === undefined) {
			this.i++;
			return;
		}
		this.i += terminator.length;
		if (state.cases.at(-1) !== "body") this.fail(`unexpected \`${terminator}\``);
		state.cases[state.cases.length - 1] = "pattern";
	}

	private readCommandWord(state: ScriptState): void {
		const target = this.openCommand(state);
		const word = this.readWord(state.builder);
		target.words.push(word);
		if (word.literal && word.text === "{" && target.words.every(isReservedOpener)) state.braces++;
		if (target.words.length === 1 && word.literal && word.text === "[[") {
			this.skipDoubleBracket(state.builder);
			return;
		}
		const [first, second, third] = target.words;
		if (target.words.length === 3 && first?.text === "case" && third?.literal && third.text === "in" && second !== undefined) {
			state.command = null;
			state.cases.push("pattern");
			return;
		}
		if (target.words.length === 1 && word.literal && word.text === "esac" && state.cases.at(-1) === "body") {
			state.cases.pop();
			state.command = null;
		}
	}

	private isFunctionHeader(command: CommandBuilder): boolean {
		return command.words.length === 1 || (command.words.length === 2 && command.words[0]?.text === "function");
	}

	private readCasePattern(builder: Builder): boolean {
		if (this.src.charAt(this.i) === "(") this.i++;
		for (;;) {
			this.skipBlanks();
			const word = this.readWord(builder);
			if (word.raw.length === 0) this.fail("malformed case pattern");
			if (word.literal && word.text === "esac") return true;
			this.skipBlanks();
			const ch = this.src.charAt(this.i);
			this.i++;
			if (ch === ")") return false;
			if (ch !== "|") this.fail("malformed case pattern");
		}
	}

	private readRedirect(builder: Builder, open: () => CommandBuilder): boolean {
		const ch = this.src.charAt(this.i);
		if ((ch === "<" || ch === ">") && this.src.charAt(this.i + 1) === "(") return false;
		let fd: number;
		let op: string;
		if (this.src.startsWith("&>", this.i)) {
			op = this.src.startsWith("&>>", this.i) ? "&>>" : "&>";
			fd = 1;
		} else {
			if (ch !== "<" && ch !== ">" && (ch < "0" || ch > "9")) return false;
			REDIRECT.lastIndex = this.i;
			const match = REDIRECT.exec(this.src);
			if (match === null) return false;
			const [, digits = "", operator = ""] = match;
			op = operator;
			fd = digits.length > 0 ? Number(digits) : op.startsWith("<") ? 0 : 1;
			this.i += digits.length;
		}
		const command = open();
		this.i += op.length;
		this.skipBlanks();
		const target = this.readWord(builder);
		if (target.raw.length === 0) this.fail(`missing target after \`${op}\``);
		if (op === "<<" || op === "<<-") {
			const slot: HeredocSlot = { kind: "heredoc", quoted: /['"\\]/.test(target.raw), body: NO_BODY };
			this.pending.push({ slot, delimiter: target.text, stripTabs: op === "<<-", owner: builder });
			if (fd === 0) command.stdin = slot;
			return true;
		}
		if (fd !== 0) return true;
		switch (op) {
			case "<":
			case "<>":
				command.stdin = target.literal && STDIN_SCRIPT.test(target.text) ? { kind: "other" } : { kind: "file" };
				break;
			case "<<<":
				command.stdin = { kind: "herestring" };
				break;
			default:
				command.stdin = { kind: "other" };
		}
		return true;
	}

	private readPendingDocs(): void {
		for (const doc of this.pending.splice(0)) {
			const start = this.i;
			let expansions = false;
			let delimiterAt = -1;
			for (;;) {
				if (this.i >= this.src.length) break;
				const end = this.lineEnd(this.i);
				if (this.isDelimiter(this.i, end, doc.delimiter, doc.stripTabs)) {
					delimiterAt = this.i;
					this.i = end < this.src.length ? end + 1 : end;
					break;
				}
				if (!expansions) expansions = this.hasExpansion(this.i, end);
				this.i = end < this.src.length ? end + 1 : end;
			}
			const body: HeredocBody = { src: this.src, start, end: delimiterAt === -1 ? this.src.length : delimiterAt, stripTabs: doc.stripTabs };
			doc.slot.body = body;
			if (!doc.slot.quoted && expansions) doc.owner.nested.push(...expansionScripts(heredocText(body)));
		}
	}

	private lineEnd(at: number): number {
		const end = this.src.indexOf("\n", at);
		return end === -1 ? this.src.length : end;
	}

	private isDelimiter(start: number, end: number, delimiter: string, stripTabs: boolean): boolean {
		if (stripTabs) while (start < end && this.src.charCodeAt(start) === 9) start++;
		return end - start === delimiter.length && this.src.startsWith(delimiter, start);
	}

	private hasExpansion(start: number, end: number): boolean {
		for (let at = start; at < end; at++) {
			const ch = this.src.charCodeAt(at);
			if (ch === 36 || ch === 96) return true;
		}
		return false;
	}

	readWord(builder: Builder): Word {
		const start = this.i;
		let text = "";
		let literal = true;
		let bare = "";
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (isBlank(ch) || ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === ")") break;
			if (ch === "(") {
				if (!ASSIGNMENT_PREFIX.test(text)) break;
				this.skipData(builder, ")");
				literal = false;
				continue;
			}
			if (ch === "<" || ch === ">") {
				if (this.src.charAt(this.i + 1) !== "(") break;
				this.i += 2;
				builder.nested.push(this.parseScript(")"));
				literal = false;
				bare += "\0";
				continue;
			}
			if (ch === "\\") {
				if (this.src.charAt(this.i + 1) === "\n") {
					this.i += 2;
					continue;
				}
				text += this.src.charAt(this.i + 1);
				bare += "\0";
				this.i += 2;
				continue;
			}
			if (ch === "'") {
				const end = this.src.indexOf("'", this.i + 1);
				if (end === -1) this.fail("unterminated `'`");
				text += this.src.slice(this.i + 1, end);
				bare += "\0";
				this.i = end + 1;
				continue;
			}
			if (ch === '"') {
				const quoted = this.readDoubleQuoted(builder);
				text += quoted.text;
				literal &&= quoted.literal;
				bare += "\0";
				continue;
			}
			if (ch === "$" || ch === "`") {
				const expansion = ch === "$" ? this.readDollar(builder) : this.readBacktick(builder);
				text += expansion.text;
				literal &&= expansion.literal;
				bare += expansion.literal ? expansion.text : "\0";
				continue;
			}
			text += ch;
			bare += ch;
			this.i++;
		}
		if (GLOB.test(bare) || BRACE.test(bare)) literal = false;
		return { text, raw: this.src.slice(start, this.i), literal };
	}

	private readDoubleQuoted(builder: Builder): { readonly text: string; readonly literal: boolean } {
		this.i++;
		let text = "";
		let literal = true;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === '"') {
				this.i++;
				return { text, literal };
			}
			if (ch === "\\" && '$`"\\\n'.includes(this.src.charAt(this.i + 1))) {
				if (this.src.charAt(this.i + 1) !== "\n") text += this.src.charAt(this.i + 1);
				this.i += 2;
				continue;
			}
			if (ch === "$" || ch === "`") {
				const expansion = ch === "$" ? this.readDollar(builder, true) : this.readBacktick(builder);
				text += expansion.text;
				literal &&= expansion.literal;
				continue;
			}
			text += ch;
			this.i++;
		}
		this.fail('unterminated `"`');
	}

	private readDollar(builder: Builder, inQuotes = false): { readonly text: string; readonly literal: boolean } {
		const start = this.i;
		const next = this.src.charAt(this.i + 1);
		if (next === "(") {
			if (this.src.charAt(this.i + 2) === "(") {
				this.i++;
				this.skipArithmetic(builder, 2);
			} else {
				this.i += 2;
				builder.nested.push(this.parseScript(")"));
			}
		} else if (next === "{") {
			const after = this.src.charAt(this.i + 2);
			if (after === "|" || after === "\n" || isBlank(after)) {
				this.i += after === "|" ? 3 : 2;
				builder.nested.push(this.parseScript("}"));
			} else {
				this.i += 2;
				this.skipData(builder, "}", inQuotes);
			}
		} else if (inQuotes && (next === "'" || next === '"')) {
			this.i++;
			return { text: "$", literal: true };
		} else if (next === "'") {
			this.i += 2;
			while (this.i < this.src.length && this.src.charAt(this.i) !== "'") this.i += this.src.charAt(this.i) === "\\" ? 2 : 1;
			if (this.i >= this.src.length) this.fail("unterminated `$'`");
			this.i++;
		} else if (next === '"') {
			this.i++;
			this.readDoubleQuoted(builder);
		} else if (NAME_START.test(next)) {
			this.i += 2;
			while (NAME_CHAR.test(this.src.charAt(this.i))) this.i++;
		} else if (next !== "" && SPECIAL_PARAMETER.test(next)) {
			this.i += 2;
		} else {
			this.i++;
			return { text: "$", literal: true };
		}
		return { text: this.src.slice(start, this.i), literal: false };
	}

	private readBacktick(builder: Builder): { readonly text: string; readonly literal: boolean } {
		const start = this.i;
		this.i++;
		let body = "";
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === "`") {
				this.i++;
				builder.nested.push(parseNested(body));
				return { text: this.src.slice(start, this.i), literal: false };
			}
			if (ch === "\\" && "`\\$".includes(this.src.charAt(this.i + 1))) {
				body += this.src.charAt(this.i + 1);
				this.i += 2;
				continue;
			}
			body += ch;
			this.i++;
		}
		this.fail("unterminated backtick");
	}

	private skipArithmetic(builder: Builder, opening: number): void {
		this.i += opening;
		let depth = 0;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === ")" && depth === 0) {
				if (this.src.charAt(this.i + 1) !== ")") this.fail("malformed `((…))`");
				this.i += 2;
				return;
			}
			if (ch === "(") depth++;
			else if (ch === ")") depth--;
			if (ch === "$" || ch === "`") {
				if (ch === "$") this.readDollar(builder);
				else this.readBacktick(builder);
				continue;
			}
			if (ch === "'" || ch === '"') {
				this.readWord(builder);
				continue;
			}
			this.i++;
		}
		this.fail("unterminated `((`");
	}

	private skipData(builder: Builder, closer: ")" | "}", inQuotes = false): void {
		const opener = closer === ")" ? "(" : "{";
		if (this.src.charAt(this.i) === opener) this.i++;
		let depth = 0;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === closer && depth === 0) {
				this.i++;
				return;
			}
			if (ch === "\\") {
				this.i += 2;
				continue;
			}
			if (ch === "'" && !inQuotes) {
				const end = this.src.indexOf("'", this.i + 1);
				if (end === -1) this.fail("unterminated `'`");
				this.i = end + 1;
				continue;
			}
			if (ch === '"') {
				this.readDoubleQuoted(builder);
				continue;
			}
			if (ch === "$" || ch === "`") {
				if (ch === "$") this.readDollar(builder, inQuotes);
				else this.readBacktick(builder);
				continue;
			}
			if (ch === opener) depth++;
			else if (ch === closer) depth--;
			this.i++;
		}
		this.fail(`unterminated \`${opener}\``);
	}

	private skipDoubleBracket(builder: Builder): void {
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (isBlank(ch) || ch === "\n") {
				this.i++;
				continue;
			}
			if (this.src.startsWith("]]", this.i)) {
				this.i += 2;
				return;
			}
			if (ch === "\\") {
				this.i += 2;
				continue;
			}
			if (ch === "'" || ch === '"' || ch === "$" || ch === "`") {
				if (ch === "'") {
					const end = this.src.indexOf("'", this.i + 1);
					if (end === -1) this.fail("unterminated `'`");
					this.i = end + 1;
				} else if (ch === '"') this.readDoubleQuoted(builder);
				else if (ch === "$") this.readDollar(builder);
				else this.readBacktick(builder);
				continue;
			}
			this.i++;
		}
		this.fail("unterminated `[[`");
	}

	scanExpansions(): Script[] {
		const builder: Builder = { commands: [], nested: [] };
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === "\\") this.i += 2;
			else if (ch === "$") this.readDollar(builder);
			else if (ch === "`") this.readBacktick(builder);
			else this.i++;
		}
		return builder.nested;
	}
}

function parseNested(text: string): Script {
	return new Parser(text).parseScript(null);
}

function expansionScripts(body: string): Script[] {
	return new Parser(body).scanExpansions();
}

export function parsePosix(text: string): ParseResult {
	try {
		return { kind: "parsed", script: parseNested(text) };
	} catch (error) {
		if (error instanceof ParseFailure) return { kind: "invalid", detail: error.message };
		throw error;
	}
}
