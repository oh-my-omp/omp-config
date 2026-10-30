import type { ArgvWord } from "./classify.ts";
import { classifyShellInvocation, programName, shellKind } from "./nested.ts";
import { ALLOW, MAX_DEPTH, type Rule, type Verdict } from "./verdict.ts";

/** `Remove-Item` and its built-in aliases. A Set: a plain object would also match `constructor`. */
const DELETE_COMMANDS: ReadonlySet<string> = new Set(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"]);

/**
 * Keywords that open control structures: their conditions (`(…)`) and script blocks (`{…}`) are judged as nested
 * code, and a statement starting with one ends at its block's `}`.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
	"if",
	"elseif",
	"else",
	"foreach",
	"for",
	"while",
	"do",
	"until",
	"switch",
	"try",
	"catch",
	"finally",
	"trap",
	"function",
	"filter",
	"param",
	"begin",
	"process",
	"end",
	"break",
	"continue",
	"class",
	"enum",
	"using",
]);

/** Keywords followed by a pipeline that runs (`return Remove-Item x`). */
const PIPELINE_KEYWORDS: ReadonlySet<string> = new Set(["return", "throw", "exit"]);

/** `[System.IO.File]::Delete(…)`, `[IO.Directory]::Delete(…)` and any `.Delete(` method call, outside strings. */
const DELETE_METHOD = /(?:\]\s*::\s*|\.)delete\s*\(/i;

type PsWord = ArgvWord & { readonly raw: string };

type PsStatement = { readonly words: readonly PsWord[]; readonly raw: string; readonly code: string };

/** Statements of one block plus every nested block or subexpression found inside it. */
type PsScript = { readonly statements: readonly PsStatement[]; readonly nested: readonly string[] };

class PsParseFailure extends Error {}

class PsParser {
	private i = 0;
	private readonly statements: PsStatement[] = [];
	private readonly nested: string[] = [];

	constructor(private readonly src: string) {}

	private fail(detail: string): never {
		throw new PsParseFailure(detail);
	}

	/** Skips to the bracket closing the one at the cursor, honoring strings and nesting; returns the inner text. */
	private balanced(open: string, close: string): string {
		const start = this.i + 1;
		let depth = 0;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === "'" || ch === '"') {
				this.skipString(ch);
				continue;
			}
			if (ch === "`") {
				this.i += 2;
				continue;
			}
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth === 0) {
					const inner = this.src.slice(start, this.i);
					this.i++;
					return inner;
				}
			}
			this.i++;
		}
		this.fail(`unterminated \`${open}\``);
	}

	/** Skips a quoted string (cursor on the quote); `$(…)` inside double quotes is recorded as nested code. Returns whether it expands. */
	private skipString(quote: string): boolean {
		const hereString = this.src.charAt(this.i - 1) === "@";
		this.i++;
		let expands = false;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (hereString) {
				if ((ch === "\n" || this.i === 0) && this.src.startsWith(`${quote}@`, this.i + 1)) {
					this.i += 3;
					return expands;
				}
			} else if (ch === quote) {
				if (quote === "'" && this.src.charAt(this.i + 1) === "'") {
					this.i += 2;
					continue;
				}
				this.i++;
				return expands;
			}
			if (quote === '"' && ch === "`") {
				this.i += 2;
				continue;
			}
			if (quote === '"' && ch === "$") {
				const next = this.src.charAt(this.i + 1);
				if (next === "(") {
					this.i++;
					this.nested.push(this.balanced("(", ")"));
					expands = true;
					continue;
				}
				if (/[A-Za-z_{:?$^]/.test(next)) expands = true;
			}
			this.i++;
		}
		this.fail("unterminated string");
	}

	parse(): PsScript {
		let words: PsWord[] = [];
		let start = this.i;
		let code = "";
		const finish = (): void => {
			if (words.length > 0) this.statements.push({ words, raw: this.src.slice(start, this.i).trim(), code });
			words = [];
			code = "";
		};
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (ch === " " || ch === "\t") {
				this.i++;
				continue;
			}
			if (ch === "#") {
				while (this.i < this.src.length && this.src.charAt(this.i) !== "\n") this.i++;
				continue;
			}
			if (ch === "<" && this.src.charAt(this.i + 1) === "#") {
				const end = this.src.indexOf("#>", this.i + 2);
				if (end === -1) this.fail("unterminated block comment");
				this.i = end + 2;
				continue;
			}
			if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|" || (ch === "&" && this.src.charAt(this.i + 1) === "&")) {
				finish();
				this.i += (ch === "|" && this.src.charAt(this.i + 1) === "|") || ch === "&" ? 2 : 1;
				start = this.i;
				continue;
			}
			if (ch === "{") {
				this.nested.push(this.balanced("{", "}"));
				code += " {} ";
				words.push({ text: "{}", raw: "{}", literal: false });
				// `if (…) { … } Remove-Item x`: what follows a control block is a statement of its own.
				const head = words[0];
				if (head?.literal && KEYWORDS.has(head.text.toLowerCase())) {
					finish();
					start = this.i;
				}
				continue;
			}
			if (ch === "}") this.fail("unexpected `}`");
			if (ch === ">" || (ch === "<" && this.src.charAt(this.i + 1) !== "#")) {
				while (this.i < this.src.length && ">&12*".includes(this.src.charAt(this.i))) this.i++;
				continue;
			}
			this.readWord(words, (piece) => {
				code += piece;
			});
			code += " ";
		}
		finish();
		return { statements: this.statements, nested: this.nested };
	}

	/** One argument word: barewords, strings, `$var`, `(…)`/`$(…)`/`@(…)` subexpressions (recorded as nested code). */
	private readWord(words: PsWord[], emitCode: (piece: string) => void): void {
		const start = this.i;
		let text = "";
		let literal = true;
		while (this.i < this.src.length) {
			const ch = this.src.charAt(this.i);
			if (" \t;\n\r|{}".includes(ch) || (ch === "&" && this.src.charAt(this.i + 1) === "&")) break;
			if (ch === "'" || ch === '"') {
				const begin = this.i;
				const expands = this.skipString(ch);
				const body = this.src.slice(begin + 1, this.i - 1);
				text += ch === "'" ? body.replaceAll("''", "'") : body.replace(/`(.)/g, "$1");
				literal &&= !expands;
				emitCode('""');
				continue;
			}
			if (ch === "`") {
				text += this.src.charAt(this.i + 1);
				emitCode(this.src.slice(this.i, this.i + 2));
				this.i += 2;
				continue;
			}
			if ((ch === "$" || ch === "@") && this.src.charAt(this.i + 1) === "(") {
				this.i++;
				this.nested.push(this.balanced("(", ")"));
				literal = false;
				emitCode("$()");
				continue;
			}
			if (ch === "(") {
				const inner = this.balanced("(", ")");
				this.nested.push(inner);
				literal = false;
				emitCode(`(${inner})`);
				continue;
			}
			if (ch === "$") literal = false;
			text += ch;
			emitCode(ch);
			this.i++;
		}
		if (this.i === start) this.fail(`unexpected \`${this.src.charAt(this.i)}\``);
		words.push({ text, raw: this.src.slice(start, this.i), literal });
	}
}

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

/**
 * Where the command of `$x = cmd`, `$x=cmd` or `[int]$x = cmd` starts: the words after `=`, the first one cut from
 * the word holding `=` when it is glued on. Null when the statement is an expression without assignment.
 */
function assignedCommand(words: readonly PsWord[]): readonly PsWord[] | null {
	for (let k = 0; k < words.length; k++) {
		const word = words[k];
		if (word === undefined) break;
		const equals = word.raw.search(/(?<![=!<>])=(?!=)/);
		if (equals < 0) continue;
		const rest = word.raw.slice(equals + 1);
		const after = words.slice(k + 1);
		if (rest === "") return after;
		return [{ text: rest, raw: rest, literal: !/[$@(`'"]/.test(rest) }, ...after];
	}
	return null;
}

function classifyStatement(statement: PsStatement, depth: number): Verdict {
	if (DELETE_METHOD.test(statement.code)) return block("delete", statement.raw, "`.Delete()` deletes files");
	let words: readonly PsWord[] = statement.words;
	const first = words[0];
	if (first === undefined) return ALLOW;
	const head = first.text.toLowerCase();
	if (first.literal && KEYWORDS.has(head)) return ALLOW;
	if (first.literal && PIPELINE_KEYWORDS.has(head)) words = words.slice(1);
	const lead = words[0];
	if (lead !== undefined && (lead.raw.startsWith("$") || lead.raw.startsWith("[") || lead.raw.startsWith("("))) {
		const assigned = assignedCommand(words);
		if (assigned === null) return ALLOW;
		words = assigned;
	}
	let i = 0;
	if (words[0]?.raw === "&" || words[0]?.raw === ".") {
		const operator = words[0].raw;
		i = 1;
		const target = words[1];
		if (target === undefined) return ALLOW;
		// `& { … }` / `. { … }` run a script block, which is judged as nested code.
		if (target.raw === "{}") return ALLOW;
		if (!target.literal) return block("nonLiteral", statement.raw, `\`${operator} ${target.raw}\` runs a command named by an expression`);
		// A literal target is classified like any command name: `. Remove-Item x` runs the cmdlet; `. ./x.ps1` is a script file.
	}
	const command = words[i];
	if (command === undefined) return ALLOW;
	// Without `&`, a quoted first word is a string value, not a command (`$x = "rm"`).
	if (i === 0 && (command.raw.startsWith("'") || command.raw.startsWith('"'))) return ALLOW;
	if (!command.literal)
		return command.raw.startsWith("$") ? ALLOW : block("nonLiteral", statement.raw, `the command name \`${command.raw}\` is not literal`);
	const name = programName(command.text);
	if (DELETE_COMMANDS.has(name)) return block("delete", statement.raw, `\`${command.text}\` deletes files`);
	if (name === "invoke-expression" || name === "iex")
		return block("nonLiteral", statement.raw, "`Invoke-Expression` runs a string as code");
	const kind = shellKind(command.text);
	if (kind !== null) return classifyShellInvocation(kind, command, words.slice(i + 1), depth, statement.raw);
	return ALLOW;
}

/** Classifies PowerShell text: every statement, script block and subexpression it contains, and nested shells. */
export function classifyPowershell(text: string, depth: number): Verdict {
	if (depth > MAX_DEPTH) return block("nonLiteral", text, `scripts nested more than ${MAX_DEPTH} levels deep are not classified`);
	let script: PsScript;
	try {
		script = new PsParser(text).parse();
	} catch (error) {
		if (error instanceof PsParseFailure) return block("nonLiteral", text, `the PowerShell script cannot be parsed (${error.message})`);
		throw error;
	}
	for (const statement of script.statements) {
		const verdict = classifyStatement(statement, depth);
		if (verdict.kind === "block") return verdict;
	}
	for (const inner of script.nested) {
		const verdict = classifyPowershell(inner, depth + 1);
		if (verdict.kind === "block") return verdict;
	}
	return ALLOW;
}
