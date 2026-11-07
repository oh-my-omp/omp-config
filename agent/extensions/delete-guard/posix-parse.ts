/**
 * Fail-closed shell parser for delete-guard (POSIX plus the Bash syntax the
 * bash tool's pi-shell engine runs): splits command text into simple commands
 * with quote-removed words, the effective stdin source and every nested script
 * (`$(…)`, backticks, `<(…)`/`>(…)`, Bash 5.3 `${ …; }` / `${| …; }`,
 * substitutions inside unquoted here-document bodies, `${…}` and `$((…))`).
 * Malformed or unterminated text is `invalid`, never a best guess.
 */

/** `literal`: no expansion, substitution, glob or brace pattern, so the runtime text is `text`. */
export type Word = { readonly text: string; readonly raw: string; readonly literal: boolean };

/** Paths that name the process's own standard input, not a file: reading them reads the stdin source. */
export const STDIN_SCRIPT = /^\/dev\/(?:stdin|fd\/\d+)$|^\/proc\/self\/fd\/\d+$/;

/** Names a command's stdin source in block reasons; `null` means no source was given. */
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
		default: {
			const unreachable: never = stdin;
			return unreachable;
		}
	}
}

/** One here-document body as a source range: its text is copied only when a consumer reads it. */
export type HeredocBody = {
	readonly src: string;
	readonly start: number;
	readonly end: number;
	/** `<<-`: every body line's leading tabs were stripped. */
	readonly stripTabs: boolean;
};

/** Leading tabs of each line, which `<<-` removes before the body runs. */
const LEADING_TABS = /^\t+/gm;

/** The text of a here-document body: its lines, `<<-` tabs stripped, ending with a newline. */
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

/**
 * `stdin` is the last effective fd-0 source in source order (a pipe first, then each redirect). `src`/`start`/`end`
 * is the command's own text, copied only when a block reason quotes it.
 */
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

/** The body of a here-document queued on the current line; `readPendingDocs` replaces it with the source range. */
const NO_BODY: HeredocBody = { src: "", start: 0, end: 0, stripTabs: false };

type CommandBuilder = { readonly start: number; readonly words: Word[]; stdin: StdinSource | null };

type PendingDoc = { readonly slot: HeredocSlot; readonly delimiter: string; readonly stripTabs: boolean; readonly owner: Builder };

type Case = "pattern" | "body";

const isBlank = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\r";

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
/** Sticky: matched at the cursor, so no copy of the remaining text is needed. */
const REDIRECT = /(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/y;
const SPECIAL_PARAMETER = /[0-9@*#?$!-]/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const GLOB = /[*?]|\[[^\]\0]+\]/;
const BRACE = /\{[^{}\0]*(,|\.\.)[^{}\0]*\}/;
/** Reserved words after which `(` still opens a subshell or `((` an arithmetic command. A Set: a `then` key reads as a thenable to Biome. */
const RESERVED_OPENERS: ReadonlySet<string> = new Set(["!", "if", "then", "elif", "else", "while", "until", "do", "{", "time"]);

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

	/**
	 * Parses commands up to the end of text, up to the `)` closing a `$(` / `<(` (`closer` `)`), or up to the `}`
	 * reserved word closing a Bash 5.3 `${ …; }` / `${| …; }` command substitution (`closer` `}`).
	 */
	parseScript(closer: ")" | "}" | null): Script {
		const builder: Builder = { commands: [], nested: [] };
		let command: CommandBuilder | null = null;
		/** `{` groups opened inside a `${ …; }` body: their `}` closes the group, not the substitution. */
		let braces = 0;
		let piped = false;
		let groups = 0;
		const cases: Case[] = [];
		const finishCommand = (): void => {
			if (command !== null && command.words.length > 0) {
				builder.commands.push({
					words: command.words,
					stdin: command.stdin,
					src: this.src,
					start: command.start,
					end: this.i,
				});
			}
			command = null;
		};
		const open = (): CommandBuilder => {
			if (command === null) {
				command = { start: this.i, words: [], stdin: piped ? { kind: "pipe" } : null };
				piped = false;
			}
			return command;
		};
		/** Reads `command` with its declared type: the closures above reassign it, which flow narrowing does not see. */
		const current = (): CommandBuilder | null => command;
		for (;;) {
			this.skipBlanks();
			if (this.i >= this.src.length) {
				if (closer === ")") this.fail("unterminated `$(` or `<(`");
				if (closer === "}") this.fail(`unterminated \`\${ …; }\``);
				if (groups > 0) this.fail("unterminated `(` group");
				finishCommand();
				this.readPendingDocs();
				return builder;
			}
			const ch = this.src.charAt(this.i);
			if (ch === "#") {
				while (this.i < this.src.length && this.src.charAt(this.i) !== "\n") this.i++;
				continue;
			}
			if (cases.at(-1) === "pattern") {
				if (ch === "\n") {
					this.i++;
					this.readPendingDocs();
					continue;
				}
				if (this.readCasePattern(builder)) cases.pop();
				else cases[cases.length - 1] = "body";
				continue;
			}
			if (ch === "\n") {
				finishCommand();
				this.i++;
				piped = false;
				this.readPendingDocs();
				continue;
			}
			if (ch === ")") {
				finishCommand();
				this.i++;
				if (groups > 0) {
					groups--;
					continue;
				}
				if (closer === ")") return builder;
				this.fail("unexpected `)`");
			}
			if (ch === "(") {
				const before = current();
				if (before !== null && !before.words.every((word) => word.literal && RESERVED_OPENERS.has(word.text))) {
					if (before.words[0]?.text === "for" && this.src.charAt(this.i + 1) === "(") {
						this.skipArithmetic(builder, 2);
						continue;
					}
					if (this.isFunctionHeader(before)) {
						this.i++;
						this.skipBlanks();
						if (this.src.charAt(this.i) !== ")") this.fail("unexpected `(`");
						this.i++;
						command = null;
						continue;
					}
					this.fail("unexpected `(`");
				}
				if (this.src.charAt(this.i + 1) === "(") {
					const arithmetic = open();
					const start = this.i;
					this.skipArithmetic(builder, 2);
					arithmetic.words.push({ text: "((", raw: this.src.slice(start, this.i), literal: true });
					continue;
				}
				this.i++;
				groups++;
				continue;
			}
			if (ch === ";") {
				const terminator = [";;&", ";;", ";&"].find((op) => this.src.startsWith(op, this.i));
				finishCommand();
				piped = false;
				if (terminator !== undefined) {
					this.i += terminator.length;
					if (cases.at(-1) !== "body") this.fail(`unexpected \`${terminator}\``);
					cases[cases.length - 1] = "pattern";
					continue;
				}
				this.i++;
				continue;
			}
			if (ch === "|") {
				finishCommand();
				if (this.src.startsWith("||", this.i)) {
					this.i += 2;
					piped = false;
				} else {
					this.i += this.src.startsWith("|&", this.i) ? 2 : 1;
					piped = true;
				}
				continue;
			}
			if (ch === "&" && !this.src.startsWith("&>", this.i)) {
				finishCommand();
				this.i += this.src.startsWith("&&", this.i) ? 2 : 1;
				piped = false;
				continue;
			}
			if (closer === "}" && ch === "}" && current() === null) {
				if (braces === 0) {
					this.i++;
					return builder;
				}
				braces--;
			}
			if (this.readRedirect(builder, open)) continue;
			const target = open();
			const word = this.readWord(builder);
			target.words.push(word);
			if (word.literal && word.text === "{" && target.words.every((w) => w.literal && RESERVED_OPENERS.has(w.text))) braces++;
			if (target.words.length === 1 && word.literal && word.text === "[[") {
				this.skipDoubleBracket(builder);
				continue;
			}
			const [first, second, third] = target.words;
			if (target.words.length === 3 && first?.text === "case" && third?.literal && third.text === "in" && second !== undefined) {
				command = null;
				cases.push("pattern");
				continue;
			}
			if (target.words.length === 1 && word.literal && word.text === "esac" && cases.at(-1) === "body") {
				cases.pop();
				command = null;
			}
		}
	}

	private isFunctionHeader(command: CommandBuilder): boolean {
		return command.words.length === 1 || (command.words.length === 2 && command.words[0]?.text === "function");
	}

	/** Reads one case pattern list up to `)`; returns true when it met `esac` instead. */
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

	/** Handles a redirection at the cursor; returns false when the cursor holds a word. */
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
			// Every here-document body is consumed (an unquoted one has substitutions that run), whatever its
			// descriptor; only fd 0's is the command's stdin.
			const slot: HeredocSlot = { kind: "heredoc", quoted: /['"\\]/.test(target.raw), body: NO_BODY };
			this.pending.push({ slot, delimiter: target.text, stripTabs: op === "<<-", owner: builder });
			if (fd === 0) command.stdin = slot;
			return true;
		}
		if (fd !== 0) return true;
		switch (op) {
			case "<":
			case "<>":
				// A redirect from a stdin alias reads the pipe or the caller's stdin, not a file the call names.
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

	/** Reads here-document bodies queued on the line just ended. */
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
			// An unquoted body's substitutions run; a quoted one's do not, so its text is read only when a consumer judges it.
			if (!doc.slot.quoted && expansions) doc.owner.nested.push(...expansionScripts(heredocText(body)));
		}
	}

	/** The index of the `\n` ending the line that starts at `at`, or the text length. */
	private lineEnd(at: number): number {
		const end = this.src.indexOf("\n", at);
		return end === -1 ? this.src.length : end;
	}

	/** True when the line `[start, end)` is `delimiter` after any leading tabs `<<-` ignores. */
	private isDelimiter(start: number, end: number, delimiter: string, stripTabs: boolean): boolean {
		if (stripTabs) while (start < end && this.src.charCodeAt(start) === 9) start++;
		return end - start === delimiter.length && this.src.startsWith(delimiter, start);
	}

	/** True when the line `[start, end)` holds a `$` or a backtick, so its text may run a substitution. */
	private hasExpansion(start: number, end: number): boolean {
		for (let at = start; at < end; at++) {
			const ch = this.src.charCodeAt(at);
			if (ch === 36 || ch === 96) return true;
		}
		return false;
	}

	/** One shell word, quotes removed; nested scripts it contains go to `builder.nested`. */
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

	/**
	 * `$…` at the cursor. A lone `$` is the literal character. Inside double quotes (`inQuotes`) `$'` and `$"` are a
	 * literal `$`, and single quotes in a `${…}` body are ordinary characters, so substitutions in them still run.
	 * `${` followed by a blank, a newline or `|` is a Bash 5.3 command substitution run in the current shell: its
	 * body is a script, inside double quotes too.
	 */
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

	/** A backtick substitution: its body (with `\``, `\\`, `\$` unescaped) is parsed as its own script. */
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

	/** Skips `((…))` / `$((…))` (cursor after any `$`), parsing substitutions inside. */
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

	/**
	 * Skips data up to the matching `closer` (`${…}` bodies, `a=(…)` arrays), parsing substitutions inside. Inside
	 * double quotes (`inQuotes`) a `'` is an ordinary character, not a quote.
	 */
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

	/** Skips a `[[ … ]]` expression (cursor after `[[`): its words are data, not commands. */
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

	/** Parses only the expansions of here-document text: every `$(…)`, backtick, `${…}` and `$((…))`. */
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
