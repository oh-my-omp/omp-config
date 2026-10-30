import { isDeviceTarget, resolveCommand, type ShellWord } from "./shell-command.ts";
import { type CommandToken, type SimpleCommand, splitSimpleCommands } from "./shell-parser.ts";
import {
	type Analysis,
	type AnalysisContext,
	analyzeProgram,
	type Finding,
	isShellProgram,
	type NonEmptyReadonlyArray,
	type ShellProgram,
	type ShellViolation,
	type StreamRole,
	type ViolationCategory,
} from "./shell-programs.ts";

/** Library entry points the eval tool's `code` uses to reimplement `read`/`glob`. */
type EvalApi =
	| "open"
	| "Path.read_text"
	| "Path.read_bytes"
	| "readlines"
	| "readFileSync"
	| "fs.readFile"
	| "Bun.file"
	| "os.listdir"
	| "os.scandir"
	| "os.walk"
	| "glob.glob"
	| "Path.glob"
	| "readdirSync"
	| "fs.readdir"
	| "Bun.Glob";

type EvalViolation = {
	readonly categories: NonEmptyReadonlyArray<ViolationCategory>;
	readonly program: EvalApi;
	readonly target: string;
};

/** Stands for the operands `xargs` appends when its stdin is a path stream. */
const XARGS_OPERAND = "<xargs>";

/** `xargs`: the program runs on arguments xargs built from stdin, so it consumes the upstream output. */
type Stage = { readonly program: ShellProgram | null; readonly analysis: Analysis; readonly xargs: boolean };

const UNKNOWN_STAGE: Stage = { program: null, analysis: { findings: [], nested: [], role: "other" }, xargs: false };

function analyzeTokens(tokens: readonly CommandToken[], piped: boolean, provenance: StreamRole | null): Stage {
	const invocation = resolveCommand(tokens, piped, "elevatedAndRemote");
	if (invocation === null) return UNKNOWN_STAGE;
	if (!isShellProgram(invocation.program)) return { ...UNKNOWN_STAGE, xargs: invocation.feed.kind === "xargs" };
	// `find … | xargs grep foo`: xargs appends the paths, so the program gets file operands.
	const fed =
		invocation.feed.kind === "xargs" && !invocation.feed.replace && provenance === "paths"
			? {
					...invocation,
					words: [...invocation.words, { text: XARGS_OPERAND, dynamic: true }],
					args: [...invocation.args, XARGS_OPERAND],
				}
			: invocation;
	const context: AnalysisContext = { provenance, shell: detectShellViolations, command: analyzeWords };
	return {
		program: invocation.program,
		analysis: analyzeProgram(invocation.program, fed, context),
		xargs: invocation.feed.kind === "xargs",
	};
}

/** A command built from words (a `find -exec` body): no redirections, no pipe. */
function analyzeWords(words: readonly ShellWord[]): ShellViolation[] {
	const tokens: CommandToken[] = words.map((word) => ({ kind: "word", text: word.text, dynamic: word.dynamic }));
	const stage = analyzeTokens(tokens, false, null);
	return [...stageViolation(stage, stage.analysis.findings), ...stage.analysis.nested];
}

/** One violation per command: its categories in first-seen order, named by the first target. */
function stageViolation(stage: Stage, findings: readonly Finding[]): ShellViolation[] {
	// `/dev/*` is a stream, not file bytes; listing `/dev` and inline scripts still count.
	const counted = findings.filter(
		(finding) => finding.category === "list" || finding.category === "eval" || !isDeviceTarget(finding.target),
	);
	const [first, ...rest] = counted;
	if (stage.program === null || first === undefined) return [];
	const categories: [ViolationCategory, ...ViolationCategory[]] = [first.category];
	for (const finding of rest) if (!categories.includes(finding.category)) categories.push(finding.category);
	return [{ categories, program: stage.program, target: first.target }];
}

/** Indices of the commands in `index`'s pipeline that come before it, nearest first. */
function upstreamOf(commands: readonly SimpleCommand[], index: number): number[] {
	const pipelineId = commands[index]?.pipelineId;
	const upstream: number[] = [];
	for (let earlier = index - 1; earlier >= 0; earlier--) if (commands[earlier]?.pipelineId === pipelineId) upstream.push(earlier);
	return upstream;
}

/** What reaches a piped stage: the role of the nearest upstream stage that is not a pure filter. */
function provenanceOf(commands: readonly SimpleCommand[], stages: readonly Stage[], index: number): StreamRole | null {
	if (commands[index]?.piped !== true) return null;
	for (const earlier of upstreamOf(commands, index)) {
		const role = stages[earlier]?.analysis.role ?? "other";
		if (role !== "filter") return role;
	}
	return "other";
}

/**
 * Whether a stage's output goes to another program rather than to the agent,
 * so a listing, read or search there is not what a built-in tool would give:
 * it passes only through stdin filters into a counter (`wc`, `uniq -c`), or
 * becomes the arguments of an `xargs` program. `ls -dt … | head` reaches the
 * agent.
 */
function outputConsumed(commands: readonly SimpleCommand[], stages: readonly Stage[], index: number): boolean {
	const pipelineId = commands[index]?.pipelineId;
	let counts = false;
	for (let later = index + 1; later < commands.length; later++) {
		if (commands[later]?.pipelineId !== pipelineId) continue;
		const stage = stages[later];
		if (stage?.xargs === true) return true;
		const role = stage?.analysis.role;
		if (role === "counter") counts = true;
		else if (role !== "filter") return false;
	}
	return counts;
}

const COUNTABLE: ReadonlySet<ViolationCategory> = new Set(["list", "read", "search"]);

/**
 * Every shell command whose work a built-in tool owns. Commands are resolved
 * through wrappers (`timeout`, `xargs`, `env`, …) and reserved words; nested
 * command lines (`bash -c '…'`, `eval '…'`, `find -exec … ;`) are analyzed in
 * place. A stage's stdin source decides pathless forms (`rg foo` searches the
 * working directory unless piped) and authored writes (`printf … | tee f`).
 * Listing, reading and searching whose output feeds the shell — a `$(…)`
 * capture, a count, `xargs` arguments — is not counted.
 */
export function detectShellViolations(command: string): ShellViolation[] {
	const commands = splitSimpleCommands(command);
	const stages: Stage[] = [];
	for (const [index, simple] of commands.entries()) {
		stages.push(analyzeTokens(simple.tokens, simple.piped, provenanceOf(commands, stages, index)));
	}
	const violations: ShellViolation[] = [];
	for (const [index, stage] of stages.entries()) {
		const { findings, nested } = stage.analysis;
		if (findings.length === 0 && nested.length === 0) continue;
		const consumed = commands[index]?.captured === true || outputConsumed(commands, stages, index);
		if (!consumed) {
			violations.push(...stageViolation(stage, findings), ...nested);
			continue;
		}
		violations.push(
			...stageViolation(
				stage,
				findings.filter((finding) => !COUNTABLE.has(finding.category)),
			),
		);
		violations.push(...nested.filter((violation) => violation.categories.some((category) => !COUNTABLE.has(category))));
	}
	return violations;
}

type EvalLanguage = "py" | "js";
/** One library call the eval tool's `code` uses where a built-in tool exists. */
type EvalPattern = {
	readonly category: "read" | "list";
	readonly program: EvalApi;
	readonly test: RegExp;
};

/**
 * The eval tool's `code` is Python or JavaScript, not a shell line, so it needs
 * its own matchers. Only file reads (the `read` tool) and path/directory listing
 * (the `glob` tool) are flagged; writes, subprocesses, and in-memory work are
 * left alone. Patterns run in order and the first match per category names it.
 */
const EVAL_PATTERNS: Record<EvalLanguage, readonly EvalPattern[]> = {
	py: [
		{ category: "read", program: "Path.read_text", test: /\.read_text\s*\(/ },
		{ category: "read", program: "Path.read_bytes", test: /\.read_bytes\s*\(/ },
		{ category: "read", program: "open", test: /\bopen\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*read/ },
		{ category: "read", program: "open", test: /\bopen\s*\([^)]*,\s*['"]r[bt+]*['"]\s*\)/ },
		{ category: "read", program: "open", test: /\bwith\s+open\s*\((?![^)]*['"][wax][bt+]*['"])[^)]*\)\s*as\b/ },
		{ category: "read", program: "open", test: /\bfor\b[^\n]*\bin\s+open\s*\(/ },
		{ category: "read", program: "readlines", test: /\.readlines\s*\(/ },
		{ category: "list", program: "glob.glob", test: /\bglob\.i?glob\s*\(/ },
		{ category: "list", program: "os.walk", test: /\bos\.walk\s*\(/ },
		{ category: "list", program: "os.listdir", test: /\bos\.listdir\s*\(/ },
		{ category: "list", program: "os.scandir", test: /\bos\.scandir\s*\(/ },
		{ category: "list", program: "Path.glob", test: /\.\s*r?glob\s*\(/ },
	],
	js: [
		{ category: "read", program: "readFileSync", test: /\breadFileSync\s*\(/ },
		{ category: "read", program: "fs.readFile", test: /\.\s*readFile\s*\(/ },
		{
			category: "read",
			program: "Bun.file",
			test: /\bBun\.file\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:text|json|bytes|arrayBuffer|stream|formData)\s*\(/,
		},
		{ category: "list", program: "readdirSync", test: /\breaddirSync\s*\(/ },
		{ category: "list", program: "fs.readdir", test: /\.\s*readdir\s*\(/ },
		{ category: "list", program: "Bun.Glob", test: /\bBun\.Glob\b|\bnew\s+Glob\s*\(/ },
	],
};

const isEvalLanguage = (language: string): language is EvalLanguage => language === "py" || language === "js";

/**
 * Flags eval-tool code that reimplements `read` (file bytes) or `glob`
 * (directory/path listing), at most one violation per category. Write,
 * subprocess, and pure in-memory work are intentionally ignored.
 */
export function detectEvalViolations(language: string, code: string): EvalViolation[] {
	if (!isEvalLanguage(language)) return [];
	const seen: Record<"read" | "list", boolean> = { read: false, list: false };
	const violations: EvalViolation[] = [];
	for (const { category, program, test } of EVAL_PATTERNS[language]) {
		if (seen[category]) continue;
		const match = test.exec(code);
		if (match === null) continue;
		seen[category] = true;
		violations.push({ categories: [category], program, target: match[0].trim().slice(0, 60) });
	}
	return violations;
}
