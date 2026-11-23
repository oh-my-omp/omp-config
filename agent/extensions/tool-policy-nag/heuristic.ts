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
import type { ExecutedTrace } from "./trace.ts";

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

export type Violation = EvalViolation | ShellViolation;

const XARGS_OPERAND = "<xargs>";

type Stage = { readonly program: ShellProgram | null; readonly analysis: Analysis; readonly xargs: boolean };

const UNKNOWN_STAGE: Stage = { program: null, analysis: { findings: [], nested: [], role: "other" }, xargs: false };

function analyzeTokens(tokens: readonly CommandToken[], piped: boolean, provenance: StreamRole | null): Stage {
	const invocation = resolveCommand(tokens, piped, "elevatedAndRemote");
	if (invocation === null) return UNKNOWN_STAGE;
	if (!isShellProgram(invocation.program)) return { ...UNKNOWN_STAGE, xargs: invocation.feed.kind === "xargs" };
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

function analyzeWords(words: readonly ShellWord[]): ShellViolation[] {
	const tokens: CommandToken[] = words.map((word) => ({ kind: "word", text: word.text, dynamic: word.dynamic }));
	const stage = analyzeTokens(tokens, false, null);
	return [...stageViolation(stage, stage.analysis.findings), ...stage.analysis.nested];
}

function stageViolation(stage: Stage, findings: readonly Finding[]): ShellViolation[] {
	const counted = findings.filter(
		(finding) => finding.category === "list" || finding.category === "eval" || !isDeviceTarget(finding.target),
	);
	const [first, ...rest] = counted;
	if (stage.program === null || first === undefined) return [];
	const categories: [ViolationCategory, ...ViolationCategory[]] = [first.category];
	for (const finding of rest) if (!categories.includes(finding.category)) categories.push(finding.category);
	return [{ categories, program: stage.program, target: first.target }];
}

function upstreamOf(commands: readonly SimpleCommand[], index: number): number[] {
	const pipelineId = commands[index]?.pipelineId;
	const upstream: number[] = [];
	for (let earlier = index - 1; earlier >= 0; earlier--) if (commands[earlier]?.pipelineId === pipelineId) upstream.push(earlier);
	return upstream;
}

function provenanceOf(commands: readonly SimpleCommand[], stages: readonly Stage[], index: number): StreamRole | null {
	if (commands[index]?.piped !== true) return null;
	for (const earlier of upstreamOf(commands, index)) {
		const role = stages[earlier]?.analysis.role ?? "other";
		if (role !== "filter") return role;
	}
	return "other";
}

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

export function detectCommandViolations(commands: readonly SimpleCommand[], reached: (index: number) => boolean): ShellViolation[] {
	const stages: Stage[] = [];
	for (const [index, simple] of commands.entries()) {
		stages.push(analyzeTokens(simple.tokens, simple.piped, provenanceOf(commands, stages, index)));
	}
	const violations: ShellViolation[] = [];
	for (const [index, stage] of stages.entries()) {
		const { findings, nested } = stage.analysis;
		if (findings.length === 0 && nested.length === 0) continue;
		const consumed = commands[index]?.captured === true || outputConsumed(commands, stages, index) || !reached(index);
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

function detectShellViolations(command: string): ShellViolation[] {
	return detectCommandViolations(splitSimpleCommands(command), () => true);
}

export function detectTraceViolations(trace: ExecutedTrace): ShellViolation[] {
	const steps = trace.steps.filter((step) => !step.wrapsBody);
	const pipelines = new Map<string, number>();
	const commands: SimpleCommand[] = steps.map((step, index) => {
		let pipelineId = index + steps.length;
		if (step.pipeline !== null) {
			pipelineId = pipelines.get(step.pipeline) ?? index;
			pipelines.set(step.pipeline, pipelineId);
		}
		const tokens: CommandToken[] = step.test ? [{ kind: "word", text: "!", dynamic: false }] : [];
		for (const text of step.argv) tokens.push({ kind: "word", text, dynamic: false });
		const source = splitSimpleCommands(step.source)[0]?.tokens ?? [];
		for (let at = 0; at < source.length; at++) {
			const token = source[at];
			if (token === undefined || token.kind === "word") continue;
			tokens.push(token);
			const target = source[at + 1];
			if (target?.kind === "word") {
				tokens.push(target);
				at++;
			}
		}
		return { tokens, pipelineId, piped: step.stage > 0, captured: step.captured, background: false, loopBody: false };
	});
	const outputThrough = new Map<string, number>();
	for (const [index, step] of steps.entries()) {
		if (!step.output || step.pipeline === null) continue;
		outputThrough.set(step.pipeline, index);
	}
	const reached = (index: number): boolean => {
		const step = steps[index];
		if (step === undefined) return false;
		if (step.pipeline === null) return step.output;
		const last = outputThrough.get(step.pipeline);
		return last !== undefined && last >= index;
	};
	return detectCommandViolations(commands, reached);
}

type EvalLanguage = "py" | "js";
type EvalPattern = {
	readonly category: "read" | "list";
	readonly program: EvalApi;
	readonly test: RegExp;
};

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
