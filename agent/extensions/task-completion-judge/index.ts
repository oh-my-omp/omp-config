/**
 * Completion judge for subagents whose definition declares `completionJudge: true`
 * in its frontmatter. It runs inside the subagent's own session and intercepts a
 * terminal `yield` when that run has a structured yield tool. Unstructured task
 * runs have no yield to intercept. A fast model compares the assignment (the `task`
 * prompt the executor recorded in the run's `session_init`, plus the batch's shared
 * context) with the subagent's todo goal, the newest of the tool calls the
 * subagent made after that point (as many as fit a fixed budget) and the
 * submitted result, and decides whether the
 * work was actually finished.
 * A `fork_task` child's transcript opens with a copy of the parent's (or a
 * `from`-named agent's)
 * conversation; everything before its own `session_init` is background, never
 * the assignment or the subagent's work.
 *
 * Per subagent session: the first terminal yield judged NOT done is blocked
 * and the reason goes back to the subagent, which keeps working. A terminal
 * yield judged DONE while a fresh `omp-todo-more:read` projection of that
 * session still has pending or in-progress items is blocked once, asking the subagent
 * to bring the todo list up to date before yielding. Each bounce happens at
 * most once, so one session can see a NOT done bounce and later a todo
 * bounce. The verdict is the reply's leading first-line token: `DONE`,
 * `NOT_DONE` or `NOT DONE`, followed by the end of the line, whitespace or
 * punctuation; the rest of the reply is the reason. It is logged, never
 * attached to the result: the yield's `data` follows the agent's output
 * schema. Once a yield passes, later yields in the same session pass
 * unjudged.
 *
 * Registers `tool_call` and `session_shutdown`; it reads the host-managed
 * session branch for the assignment/tools — the memoized branch view when the
 * host exposes one (its `getBranchView()`), a copied branch through
 * `getBranch()` otherwise — and walks only the suffix after the latest
 * `session_init`, recording call metadata and result entry references without
 * materializing text. Result and assistant text are materialized only for the
 * calls the budget window keeps, plus the yield call's own assistant text;
 * every rendered text passes through the windowing helpers (`stringifyWithin`
 * with each leaf string escaped by JSON.stringify itself, `textWithin`), so a
 * call's allocation stays bounded by the character limits no matter what it
 * carried, sizing rides the same bounded windows, the `§ Context` section is
 * located per system-prompt piece, and the submission is truncated once at
 * its source. Requests the independent Todo owner's synchronous read projection
 * before and after judging. Its model is the OMP model role `@task-completion-judge` (assign
 * it in `/model`), then the `default` role's models, resolved at every
 * judgment, and it writes only in-memory round state. Only subagents whose
 * definition file declares `completionJudge: true` are judged; other
 * subagents and main sessions pass. Every failure (agent not identified,
 * definition not found or unreadable, Todo owner unavailable, no model in
 * either role, every model's provider failing, unparseable answer, deadline)
 * lets that yield pass as written and leaves the round open, so the next
 * terminal yield is judged again. A provider failure moves to the next model
 * of the chain; an unparseable answer does not. The deadline stays under the
 * harness's 30 s `tool_call` handler timeout, which would otherwise block the
 * yield.
 */

import { basename } from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { declaresFlag } from "../_shared/agent-definition.ts";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { completeRoleChain } from "../_shared/role-chain.ts";

/** The OMP model role this extension's judge model comes from: the extension's own name. */
const ROLE = basename(import.meta.dir);

/** Effort when the role entry has no `:level` suffix. */
const EFFORT = THINKING_EFFORTS.find((effort) => effort === "low");
if (EFFORT === undefined) throw new Error("Host thinking efforts do not include low");
const DEADLINE_MS = 25_000;
/** The judge model's input window in tokens; the whole request, system prompt included, must fit it. */
const JUDGE_CONTEXT_TOKENS = 64_000;
/** Headroom for token estimation error and the judge's reply. */
const JUDGE_RESERVED_TOKENS = 4_000;
const ARGS_CHAR_LIMIT = 800;
const RESULT_CHAR_LIMIT = 800;
const SUBMISSION_CHAR_LIMIT = 6_000;

const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must not be empty");
const todoReadSchema = z.union([
	z.object({
		kind: z.literal("ok"),
		goal: z.object({ objective: nonEmpty, measure: nonEmpty, doneWhen: nonEmpty }).nullable(),
		openItems: z.array(z.object({ phase: z.string(), title: z.string(), explanation: z.string().nullable() })),
	}),
	z.object({ kind: z.literal("unavailable") }),
]);
type TodoMoreReadResponse = z.infer<typeof todoReadSchema>;
type ReviewTodo = Extract<TodoMoreReadResponse, { kind: "ok" }>;

/** The owner replies before emit returns; missing or malformed replies are not an empty list. */
function readTodoForReview(pi: ExtensionAPI, agentId: string): TodoMoreReadResponse {
	let value: unknown;
	pi.events.emit("omp-todo-more:read", {
		agentId,
		reply: (response: unknown) => {
			value = response;
		},
	});
	const parsed = todoReadSchema.safeParse(value);
	return parsed.success ? parsed.data : { kind: "unavailable" };
}

function requireReviewTodo(pi: ExtensionAPI, agentId: string): ReviewTodo {
	const response = readTodoForReview(pi, agentId);
	if (response.kind === "unavailable") throw new Error("todo-more review state unavailable");
	return response;
}

const SYSTEM_PROMPT = [
	"You audit whether a worker agent actually completed the assignment it was given.",
	"You receive: the assignment, the shared background context (may be empty), the worker's todo goal (may be absent), the worker's last tool calls with their results in order, and the result the worker is now submitting.",
	"The todo goal is the worker's own restatement of the work: its objective, how it measures the result, and how far it must go to count as done. The assignment stays the standard; the goal adds checks. Answer NOT_DONE when the goal narrows the assignment, when the stated measure was never applied in the tool calls, or when its done-when bar is not met.",
	"Judge from the tool-call evidence, not from the worker's own claims. A claim in the submitted result that no tool call backs up does not count as done.",
	"DONE: everything the assignment asks for was delivered, and the tool calls show it (the edits or artifacts exist, the required commands ran, the required verification ran and passed).",
	"NOT_DONE: a required part is missing or only stubbed; the scope was quietly narrowed; required verification was skipped; a failure or error in the results was ignored; or the submitted result claims work the tool calls do not show.",
	"Only the last tool calls are shown; earlier work may exist. Do not answer NOT_DONE only because early steps are not visible, but the end state the assignment requires must be supported by what is shown or by the submitted result consistently with it.",
	"A worker that honestly reports a blocker it could not get past has not completed the assignment: answer NOT_DONE and name the blocker.",
	"Answer format: the first line is exactly `DONE` or `NOT_DONE`. The following lines give one short paragraph in Chinese with the concrete evidence; for NOT_DONE, name exactly what is missing.",
].join("\n");

// --- boundary schemas: yield input, session entries, yield tool parameters ---

const yieldInputSchema = z
	.object({
		key: z.unknown().optional(),
		error: z.string().nullable().optional(),
		type: z
			.union([z.string(), z.array(z.string())])
			.nullable()
			.optional(),
		data: z.unknown().optional(),
	})
	.passthrough();
type YieldInput = z.infer<typeof yieldInputSchema>;

const toolCallBlockSchema = z
	.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.unknown() })
	.passthrough();

const messageEntrySchema = z
	.object({
		type: z.literal("message"),
		message: z.union([
			z.object({ role: z.literal("assistant"), content: z.array(z.unknown()) }).passthrough(),
			z
				.object({
					role: z.literal("toolResult"),
					toolCallId: z.string(),
					content: z.unknown(),
					isError: z.boolean().optional(),
				})
				.passthrough(),
		]),
	})
	.passthrough();

// --- domain types ---

/** Per subagent session; absent = not judged yet. */
type Round = { readonly kind: "open"; readonly bounced: boolean; readonly todoPrompted: boolean } | { readonly kind: "settled" };

const FIRST_ROUND: Round = { kind: "open", bounced: false, todoPrompted: false };

type Verdict =
	| { readonly kind: "done"; readonly reason: string }
	| { readonly kind: "not_done"; readonly reason: string }
	| { readonly kind: "unknown"; readonly why: string };

/** Terminal yields are judged; incremental sections, error yields, and workpool items pass untouched. */
type YieldCall = { readonly kind: "data" } | { readonly kind: "text" } | { readonly kind: "not_terminal" };

/** One transcript call with references to where its rendered inputs live. */
type ToolCallRecord = { readonly id: string; readonly name: string; readonly args: unknown; readonly assistantEntry: unknown };
/** Result entry refs keyed by call id; the forward walk's last one wins, unchanged. */
type ResultsByCallId = ReadonlyMap<string, { readonly isError: boolean; readonly entry: unknown }>;

type Transcript = {
	/** The latest `session_init`'s task exactly as recorded. */
	readonly assignment: string;
	/** Every call the run made after its latest `session_init`, in branch order. */
	readonly calls: readonly ToolCallRecord[];
	/** Call id → its record; includes the yield call itself. */
	readonly callById: ReadonlyMap<string, ToolCallRecord>;
	readonly resultsByCallId: ResultsByCallId;
};

// --- pure helpers ---

const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	return `${text.slice(0, head)}\n…[${text.length - limit} chars omitted]…\n${text.slice(text.length - tail)}`;
};

/**
 * Bounded `truncate(textOf(content, separator), limit)` in one bounded pass:
 * the head window keeps the first `head` characters, a rolling native
 * `slice(-tail)` string keeps the last `tail`, and the running total drives
 * the omitted count. Byte-identical to the whole-join-then-slice path; the
 * joined middle is never held.
 */
const textWithin = (content: unknown, separator: string, limit: number): string => {
	const blocks: string[] =
		typeof content === "string"
			? [content]
			: !Array.isArray(content)
				? []
				: content.flatMap((block) =>
						typeof block === "object" &&
						block !== null &&
						"type" in block &&
						block.type === "text" &&
						"text" in block &&
						typeof block.text === "string"
							? [block.text]
							: [],
					);
	if (blocks.length === 0) return "";
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	let kept = "";
	let tailWindow = "";
	let totalLength = 0;
	for (let index = 0; index < blocks.length; index++) {
		const piece = index === 0 ? (blocks[index] ?? "") : separator + (blocks[index] ?? "");
		totalLength += piece.length;
		if (kept.length < head) {
			if (piece.length + kept.length <= head) {
				kept += piece;
			} else {
				kept += piece.slice(0, head - kept.length);
			}
		}
		if (tail > 0) tailWindow = (tailWindow + piece).slice(-tail);
	}
	if (totalLength <= limit) return blocks.join(separator);
	return `${kept}\n…[${totalLength - limit} chars omitted]…\n${tailWindow}`;
};

/** A message entry's `content` array, or undefined when the entry shape differs. */
const contentOf = (entry: unknown): readonly unknown[] | undefined => {
	if (typeof entry !== "object" || entry === null) return undefined;
	if (!("message" in entry)) return undefined;
	const message = (entry as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return undefined;
	if (!("content" in message)) return undefined;
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content : undefined;
};

/** `textOf(content)` with the empty-string separator: the exact joined text, or "" for non-text content. */
const textOfExactly = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		)
			texts.push(block.text);
	}
	return texts.join("");
};

/**
 * Conservative token estimate without a tokenizer: one token per ASCII character
 * and two per other character. Calibrated against the judge helper's
 * `max_tokens_exceeded` boundary: CJK text failed at about 32k characters (two
 * tokens each), and code-like ASCII at about 91k characters, so one token per
 * ASCII character leaves margin; prose ASCII passed at about 196k.
 */
const estimateTokens = (text: string): number => {
	let tokens = 0;
	for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 : 2;
	return tokens;
};

/** Streaming writer that mirrors JSON.stringify byte for byte. Shared by the length probe and both bounded window passes. */
function walkJson(value: unknown, emit: (part: string) => void, stack: readonly unknown[]): void {
	for (const seen of stack) if (seen === value) throw new TypeError("Converting circular structure to JSON");
	if (value === null) {
		emit("null");
		return;
	}
	switch (typeof value) {
		case "boolean":
			emit(value ? "true" : "false");
			return;
		case "number":
			emit(Number.isFinite(value) ? String(value) : "null");
			return;
		case "string": {
			// Leaf escaping is exactly JSON.stringify's own: call it on the string
			// and let the emit windows do the bounding — whole-leaf transient like
			// the old whole-serialize path, never joined across leaves.
			const leaf = JSON.stringify(value) as string;
			emit(leaf);
			return;
		}
		case "bigint":
			throw new TypeError("Do not know how to serialize a BigInt");
		case "object":
			break;
		default:
			// undefined / function / symbol at a value position: JSON.stringify
			// returns undefined and the callers substitute String(value); only
			// a top-level leaf reaches this branch, so throw into that path.
			throw new TypeError("top-level undefined");
	}
	if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
		walkJson((value as { toJSON: (key?: string) => unknown }).toJSON(""), emit, stack);
		return;
	}
	if (Array.isArray(value)) {
		const inner: readonly unknown[] = [...stack, value];
		emit("[");
		let first = true;
		for (const item of value) {
			if (!first) emit(",");
			first = false;
			if (item === undefined || typeof item === "function" || typeof item === "symbol") emit("null");
			else walkJson(item, emit, inner);
		}
		emit("]");
		return;
	}
	const inner: readonly unknown[] = [...stack, value];
	emit("{");
	let firstProp = true;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
		if (!firstProp) emit(",");
		firstProp = false;
		emit(JSON.stringify(key) as string);
		emit(":");
		walkJson(item, emit, inner);
	}
	emit("}");
}

/**
 * Bounded `truncate(JSON.stringify(value) ?? String(value), limit)` in one
 * pass: the walker streams the exact JSON.stringify sequence — each leaf
 * string through JSON.stringify itself (toJSON with its key argument,
 * array `null`-ification, undefined/function/symbol property skips, cycle
 * and BigInt throws, `String(value)` fallback) — while emit keeps the first
 * `head` characters, a rolling native `slice(-tail)` string keeps the last
 * `tail`, and the running total drives the omitted count. The screens meet
 * in the middle once, so the short case reassembles the whole text without
 * a second walk; the whole serialization is never held (F106/F107).
 */
const stringifyWithin = (value: unknown, limit: number): string => {
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	try {
		let seen = 0;
		let held = "";
		let tailBuffer = "";
		const emit = (part: string): void => {
			seen += part.length;
			if (held.length < head) held += part.length + held.length <= head ? part : part.slice(0, head - held.length);
			if (tail > 0) tailBuffer = (tailBuffer + part).slice(-tail);
		};
		walkJson(value, emit, []);
		if (seen <= limit) return tail > 0 && seen > head ? held + tailBuffer.slice(Math.max(0, head - (seen - tailBuffer.length))) : held;
		return `${held}\n…[${seen - limit} chars omitted]…\n${tailBuffer}`;
	} catch {
		return truncate(String(value), limit);
	}
};
const classifyYield = (input: YieldInput): YieldCall => {
	if (input.key !== undefined && input.key !== null) return { kind: "not_terminal" };
	if (typeof input.error === "string" && input.error.trim() !== "") return { kind: "not_terminal" };
	if (Array.isArray(input.type)) return { kind: "not_terminal" };
	return input.data === undefined || input.data === null ? { kind: "text" } : { kind: "data" };
};

/**
 * The branch, newest-last. `getBranchView()` is the host's memoized
 * active-leaf branch, handed out read-only without a copy; `getBranch()`
 * copies. Prefer the view, fall back to the copy on hosts that narrow the
 * extension type.
 */
const branchEntries = (ctx: ExtensionContext): readonly unknown[] => {
	const manager = ctx.sessionManager as unknown as {
		readonly getBranchView?: () => readonly unknown[];
		readonly getBranch?: () => readonly unknown[];
	};
	if (typeof manager.getBranchView === "function") return manager.getBranchView();
	if (typeof manager.getBranch === "function") return manager.getBranch();
	return [];
};

/**
 * The run's own transcript: the branch suffix from the latest `session_init`
 * on. A single forward pass records each call with its arguments plus
 * references to its assistant entry and its result entry — text is never
 * materialized here, the render layer below resolves the kept calls only,
 * so allocation stays proportional to the prompt's window rather than the
 * run's length. Entries the old whole-branch `safeParse` walk skipped —
 * null entries, entries without a `message`, messages outside the boundary
 * schema, `message: null` — are skipped the same way, so the visible
 * transcript and the choice of the latest `session_init` are unchanged.
 */
const readTranscript = (ctx: ExtensionContext): Transcript | undefined => {
	const view = branchEntries(ctx);
	// Latest `session_init` first: everything at or before it is background.
	// Structural match (`type: "session_init"` with a string `task`),
	// identical to the schema the forward walk used.
	let start = -1;
	for (let index = view.length - 1; index >= 0; index--) {
		const entry: unknown = view[index];
		if (
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "session_init" &&
			"task" in entry &&
			typeof (entry as { task?: unknown }).task === "string"
		) {
			start = index;
			break;
		}
	}
	if (start === -1) return undefined;
	const initEntry = view[start] as unknown as { task: string };
	const assignment = initEntry.task;
	const calls: ToolCallRecord[] = [];
	const resultsByCallId = new Map<string, { readonly isError: boolean; readonly entry: unknown }>();
	for (let index = start + 1; index < view.length; index++) {
		// A null/malformed entry is skipped like the schema's safeParse skip; a
		// `message: null` entry parses as neither variant and is skipped too.
		const entry: unknown = view[index];
		if (entry === null || typeof entry !== "object") continue;
		const parsed = messageEntrySchema.safeParse(entry);
		if (!parsed.success) continue;
		const message = parsed.data.message;
		switch (message.role) {
			case "assistant":
				for (const block of message.content) {
					const call = toolCallBlockSchema.safeParse(block);
					if (!call.success) continue;
					calls.push({ id: call.data.id, name: call.data.name, args: call.data.arguments, assistantEntry: entry });
				}
				break;
			case "toolResult":
				resultsByCallId.set(message.toolCallId, { isError: message.isError === true, entry: message.content });
				break;
			default: {
				const unexpected: never = message;
				throw new Error(`Unexpected transcript message: ${unexpected}`);
			}
		}
	}
	const callById = new Map<string, ToolCallRecord>();
	for (const call of calls) callById.set(call.id, call);
	return { assignment, calls, callById, resultsByCallId };
};

/**
 * The batch's shared `context` is rendered into the subagent system prompt as its
 * `§ Context` section — located and extracted without joining the whole prompt
 * (F108). Extraction equals `getSystemPrompt().join("\n")` + `indexOf("§ Context\n")`
 * + slice to the next `"\n§ "` heading + `trim()`: marker and heading each hold
 * exactly one `"\n"`, the same character the join uses as the separator, so a
 * straddling match must carry its `"\n"` on a seam. A piece-internal `indexOf`
 * match always starts earlier in the stream than a seam after the same piece, so
 * the scan checks each piece directly and each seam with `endsWith`/`startsWith`.
 */
const sharedContextOf = (ctx: ExtensionContext): string => {
	const pieces = ctx.getSystemPrompt();
	const marker = "§ Context\n";
	const markerNoNl = "§ Context";
	/** The body joined from the section pieces; a `"\n§ "` heading inside one of them, or one whose text opens after the seam with `"§ "`, ends the body exactly where the whole-join path would slice it. */
	const bodyFrom = (firstPiece: string, restIndex: number): string => {
		let accumulated = "";
		let open = true; // nothing consumed yet: the next piece contributes without a seam
		for (let index = restIndex; index < pieces.length; index++) {
			const piece = pieces[index] ?? "";
			// From the second piece on, a piece opening with "§ " carries the
			// heading's "\n" on the seam before it: the body ends there.
			if (!open && piece.startsWith("§ ")) return accumulated.slice(0, accumulated.length - 1).trim();
			const inside = piece.indexOf("\n§ ");
			if (inside !== -1) return (accumulated + piece.slice(0, inside)).trim();
			accumulated += open ? firstPiece : `\n${piece}`;
			open = false;
		}
		return accumulated.trim();
	};
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index] ?? "";
		const at = piece.indexOf(marker);
		if (at !== -1) return bodyFrom(piece.slice(at + marker.length), index + 1);
		// Straddling: this piece ends with the marker's text, the seam carries
		// the marker's "\n", the body starts inside the next piece.
		if (index + 1 < pieces.length && piece.endsWith(markerNoNl)) return bodyFrom("", index + 1);
	}
	return "";
};

/**
 * One rendered tool call: args and result truncation happen at their
 * serialization boundaries (see `stringifyWithin` and `textWithin`), so a
 * call's rendered text is bounded by ARGS_CHAR_LIMIT and
 * RESULT_CHAR_LIMIT plus their markers regardless of what the call carried.
 */
const renderCall = (call: ToolCallRecord, n: number, results: ResultsByCallId): string => {
	const result = results.get(call.id);
	const status = result === undefined ? "no result" : result.isError ? "error" : "ok";
	return [
		`<call n="${n}" tool="${call.name}" status="${status}">`,
		`<args>${stringifyWithin(call.args, ARGS_CHAR_LIMIT)}</args>`,
		`<result>${result === undefined ? "" : textWithin(result.entry, "", RESULT_CHAR_LIMIT)}</result>`,
		"</call>",
	].join("\n");
};

/**
 * `estimateTokens` over the exact `truncate(serialized, limit)` output,
 * computed from a single streaming pass: the emit keeps the first `limit`
 * characters (the head window), a bounded rolling `slice(-tail)` string keeps
 * the last `tail`, and the running total drives the omitted count. The middle
 * is never held, and the token weights come from the two windows alone. Byte
 * weights equal the render pass's, so the budget walk keeps the same calls
 * windowed by `fitToolCalls`, and a call that falls outside the window never
 * materializes its text.
 */
const truncatedTokensOf = (
	produce: (emit: (piece: string) => void) => void,
	limit: number,
	// Walk fails only on cycles and BigInt; then String(value) keeps the old
	// fallback shape and the caller passes the value for it.
	fallbackValue: unknown,
): number => {
	try {
		const head = Math.ceil(limit * 0.6);
		const tail = limit - head;
		let seen = 0;
		let held = ""; // leading window, up to `head` characters
		let tailBuffer = ""; // trailing window, last `tail` characters when tail > 0
		const emit = (piece: string): void => {
			seen += piece.length;
			if (held.length < head) held += piece.length + held.length <= head ? piece : piece.slice(0, head - held.length);
			if (tail > 0) tailBuffer = (tailBuffer + piece).slice(-tail);
		};
		produce(emit);
		if (seen <= limit) {
			// Short serialization: the render is the whole serialization. Both
			// windows hold a single unbroken coordinate range of it — the first
			// `head` characters in `held`, the last min(`tail`, seen) in
			// `tailBuffer` — and their overlap closes exactly once in the middle
			// when they meet; appending the tail's slice past `held`'s end
			// rebuilds the full text with no second walk.
			return estimateTokens(tail > 0 && seen > head ? held + tailBuffer.slice(Math.max(0, head - (seen - tailBuffer.length))) : held);
		}
		const marker = `\n…[${seen - limit} chars omitted]…\n`;
		return estimateTokens(held) + estimateTokens(marker) + estimateTokens(tailBuffer);
	} catch {
		// Cycles and BigInt: String(value) keeps the old fallback shape.
		return estimateTokens(truncate(String(fallbackValue), limit));
	}
};

/**
 * Exact `estimateTokens` the budget walk needs, per call, without rendering the
 * call: the fixed header glue's weight, plus both bounded windows (args through
 * the JSON walk, result through the text blocks) via `truncatedTokensOf`. A
 * call value walks once here; texts materialize only through the windows, and
 * the walk's `String()` fallback reads the source text only when the walk itself
 * failed (D3: a call outside the window never holds its text).
 */
const renderedCallTokens = (call: ToolCallRecord, n: number, results: ResultsByCallId): number => {
	const result = results.get(call.id);
	const status = result === undefined ? "no result" : result.isError ? "error" : "ok";
	const headerTokens = estimateTokens(`<call n="${n}" tool="${call.name}" status="${status}">\n<args></args>\n<result></result>\n</call>`);
	const argsTokens = truncatedTokensOf((emit) => walkJson(call.args, emit, []), ARGS_CHAR_LIMIT, call.args);
	const resultTokens = result === undefined ? 0 : truncatedTokensOf(emitStringBlocks(result.entry), RESULT_CHAR_LIMIT, result.entry);
	return headerTokens + argsTokens + resultTokens;
};
const emitStringBlocks =
	(content: unknown) =>
	(emit: (piece: string) => void): void => {
		if (typeof content === "string") {
			emit(content);
			return;
		}
		if (Array.isArray(content)) {
			for (const block of content) {
				if (
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "text" &&
					"text" in block &&
					typeof block.text === "string"
				)
					emit(block.text);
			}
			return;
		}
		emit("");
	};

/**
 * The history is filled from the newest call backwards until the next call
 * would push the request past `budget` estimated tokens. The first call that
 * does not fit ends the walk: what is kept is the newest unbroken run, in
 * chronological order. Numbers count every prior call, so a gap in `n` marks
 * dropped calls. Sizing uses exact rendered lengths rather than rendering
 * every call first — calls outside the window never have their argument
 * objects or result entries read.
 */
const fitToolCalls = (prior: readonly ToolCallRecord[], results: ResultsByCallId, budget: number): readonly ToolCallRecord[] => {
	const newestFirst = prior.map((call, index) => ({ call, n: index + 1 })).reverse();
	const kept: ToolCallRecord[] = [];
	let used = 0;
	for (const { call, n } of newestFirst) {
		const tokens = renderedCallTokens(call, n, results);
		if (used + tokens > budget) break;
		used += tokens;
		kept.push(call);
	}
	return kept.reverse();
};

const renderPrompt = (ctx: ExtensionContext, transcript: Transcript, yieldCallId: string, submission: string, todo: ReviewTodo): string => {
	const prior = transcript.calls.filter((call) => call.id !== yieldCallId);
	const frame = (calls: readonly string[], shown: number): string =>
		[
			"<assignment>",
			transcript.assignment.trim() || "(missing)",
			"</assignment>",
			"<shared-context>",
			sharedContextOf(ctx) || "(none)",
			"</shared-context>",
			"<worker-goal>",
			todo.goal === null ? "(none)" : `Objective: ${todo.goal.objective}\nMeasure: ${todo.goal.measure}\nDone when: ${todo.goal.doneWhen}`,
			"</worker-goal>",
			`<tool-calls shown="${shown}" total="${prior.length}">`,
			...calls,
			"</tool-calls>",
			"<submitted-result>",
			submission,
			"</submitted-result>",
		].join("\n");
	// Everything but the tool calls is counted first; the calls get what is left of the window.
	const fixedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(frame([], 0));
	const budget = JUDGE_CONTEXT_TOKENS - JUDGE_RESERVED_TOKENS - fixedTokens;
	const window = fitToolCalls(prior, transcript.resultsByCallId, budget);
	// Rendering happens only for the kept window; a dropped call's text is
	// never materialized. Each call's rendering walks its own bounded inputs.
	const calls = window.map((call, index) => renderCall(call, prior.length - window.length + index + 1, transcript.resultsByCallId));
	return frame(calls, calls.length);
};
/**
 * The verdict is the first line's leading token: `DONE`, `NOT_DONE` or `NOT DONE`
 * (one ASCII space), after trimming and removing wrapping backticks/asterisks,
 * compared case-insensitively. The token must be followed by the end of the
 * line, whitespace, or Unicode punctuation other than `_` (an identifier
 * character, so `NOT_DONE_X` is not a verdict). Whatever follows the token on
 * that line, leading separators stripped, joins the remaining lines as the
 * reason. Anything else is an unparseable answer.
 */
const VERDICT_HEAD = /^(NOT DONE|NOT_DONE|DONE)(?=$|(?!_)[\s\p{P}])/u;

const parseAnswer = (text: string): Verdict => {
	const lines = text.trim().split("\n");
	const lead = (lines[0] ?? "").trim().replace(/^[`*\s]+/, "");
	const head = lead.replace(/[`*\s]+$/, "").toUpperCase();
	const match = VERDICT_HEAD.exec(head);
	if (match === null) return { kind: "unknown", why: `unparseable answer: ${text.slice(0, 80)}` };
	// The token is ASCII, so its length is the same offset in the un-uppercased lead.
	const rest = lead.slice(match[0].length).replace(/^[`*\s\p{P}]+/u, "");
	const reason = [rest, ...lines.slice(1)].join("\n").trim();
	return match[1] === "DONE" ? { kind: "done", reason } : { kind: "not_done", reason };
};

const judge = async (ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<Verdict> => {
	const reply = await completeRoleChain(ctx, [ROLE, "default"], SYSTEM_PROMPT, prompt, EFFORT, signal, { kind: "whole" }, () => true);
	switch (reply.kind) {
		case "text":
			return parseAnswer(reply.text);
		case "no-model":
			return { kind: "unknown", why: `no model: assign @${ROLE} or the default role in /model` };
		case "deadline":
			return { kind: "unknown", why: "deadline" };
		case "aborted":
			return { kind: "unknown", why: "aborted" };
		case "all-failed":
			return { kind: "unknown", why: `every model failed: ${reply.failures.join("; ")}` };
		case "error":
			return { kind: "unknown", why: errorText(reply.error) };
		default: {
			const unreachable: never = reply;
			return unreachable;
		}
	}
};

/** Pending or in-progress items of the session's own todo list, with their explanations. */
const openTodoItems = (todo: ReviewTodo): string[] =>
	todo.openItems.map(
		({ phase, title, explanation }) => `${phase}: ${title} — ${explanation ?? "(no explanation yet: add one with op explain)"}`,
	);

export default function taskCompletionJudge(pi: ExtensionAPI): void {
	const rounds = new Map<string, Round>();

	const review = async (
		toolCallId: string,
		rawInput: unknown,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> => {
		if (ctx.agent.kind !== "sub") return undefined;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile === undefined) return undefined;
		const round = rounds.get(sessionFile) ?? FIRST_ROUND;
		if (round.kind === "settled") return undefined;
		const parsedInput = yieldInputSchema.safeParse(rawInput);
		if (!parsedInput.success) return undefined;
		const input = parsedInput.data;
		const call = classifyYield(input);
		if (call.kind === "not_terminal") return undefined;
		// Task session files are `<artifacts>/<agent-id>.jsonl`; the registry ref carries the agent definition name.
		const ref = AgentRegistry.global()
			.list()
			.find((candidate) => candidate.sessionFile === sessionFile);
		if (ref === undefined) return undefined;
		const agentName = ref.displayName;
		// The caller's session is the spawning session: the same cwd, extension
		// roots and session agents the task tool's spawn preflight resolved the
		// definition against.
		if (!(await declaresFlag(callerSession(ctx), ctx.sessionManager.getCwd(), agentName, "completionjudge"))) return undefined;

		const transcript = readTranscript(ctx);
		if (transcript === undefined) {
			// No recorded assignment to judge against: let this and later yields pass.
			pi.logger.info("task-completion-judge skipped: no session_init on branch", { agentName });
			rounds.set(sessionFile, { kind: "settled" });
			return undefined;
		}
		// The submission is truncated exactly once, here at its source (D9): the
		// text kind is the yield call's own assistant message text, the data kind
		// the bounded serialization of `input.data` — `stringifyWithin` at the
		// submission limit already outputs the exact `truncate(whole, limit)`
		// shape, so the frame takes `submission` verbatim.
		const yieldEntry = transcript.callById.get(toolCallId)?.assistantEntry;
		const submission =
			call.kind === "text"
				? truncate(textOfExactly(contentOf(yieldEntry)), SUBMISSION_CHAR_LIMIT)
				: stringifyWithin(input.data, SUBMISSION_CHAR_LIMIT);
		const todo = requireReviewTodo(pi, ctx.agent.id);
		const verdict = await judge(ctx, renderPrompt(ctx, transcript, toolCallId, submission, todo), AbortSignal.timeout(DEADLINE_MS));
		pi.logger.info("task-completion-judge verdict", {
			agent: basename(sessionFile, ".jsonl"),
			agentName,
			bounced: round.bounced,
			todoPrompted: round.todoPrompted,
			...verdict,
		});

		switch (verdict.kind) {
			case "unknown":
				// No conclusion this time: only this yield passes; the next
				// terminal yield is judged again.
				return undefined;
			case "not_done":
				if (!round.bounced) {
					rounds.set(sessionFile, { ...round, bounced: true });
					const reason = [
						"完成度鉴定：对照最初的任务和你最近的 tool call，这次任务还没有真正完成，yield 被退回。",
						verdict.reason || "(鉴定未给出具体原因)",
						"补完缺失的部分并实际验证后再 yield。之后不会再因完成度退回。",
					].join("\n");
					return { block: true, reason };
				}
				break;
			case "done":
				break;
			default: {
				const unexpected: never = verdict;
				throw new Error(`Unexpected completion verdict: ${unexpected}`);
			}
		}
		const currentTodo = requireReviewTodo(pi, ctx.agent.id);
		const openItems = verdict.kind === "done" && !round.todoPrompted ? openTodoItems(currentTodo) : [];
		if (openItems.length > 0) {
			rounds.set(sessionFile, { ...round, todoPrompted: true });
			const reason = [
				"完成度鉴定：这次任务已经完成，但你的 todo 里还有未完成的项，yield 被退回：",
				...openItems.map((item) => `- ${item}`),
				"先维护 todo，让它反映真实进度，再调用 yield。",
			].join("\n");
			return { block: true, reason };
		}
		rounds.set(sessionFile, { kind: "settled" });
		return undefined;
	};

	// A throwing tool_call handler blocks the tool, so every failure lets the yield run.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "yield") return undefined;
		try {
			return await review(event.toolCallId, event.input, ctx);
		} catch (error) {
			pi.logger.warn("task-completion-judge skipped a yield", { error: errorText(error) });
			return undefined;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile !== undefined) rounds.delete(sessionFile);
		} catch (error) {
			pi.logger.warn("task-completion-judge could not clear session state", { error: errorText(error) });
		}
	});
}
