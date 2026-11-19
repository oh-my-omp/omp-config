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

const traceSchema = z.object({
	v: z.literal(1),
	script: z.string(),
	status: z.number().optional(),
	historyTruncated: z.boolean().optional(),
	units: z.array(unitSchema),
	history: z.array(z.unknown()).optional(),
});

const detailsSchema = z.object({
	trace: z.unknown().optional(),
	timedOut: z.boolean().optional(),
	async: z.unknown().optional(),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function outputRef(entry: Readonly<Record<string, unknown>>): string | null {
	if (entry.kind !== "Output") return null;
	const { u, n } = entry;
	return typeof u === "number" && !Number.isNaN(u) && typeof n === "number" && !Number.isNaN(n) ? `${u}:${n}` : null;
}

export type TraceStep = {
	readonly argv: readonly string[];
	readonly resolved: Resolved;
	readonly status: number;
	readonly source: string;
	readonly pipeline: string | null;
	readonly stage: number;
	readonly lastStage: boolean;
	readonly captured: boolean;
	readonly test: boolean;
	readonly statusUsed: boolean;
	readonly output: boolean;
	readonly wrapsBody: boolean;
};

export type ExecutedTrace = { readonly script: string; readonly steps: readonly TraceStep[] };

export type ShellOutcome =
	| { readonly kind: "traced"; readonly trace: ExecutedTrace }
	| { readonly kind: "timedOut"; readonly trace: ExecutedTrace | null }
	| { readonly kind: "interrupted" }
	| { readonly kind: "background" }
	| { readonly kind: "untraced" };

const BODY_BUILTINS: Readonly<Record<string, true>> = { eval: true, source: true, ".": true };
const NOT_STATEMENTS: Readonly<Record<string, true>> = { word: true, assign: true };

const NO_CHILDREN: readonly number[] = [];

function childIndex(nodes: readonly TraceNode[]): ReadonlyMap<number, readonly number[]> {
	const index = new Map<number, number[]>();
	for (const [id, node] of nodes.entries()) {
		if (node.p === undefined || NOT_STATEMENTS[node.k] === true) continue;
		const children = index.get(node.p);
		if (children === undefined) index.set(node.p, [id]);
		else children.push(id);
	}
	for (const children of index.values()) children.sort((a, b) => (nodes[a]?.lo ?? 0) - (nodes[b]?.lo ?? 0));
	return index;
}

const childrenOf = (index: ReadonlyMap<number, readonly number[]>, parent: number): readonly number[] => index.get(parent) ?? NO_CHILDREN;

function isCaptured(nodes: readonly TraceNode[], id: number): boolean {
	for (let parent = nodes[id]?.p; parent !== undefined; parent = nodes[parent]?.p) {
		if (NOT_STATEMENTS[nodes[parent]?.k ?? ""] === true) return true;
	}
	return false;
}

function isCondition(nodes: readonly TraceNode[], children: ReadonlyMap<number, readonly number[]>, list: number): boolean {
	const holder = nodes[list]?.p;
	if (holder === undefined) return false;
	const kind = nodes[holder]?.k;
	const parts = childrenOf(children, holder);
	const index = parts.indexOf(list);
	if (kind === "while" || kind === "until") return index === 0;
	if (kind !== "if") return false;
	const conditions = parts.length % 2 === 1 ? parts.length - 1 : parts.length;
	return index % 2 === 0 && index < conditions;
}

function unitSteps(unit: TraceUnit, u: number, bytesOf: (unit: TraceUnit) => Buffer, outputs: ReadonlySet<string>): TraceStep[] {
	const { nodes } = unit;
	const bytes = bytesOf(unit);
	const index = childIndex(nodes);
	const steps: TraceStep[] = [];
	for (const [id, node] of nodes.entries()) {
		if (node.k !== "simple" || (node.runs ?? 0) <= 0 || node.argv === undefined) continue;
		const parentId = node.p;
		const parent = parentId === undefined ? undefined : nodes[parentId];
		const inPipeline = parentId !== undefined && parent?.k === "pipeline";
		const stages = inPipeline ? childrenOf(index, parentId) : [id];
		const stage = Math.max(0, stages.indexOf(id));
		const lastStage = stage === stages.length - 1;
		const statement = inPipeline ? parentId : id;
		const statementNode = nodes[statement];
		const negated = statementNode !== undefined && statementNode.lo < node.lo && bytes[statementNode.lo] === 0x21;
		const list = statementNode?.p;
		const listParts = list !== undefined && nodes[list]?.k === "and_or" ? childrenOf(index, list) : [];
		const operandUsed = listParts.length > 1 && listParts.indexOf(statement) < listParts.length - 1;
		const test = lastStage && (negated || (list !== undefined && nodes[list]?.k === "and_or" && isCondition(nodes, index, list)));
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
		if (!isRecord(entry) || typeof entry.kind !== "string") return null;
		const ref = outputRef(entry);
		if (ref !== null) outputs.add(ref);
	}
	let scriptBytes: Buffer | null = null;
	const bytesOf = (unit: TraceUnit): Buffer => {
		if (unit.source !== undefined) return Buffer.from(unit.source);
		scriptBytes ??= Buffer.from(script);
		return scriptBytes.subarray(unit.at ?? 0);
	};
	const steps: TraceStep[] = [];
	for (const [u, unit] of units.entries()) if (unit.callout !== true) steps.push(...unitSteps(unit, u, bytesOf, outputs));
	return { trace: { script, steps }, complete: status !== undefined && historyTruncated !== true };
}

export function shellOutcome(details: unknown, isError: boolean): ShellOutcome {
	if (details === undefined || details === null) return isError ? { kind: "interrupted" } : { kind: "untraced" };
	const parsed = detailsSchema.safeParse(details);
	if (!parsed.success) return { kind: "untraced" };
	if (parsed.data.async !== undefined) return { kind: "background" };
	const read = parsed.data.trace === undefined ? null : executedTrace(parsed.data.trace);
	if (parsed.data.timedOut === true) return { kind: "timedOut", trace: read?.trace ?? null };
	return read?.complete ? { kind: "traced", trace: read.trace } : { kind: "untraced" };
}
