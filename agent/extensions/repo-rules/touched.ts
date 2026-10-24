import * as os from "node:os";
import * as path from "node:path";
import { type ToolResultEvent, z } from "@oh-my-pi/pi-coding-agent";

/**
 * Absolute files a successful tool call read, wrote or edited — the events that load a Claude Code
 * path-scoped rule: Read, Write and Edit, plus a Bash command that reads one file (`cat`, `head`,
 * `tail`). Paths come from the tool's result details; only bash is resolved here, from its input.
 */
export function touchedFiles(event: ToolResultEvent, cwd: string): string[] {
	if (event.isError) return [];
	switch (event.toolName) {
		case "read":
			return readFiles(event.details);
		case "write":
			return writeFiles(event.input, event.details);
		case "edit":
			return editFiles(event.details);
		case "bash":
			return bashFiles(event.input, cwd);
		default:
			return [];
	}
}

const readSchema = z.object({
	isDirectory: z.boolean().optional(),
	resolvedPath: z.string().optional(),
	meta: z.object({ source: z.object({ type: z.string(), value: z.string() }).optional() }).optional(),
	displayReadTargetLinks: z.array(z.string().nullable()).optional(),
});

/** A file read exposes `resolvedPath` or a path-typed `meta.source`; a multi-target read lists its links. */
function readFiles(details: unknown): string[] {
	const parsed = readSchema.safeParse(details);
	if (!parsed.success || parsed.data.isDirectory === true) return [];
	const { resolvedPath, meta, displayReadTargetLinks } = parsed.data;
	if (displayReadTargetLinks !== undefined) return displayReadTargetLinks.filter((link): link is string => link !== null);
	if (resolvedPath !== undefined) return [resolvedPath];
	return meta?.source?.type === "path" ? [meta.source.value] : [];
}

const writeInputSchema = z.object({ path: z.string() });
const writeDetailsSchema = z.object({ resolvedPath: z.string() });

/** Handler-owned writes (`xd://`, `proc://`, `agent://`) carry no file; `local://` writes are files. */
function writeFiles(input: unknown, details: unknown): string[] {
	const target = writeInputSchema.safeParse(input);
	if (!target.success) return [];
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target.data.path) && !target.data.path.startsWith("local://")) return [];
	const parsed = writeDetailsSchema.safeParse(details);
	return parsed.success ? [parsed.data.resolvedPath] : [];
}

const editFileSchema = z.object({ path: z.string().optional(), sourcePath: z.string().optional() });
const editSchema = z.object({
	path: z.string().optional(),
	sourcePath: z.string().optional(),
	perFileResults: z.array(editFileSchema).optional(),
});

/** One file result or several; a rename touches both its source and its destination. */
function editFiles(details: unknown): string[] {
	const parsed = editSchema.safeParse(details);
	if (!parsed.success) return [];
	const files = parsed.data.perFileResults ?? [parsed.data];
	return files.flatMap((file) => [file.path, file.sourcePath].filter((value): value is string => value !== undefined));
}

const bashInputSchema = z.object({ command: z.string(), cwd: z.string().optional() });

function bashFiles(input: unknown, sessionCwd: string): string[] {
	const parsed = bashInputSchema.safeParse(input);
	if (!parsed.success) return [];
	const { command, cwd } = parsed.data;
	if (cwd?.includes("://")) return [];
	const file = singleFileRead(command);
	if (file === null) return [];
	const dir = cwd === undefined ? sessionCwd : path.resolve(sessionCwd, expandHome(cwd));
	return [path.resolve(dir, file)];
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Unquoted characters that make a command more than one static simple command. */
const SHELL_SPECIAL = "|&;<>()`$*?[]{}!#";

/**
 * Words of a command that is one simple command with static arguments, or null for anything that
 * needs a shell to resolve (pipes, chains, redirects, substitution, expansion, globbing).
 */
function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let word = "";
	let started = false;
	let i = 0;
	while (i < command.length) {
		const ch = command[i] ?? "";
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return null;
			word += command.slice(i + 1, end);
			started = true;
			i = end + 1;
		} else if (ch === '"') {
			const end = doubleQuoted(command, i + 1);
			if (end === null) return null;
			word += end.text;
			started = true;
			i = end.next;
		} else if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined) return null;
			word += next;
			started = true;
			i += 2;
		} else if (/\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
			i++;
		} else if (SHELL_SPECIAL.includes(ch)) {
			return null;
		} else if (ch === "~" && !started) {
			const next = command[i + 1];
			if (next !== undefined && next !== "/" && !/\s/.test(next)) return null;
			word += os.homedir();
			started = true;
			i++;
		} else {
			word += ch;
			started = true;
			i++;
		}
	}
	if (started) words.push(word);
	return words;
}

/** Text of a double-quoted span starting after its opening quote; null when it expands or never closes. */
function doubleQuoted(command: string, start: number): { readonly text: string; readonly next: number } | null {
	let text = "";
	for (let i = start; i < command.length; i++) {
		const ch = command[i] ?? "";
		if (ch === '"') return { text, next: i + 1 };
		if (ch === "$" || ch === "`") return null;
		const next = command[i + 1];
		if (ch === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
			text += next;
			i++;
			continue;
		}
		text += ch;
	}
	return null;
}

const READERS: Record<string, true> = { cat: true, head: true, tail: true };
/** `head`/`tail` options whose value is the next word. */
const VALUE_OPTIONS: Record<string, true> = { "-n": true, "-c": true, "--lines": true, "--bytes": true };

/** The one file a plain `cat`/`head`/`tail` command reads, or null. */
function singleFileRead(command: string): string | null {
	const words = shellWords(command.trim());
	if (words === null) return null;
	const [program, ...args] = words;
	if (program === undefined || READERS[program] !== true) return null;
	const operands: string[] = [];
	let optionsDone = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!optionsDone && arg === "--") {
			optionsDone = true;
		} else if (!optionsDone && arg.startsWith("-") && arg !== "-") {
			if (program !== "cat" && VALUE_OPTIONS[arg] === true) i++;
		} else {
			operands.push(arg);
		}
	}
	const [file] = operands;
	return operands.length === 1 && file !== undefined && file !== "-" ? file : null;
}
