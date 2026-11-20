import * as os from "node:os";
import * as path from "node:path";
import { type BashToolInput, type ToolResultEvent, type WriteToolInput, z, type zod } from "@oh-my-pi/pi-coding-agent";
import type { WriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";

type BuiltinToolName = "read" | "write" | "edit" | "bash";
type BuiltinResult<N extends BuiltinToolName> = Extract<ToolResultEvent, { toolName: N }>;

// Do not narrow with `switch (event.toolName)`: custom results keep `toolName: string`, so their `details: unknown` stays in the union.
function resultOf<N extends BuiltinToolName>(event: ToolResultEvent, toolName: N): event is BuiltinResult<N> {
	return event.toolName === toolName;
}

export function touchedFiles(event: ToolResultEvent, cwd: string): string[] {
	if (event.isError) return [];
	if (resultOf(event, "read")) return readFiles(event.details);
	if (resultOf(event, "write")) {
		// Do not read `resolvedPath` from the event's typed details: they are typed `undefined`, yet the write result carries it.
		// Once the host types them, the line below stops compiling; then delete the parse and read the typed details.
		const hostDetails: undefined = event.details;
		return writeFiles(event.input, hostDetails);
	}
	if (resultOf(event, "edit")) return editFiles(event.details);
	if (resultOf(event, "bash")) return bashFiles(event.input, cwd);
	return [];
}

function readFiles(details: BuiltinResult<"read">["details"]): string[] {
	if (details === undefined || details.isDirectory === true) return [];
	const { resolvedPath, meta, displayReadTargetLinks } = details;
	if (displayReadTargetLinks !== undefined) return displayReadTargetLinks.filter((link): link is string => link !== null);
	if (resolvedPath !== undefined) return [resolvedPath];
	const source = meta?.source;
	return source?.type === "path" ? [source.value] : [];
}

const writeInputSchema: zod.ZodLikeSchema<Pick<WriteToolInput, "path">> = z.object({ path: z.string() });
const writeDetailsSchema: zod.ZodLikeSchema<Pick<WriteToolDetails, "resolvedPath">> = z.object({
	resolvedPath: z.string().optional(),
});

function writeFiles(input: unknown, details: unknown): string[] {
	const target = writeInputSchema.safeParse(input);
	if (!target.success) return [];
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target.data.path) && !target.data.path.startsWith("local://")) return [];
	const parsed = writeDetailsSchema.safeParse(details);
	const resolvedPath = parsed.success ? parsed.data.resolvedPath : undefined;
	return resolvedPath === undefined ? [] : [resolvedPath];
}

function editFiles(details: BuiltinResult<"edit">["details"]): string[] {
	if (details === undefined) return [];
	const files = details.perFileResults ?? [details];
	return files.flatMap((file) => [file.path, file.sourcePath].filter((value): value is string => value !== undefined));
}

const bashInputSchema: zod.ZodLikeSchema<Pick<BashToolInput, "command" | "cwd">> = z.object({
	command: z.string(),
	cwd: z.string().optional(),
});

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

const SHELL_SPECIAL = "|&;<>()`$*?[]{}!#";
const SPACE = /\s/;

function scanWords(command: string, emit: (word: string) => boolean): boolean {
	let parts: string[] = [];
	let started = false;
	const flush = (): boolean => {
		if (!started) return true;
		const word = parts.join("");
		parts = [];
		started = false;
		return emit(word);
	};
	let i = 0;
	while (i < command.length) {
		const ch = command[i] ?? "";
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return false;
			parts.push(command.slice(i + 1, end));
			started = true;
			i = end + 1;
		} else if (ch === '"') {
			const quoted = doubleQuoted(command, i + 1);
			if (quoted === null) return false;
			parts.push(quoted.text);
			started = true;
			i = quoted.next;
		} else if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined) return false;
			parts.push(next);
			started = true;
			i += 2;
		} else if (SPACE.test(ch)) {
			if (!flush()) return true;
			i++;
		} else if (SHELL_SPECIAL.includes(ch)) {
			return false;
		} else if (ch === "~" && !started) {
			const next = command[i + 1];
			if (next !== undefined && next !== "/" && !SPACE.test(next)) return false;
			parts.push(os.homedir());
			started = true;
			i++;
		} else {
			let end = i + 1;
			while (end < command.length) {
				const next = command[end] ?? "";
				if (next === "'" || next === '"' || next === "\\" || SPACE.test(next) || SHELL_SPECIAL.includes(next)) break;
				end++;
			}
			parts.push(command.slice(i, end));
			started = true;
			i = end;
		}
	}
	flush();
	return true;
}

function shellWords(command: string): string[] | null {
	const words: string[] = [];
	return scanWords(command, (word) => {
		words.push(word);
		return true;
	})
		? words
		: null;
}

function firstWord(command: string): string | null {
	let program: string | null = null;
	scanWords(command, (word) => {
		program = word;
		return false;
	});
	return program;
}

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
const VALUE_OPTIONS: Record<string, true> = { "-n": true, "-c": true, "--lines": true, "--bytes": true };

function singleFileRead(command: string): string | null {
	const program = firstWord(command);
	if (program === null || READERS[program] !== true) return null;
	const words = shellWords(command);
	if (words === null) return null;
	const operands: string[] = [];
	let optionsDone = false;
	for (let i = 1; i < words.length; i++) {
		const arg = words[i] ?? "";
		if (!optionsDone && arg === "--") {
			optionsDone = true;
		} else if (!optionsDone && arg.startsWith("-") && arg !== "-") {
			if (program !== "cat" && VALUE_OPTIONS[arg] === true) i++;
		} else {
			operands.push(arg);
		}
	}
	const file = operands[0];
	return operands.length === 1 && file !== undefined && file !== "-" ? file : null;
}
