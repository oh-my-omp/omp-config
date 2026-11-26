import * as os from "node:os";
import * as path from "node:path";
import { type BashToolInput, type ToolResultEvent, type WriteToolInput, z, type zod } from "@oh-my-pi/pi-coding-agent";
import type { WriteToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/write";
import { lexShellCommand } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";

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

const EXPANSION = /[$`<>*?[\]{}!#]/;
const BLANK = /^[ \t]+$/;
const READERS: Record<string, true> = { cat: true, head: true, tail: true };
const VALUE_OPTIONS: Record<string, true> = { "-n": true, "-c": true, "--lines": true, "--bytes": true };

function literalWords(command: string): string[] | null {
	const words: string[] = [];
	for (const token of lexShellCommand(command.trim())) {
		if (token.kind === "separator") {
			if (!BLANK.test(token.raw)) return null;
		} else if (EXPANSION.test(token.raw)) {
			return null;
		} else if (token.raw.startsWith("~")) {
			if (token.raw !== "~" && !token.raw.startsWith("~/")) return null;
			words.push(expandHome(token.value));
		} else {
			words.push(token.value);
		}
	}
	return words;
}

function singleFileRead(command: string): string | null {
	const words = literalWords(command);
	const program = words?.[0];
	if (words === null || program === undefined || READERS[program] !== true) return null;
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
