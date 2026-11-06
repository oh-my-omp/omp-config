/**
 * The executed facts of one `bash` tool run, read from the result's
 * `details.trace` (pi-shell's `ShellTrace`, omp ≥ 18.17.0) once the run is
 * over. Only the fields the reminder lanes use are parsed; everything else in
 * the trace is ignored. Offsets in the trace are UTF-8 byte offsets into each
 * unit's source.
 *
 * A step is one simple command that actually ran (`runs > 0`), in source
 * order. Callout units (the operands `timeout`/`xargs`/`git` ran) are left
 * out: their calling command stands for them, and the static analysis already
 * resolves through those wrappers. Function and `eval` bodies are traced as
 * steps of their own; the calling command is marked `wrapsBody`.
 */
import { z } from "@oh-my-pi/pi-coding-agent";

const resolvedSchema = z.enum(["function", "intrinsic", "tool", "native", "device", "self_shell", "external", "not_found", "none"]);
type Resolved = z.infer<typeof resolvedSchema>;

const nodeSchema = z.object({
	k: z.string(),
	lo: z.number(),
	hi: z.number(),
	p: z.number().optional(),
	runs: z.number().optional(),
	st: z.number().optional(),
	argv: z.array(z.string()).optional(),
	res: resolvedSchema.optional(),
});
type TraceNode = z.infer<typeof nodeSchema>;

const unitSchema = z.object({
	at: z.number().optional(),
	source: z.string().optional(),
	callout: z.boolean().optional(),
	nodes: z.array(nodeSchema),
});
type TraceUnit = z.infer<typeof unitSchema>;

const outputSchema = z.object({ kind: z.literal("Output"), u: z.number().optional(), n: z.number().optional() });

const traceSchema = z.object({
	v: z.literal(1),
	script: z.string(),
	status: z.number().optional(),
	historyTruncated: z.boolean().optional(),
	units: z.array(unitSchema),
	history: z.array(z.object({ kind: z.string() }).passthrough()).optional(),
});

const detailsSchema = z.object({
	trace: z.unknown().optional(),
	timedOut: z.boolean().optional(),
	async: z.unknown().optional(),
});

/** One simple command that ran. */
export type TraceStep = {
	readonly argv: readonly string[];
	readonly resolved: Resolved;
	/** Exit status of its last run. */
	readonly status: number;
	/** The command's own source text (redirections included, expansions not). */
	readonly source: string;
	/** Identity of its pipeline when the pipeline has more than one stage, else null. */
	readonly pipeline: string | null;
	/** Zero-based stage in its pipeline; 0 outside a multi-stage pipeline. */
	readonly stage: number;
	readonly lastStage: boolean;
	/** It runs inside a `$(…)`/backtick substitution or an assignment value. */
	readonly captured: boolean;
	/** Its status is the test of `if`/`elif`/`while`/`until`, or negated by `!`. */
	readonly test: boolean;
	/** Something used its exit status: a test, a non-final `&&`/`||` operand, or a substitution. */
	readonly statusUsed: boolean;
	/** At least one chunk of the visible output is attributed to it. */
	readonly output: boolean;
	/** A function call, `eval`, `source` or `.`: the body's own steps carry what ran. */
	readonly wrapsBody: boolean;
};

export type ExecutedTrace = { readonly script: string; readonly steps: readonly TraceStep[] };

/**
 * What a shell tool result tells about the run:
 * `traced` — a foreground run that ended, with its whole trace;
 * `timedOut` — the deadline cut it short; the trace (if any) is partial;
 * `interrupted` — cancelled or aborted before a result existed;
 * `background` — the call returned while the job keeps running;
 * `untraced` — no usable trace (another backend, a truncated journal, an older omp).
 */
export type ShellOutcome =
	| { readonly kind: "traced"; readonly trace: ExecutedTrace }
	| { readonly kind: "timedOut"; readonly trace: ExecutedTrace | null }
	| { readonly kind: "interrupted" }
	| { readonly kind: "background" }
	| { readonly kind: "untraced" };

const BODY_BUILTINS: Readonly<Record<string, true>> = { eval: true, source: true, ".": true };
const NOT_STATEMENTS: Readonly<Record<string, true>> = { word: true, assign: true };

/** Statement children of `parent`, in source order. */
function childrenOf(nodes: readonly TraceNode[], parent: number): number[] {
	const ids: number[] = [];
	for (const [id, node] of nodes.entries()) if (node.p === parent && NOT_STATEMENTS[node.k] !== true) ids.push(id);
	return ids.sort((a, b) => (nodes[a]?.lo ?? 0) - (nodes[b]?.lo ?? 0));
}

function isCaptured(nodes: readonly TraceNode[], id: number): boolean {
	for (let parent = nodes[id]?.p; parent !== undefined; parent = nodes[parent]?.p) {
		if (NOT_STATEMENTS[nodes[parent]?.k ?? ""] === true) return true;
	}
	return false;
}

/** Whether the and_or list `list` is a condition of the compound command holding it. */
function isCondition(nodes: readonly TraceNode[], list: number): boolean {
	const holder = nodes[list]?.p;
	if (holder === undefined) return false;
	const kind = nodes[holder]?.k;
	const parts = childrenOf(nodes, holder);
	const index = parts.indexOf(list);
	if (kind === "while" || kind === "until") return index === 0;
	if (kind !== "if") return false;
	// if C1; then B1; elif C2; then B2; else E; fi → C1 B1 C2 B2 E: even positions, minus a trailing else.
	const conditions = parts.length % 2 === 1 ? parts.length - 1 : parts.length;
	return index % 2 === 0 && index < conditions;
}

function unitSteps(unit: TraceUnit, u: number, script: Buffer, outputs: ReadonlySet<string>): TraceStep[] {
	const { nodes } = unit;
	const bytes = unit.source !== undefined ? Buffer.from(unit.source) : script.subarray(unit.at ?? 0);
	const steps: TraceStep[] = [];
	for (const [id, node] of nodes.entries()) {
		if (node.k !== "simple" || (node.runs ?? 0) <= 0 || node.argv === undefined) continue;
		const parentId = node.p;
		const parent = parentId === undefined ? undefined : nodes[parentId];
		const inPipeline = parentId !== undefined && parent?.k === "pipeline";
		const stages = inPipeline ? childrenOf(nodes, parentId) : [id];
		const stage = Math.max(0, stages.indexOf(id));
		const lastStage = stage === stages.length - 1;
		const statement = inPipeline ? parentId : id;
		const statementNode = nodes[statement];
		const negated = statementNode !== undefined && statementNode.lo < node.lo && bytes[statementNode.lo] === 0x21;
		const list = statementNode?.p;
		const listParts = list !== undefined && nodes[list]?.k === "and_or" ? childrenOf(nodes, list) : [];
		const operandUsed = listParts.length > 1 && listParts.indexOf(statement) < listParts.length - 1;
		const test = lastStage && (negated || (list !== undefined && nodes[list]?.k === "and_or" && isCondition(nodes, list)));
		const captured = isCaptured(nodes, id);
		const argv = node.argv;
		const resolved = node.res ?? "none";
		steps.push({
			argv,
			resolved,
			status: node.st ?? 0,
			source: bytes.subarray(node.lo, node.hi).toString("utf8"),
			pipeline: stages.length > 1 ? `${u}:${parentId}` : null,
			stage,
			lastStage,
			captured,
			test,
			statusUsed: test || captured || (lastStage && operandUsed),
			output: outputs.has(`${u}:${id}`),
			wrapsBody: resolved === "function" || (resolved === "intrinsic" && BODY_BUILTINS[argv[0] ?? ""] === true),
		});
	}
	return steps;
}

function executedTrace(raw: unknown): { readonly trace: ExecutedTrace; readonly complete: boolean } | null {
	const parsed = traceSchema.safeParse(raw);
	if (!parsed.success) return null;
	const { script, units, history, status, historyTruncated } = parsed.data;
	const outputs = new Set<string>();
	for (const entry of history ?? []) {
		const output = outputSchema.safeParse(entry);
		if (output.success && output.data.u !== undefined && output.data.n !== undefined) outputs.add(`${output.data.u}:${output.data.n}`);
	}
	const bytes = Buffer.from(script);
	const steps: TraceStep[] = [];
	for (const [u, unit] of units.entries()) if (unit.callout !== true) steps.push(...unitSteps(unit, u, bytes, outputs));
	return { trace: { script, steps }, complete: status !== undefined && historyTruncated !== true };
}

/** Reads a `bash` tool result; `isError` with no details is a run cancelled before it produced a result. */
export function shellOutcome(details: unknown, isError: boolean): ShellOutcome {
	if (details === undefined || details === null) return isError ? { kind: "interrupted" } : { kind: "untraced" };
	const parsed = detailsSchema.safeParse(details);
	if (!parsed.success) return { kind: "untraced" };
	if (parsed.data.async !== undefined) return { kind: "background" };
	const read = parsed.data.trace === undefined ? null : executedTrace(parsed.data.trace);
	if (parsed.data.timedOut === true) return { kind: "timedOut", trace: read?.trace ?? null };
	return read?.complete ? { kind: "traced", trace: read.trace } : { kind: "untraced" };
}
