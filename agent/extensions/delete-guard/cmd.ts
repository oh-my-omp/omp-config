import type { ArgvWord } from "./classify.ts";
import { classifyNestedProgram, programName } from "./nested.ts";
import { ALLOW, block, MAX_DEPTH, tooDeep, type Verdict } from "./verdict.ts";

const DELETE_COMMANDS: ReadonlySet<string> = new Set(["del", "erase", "rd", "rmdir", "rm", "unlink", "shred"]);

type CmdWord = ArgvWord & { readonly raw: string };

type CmdCommand = { readonly words: readonly CmdWord[]; readonly raw: string };

class CmdParseFailure extends Error {}

const EXPANSION = /%[^%\s]+%|![^!\s]+!|%~?[0-9a-zA-Z*]/;

function splitCmd(text: string): CmdCommand[] {
	const commands: CmdCommand[] = [];
	let words: CmdWord[] = [];
	let word = "";
	let raw = "";
	let inWord = false;
	let start = 0;
	let quoted = false;
	const flushWord = (): void => {
		if (inWord) words.push({ text: word, raw, literal: !EXPANSION.test(raw) });
		word = "";
		raw = "";
		inWord = false;
	};
	const flushCommand = (end: number): void => {
		flushWord();
		if (words.length > 0) commands.push({ words, raw: text.slice(start, end).trim() });
		words = [];
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (quoted) {
			raw += ch;
			if (ch === '"') quoted = false;
			else word += ch;
			continue;
		}
		if (ch === "^" && i + 1 < text.length) {
			word += text.charAt(i + 1);
			raw += ch + text.charAt(i + 1);
			inWord = true;
			i++;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			raw += ch;
			inWord = true;
			continue;
		}
		if (ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "\n" || ch === "\r") {
			flushCommand(i);
			if ((ch === "&" || ch === "|") && text.charAt(i + 1) === ch) i++;
			start = i + 1;
			continue;
		}
		if (ch === ">" || ch === "<") {
			if (inWord && /^@?[0-9]+$/.test(raw)) {
				word = "";
				raw = "";
				inWord = false;
			} else {
				flushWord();
			}
			while (text.charAt(i + 1) === ">" || text.charAt(i + 1) === "&") i++;
			while (text.charAt(i + 1) === " ") i++;
			const targetStart = i;
			while (i + 1 < text.length && !" \t&|()<>".includes(text.charAt(i + 1))) i++;
			if (i === targetStart && !/[0-9]/.test(text.charAt(i))) throw new CmdParseFailure("redirection without a target");
			continue;
		}
		if (ch === " " || ch === "\t") {
			flushWord();
			continue;
		}
		word += ch;
		raw += ch;
		inWord = true;
	}
	if (quoted) throw new CmdParseFailure("unterminated quote");
	flushCommand(text.length);
	return commands;
}

function afterIf(words: readonly CmdWord[], start: number): number {
	let i = start;
	if (words[i]?.text.toLowerCase() === "/i") i++;
	if (words[i]?.text.toLowerCase() === "not") i++;
	const keyword = words[i]?.text.toLowerCase() ?? "";
	if (keyword === "exist" || keyword === "defined" || keyword === "errorlevel" || keyword === "cmdextversion") return i + 2;
	if (words[i]?.text.includes("==") && !words[i]?.text.endsWith("==")) return i + 1;
	return i + 3;
}

const START_VALUE_OPTIONS: ReadonlySet<string> = new Set(["/d", "/node", "/affinity", "/machine"]);

function afterStart(words: readonly CmdWord[], start: number): number {
	let i = start;
	if (words[i]?.raw.startsWith('"')) i++;
	for (let word = words[i]; word?.text.startsWith("/"); word = words[i]) i += START_VALUE_OPTIONS.has(word.text.toLowerCase()) ? 2 : 1;
	return i;
}

function classifyCmdCommand(command: CmdCommand, depth: number): Verdict {
	const { words } = command;
	let i = 0;
	for (;;) {
		const word = words[i];
		if (word === undefined) return ALLOW;
		const head = word.text.replace(/^@/, "");
		const lower = head.toLowerCase();
		if (lower === "" || lower === "do" || lower === "else") {
			i++;
			continue;
		}
		if (lower === "rem" || lower.startsWith("::")) return ALLOW;
		if (lower === "if") {
			i = afterIf(words, i + 1);
			continue;
		}
		if (lower === "for") return ALLOW;
		if (lower === "call") {
			if (words[i + 1]?.text.startsWith(":")) return ALLOW;
			i++;
			continue;
		}
		if (lower === "start") {
			i = afterStart(words, i + 1);
			continue;
		}
		const quote = word.raw.charAt(0);
		if ((quote === "'" || quote === "`") && i === 0) {
			const inner = command.raw.trim();
			return classifyCmd(inner.endsWith(quote) ? inner.slice(1, -1) : inner.slice(1), depth + 1);
		}
		if (!word.literal) return block("nonLiteral", command.raw, `the command name \`${word.raw}\` comes from a \`%VAR%\` expansion`);
		const name = programName(head);
		if (DELETE_COMMANDS.has(name)) return block("delete", command.raw, `\`${name}\` deletes files`);
		const nested = classifyNestedProgram(word, words.slice(i + 1), depth, command.raw, null);
		if (nested !== null) return nested;
		return ALLOW;
	}
}

export function classifyCmd(text: string, depth: number): Verdict {
	if (depth > MAX_DEPTH) return tooDeep(text);
	let commands: CmdCommand[];
	try {
		commands = splitCmd(text);
	} catch (error) {
		if (error instanceof CmdParseFailure) return block("nonLiteral", text, `the cmd command line cannot be parsed (${error.message})`);
		throw error;
	}
	for (const command of commands) {
		const verdict = classifyCmdCommand(command, depth);
		if (verdict.kind === "block") return verdict;
	}
	return ALLOW;
}
