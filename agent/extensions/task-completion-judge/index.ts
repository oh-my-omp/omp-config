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
 * materializing text. Each call the budget keeps is rendered once, from its
 * arguments and result through `stringifyWithin` and `textWithin`, which keep
 * only the bounded head and tail of their output, so a call's allocation stays
 * bounded by the character limits no matter what it carried. The first call that
 * does not fit the budget is rendered as well, then dropped. The `§ Context`
 * section is located per system-prompt piece, and the submission is truncated
 * once at its source. Requests the independent Todo owner's synchronous read
 * projection before and after judging. Its model is the OMP model role
 * `@task-completion-judge` (assign it in `/model`), then the `default` role's
 * models, resolved at every judgment, and it writes only in-memory round state.
 * Only subagents whose definition file declares `completionJudge: true` are
 * judged; other subagents and main sessions pass. Every failure (agent not
 * identified, definition not found or unreadable, Todo owner unavailable, no
 * model in either role, every model's provider failing, unparseable answer,
 * deadline) lets that yield pass as written and leaves the round open, so the
 * next terminal yield is judged again. A provider failure moves to the next
 * model of the chain; an unparseable answer does not. The deadline stays under
 * the harness's 30 s `tool_call` handler timeout, which would otherwise block the
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
/** Mixed array items written per native JSON.stringify call while they are primitives. */
const PRIMITIVE_RUN = 256;

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
 * `truncate` of the text `produce` emits, in one pass that never holds the whole
 * text. The first `head` characters are kept as they arrive. The last `tail`
 * characters come from buffered pieces that are merged back down to `tail`
 * whenever they pass twice `tail`, so each emitted character is copied a
 * bounded number of times. The result equals `truncate(joined, limit)`.
 */
const boundedText = (produce: (emit: (part: string) => void) => void, limit: number): string => {
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	let seen = 0;
	let held = "";
	let tailParts: string[] = [];
	let tailLength = 0;
	const emit = (part: string): void => {
		seen += part.length;
		if (held.length < head) held += part.length + held.length <= head ? part : part.slice(0, head - held.length);
		if (tail === 0) return;
		// A piece at least as long as the window holds the last `tail` characters on its own: it replaces the buffer without being joined.
		if (part.length >= tail) {
			tailParts = [part.slice(-tail)];
			tailLength = tail;
			return;
		}
		tailParts.push(part);
		tailLength += part.length;
		if (tailLength > 2 * tail) {
			const merged = tailParts.join("").slice(-tail);
			tailParts = [merged];
			tailLength = merged.length;
		}
	};
	produce(emit);
	const trailing = tail === 0 ? "" : tailParts.join("").slice(-tail);
	// Short text: `held` plus the trailing characters past `head` is the whole text.
	if (seen <= limit) return tail > 0 && seen > head ? held + trailing.slice(Math.max(0, head - (seen - trailing.length))) : held;
	return `${held}\n…[${seen - limit} chars omitted]…\n${trailing}`;
};

/** The text of a `{ type: "text", text }` content block, or undefined for any other block. */
const textBlockOf = (block: unknown): string | undefined =>
	typeof block === "object" &&
	block !== null &&
	"type" in block &&
	block.type === "text" &&
	"text" in block &&
	typeof block.text === "string"
		? block.text
		: undefined;

/**
 * `truncate(textOf(content, separator), limit)` in one bounded pass. A string is
 * its own text; an array contributes its text blocks joined by `separator`;
 * anything else has no text.
 */
const textWithin = (content: unknown, separator: string, limit: number): string =>
	boundedText((emit) => {
		if (typeof content === "string") {
			emit(content);
			return;
		}
		if (!Array.isArray(content)) return;
		let first = true;
		for (const block of content) {
			const text = textBlockOf(block);
			if (text === undefined) continue;
			if (!first) emit(separator);
			first = false;
			emit(text);
		}
	}, limit);

/** A message entry's `content` array, or undefined when the entry shape differs. */
const contentOf = (entry: unknown): readonly unknown[] | undefined => {
	if (typeof entry !== "object" || entry === null || !("message" in entry)) return undefined;
	const message = entry.message;
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	return Array.isArray(message.content) ? message.content : undefined;
};

/** The exact joined text of a message content (no separator), or "" for non-text content. */
const textOfExactly = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) text += textBlockOf(block) ?? "";
	return text;
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

/** Whether JSON.stringify writes a resolved value; undefined, functions and symbols are skipped or nulled by their holder. */
const isSerializable = (value: unknown): boolean => value !== undefined && typeof value !== "function" && typeof value !== "symbol";

/** Whether a native primitive `valueOf` finds the internal slot of `value`; it throws on any other object. */
const hasSlot = (read: () => unknown): boolean => {
	try {
		read();
		return true;
	} catch {
		// Expected for an ordinary object or a wrapper of another kind: it serializes as itself.
		return false;
	}
};

/**
 * The primitive JSON.stringify writes for a boxed Number, String, Boolean or
 * BigInt, matched by internal slot; any other object is returned as is. Number
 * and String go through ToNumber and ToString, Boolean and BigInt yield their
 * slot value. A boxed BigInt yields a bigint, which the walk rejects.
 */
const unboxed = (value: object): unknown => {
	if (value instanceof Number && hasSlot(() => Number.prototype.valueOf.call(value))) return +value;
	if (value instanceof String && hasSlot(() => String.prototype.valueOf.call(value))) return `${value}`;
	if (value instanceof Boolean && hasSlot(() => Boolean.prototype.valueOf.call(value))) return Boolean.prototype.valueOf.call(value);
	if (value instanceof BigInt && hasSlot(() => BigInt.prototype.valueOf.call(value))) return BigInt.prototype.valueOf.call(value);
	return value;
};

/** Whether `value` is an object or function with a `toJSON` property; its value is checked by the caller. */
const hasToJSON = (value: unknown): value is { readonly toJSON: unknown } =>
	((typeof value === "object" && value !== null) || typeof value === "function") && "toJSON" in value;

/**
 * The value JSON.stringify serializes in place of `value` under `key`: a
 * property name, an array index, or "" at the top. A value with a callable
 * `toJSON` (an object, function or bigint) gives `toJSON(String(key))`, called
 * once and not applied again to its result; an object result is then `unboxed`.
 * The result may still be undefined, a function or a symbol.
 */
const resolveValue = (value: unknown, key: string | number): unknown => {
	// A bigint has no own toJSON; its box reads BigInt.prototype's, and the call keeps the primitive as `this`.
	const holder: unknown = typeof value === "bigint" ? Object(value) : value;
	const jsonValue: unknown = hasToJSON(holder) && typeof holder.toJSON === "function" ? holder.toJSON.call(value, String(key)) : value;
	return typeof jsonValue === "object" && jsonValue !== null ? unboxed(jsonValue) : jsonValue;
};

/** Whether JSON.stringify writes this item without calling toJSON or walking into it. */
const isPrimitiveItem = (item: unknown): boolean =>
	item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean";

/** The end of the run of primitive items that starts at `from`, at most PRIMITIVE_RUN long. */
const primitiveRunEnd = (items: readonly unknown[], from: number): number => {
	let end = from;
	while (end < items.length && end - from < PRIMITIVE_RUN && isPrimitiveItem(items[end])) end++;
	return end;
};

/**
 * Streaming writer for `JSON.stringify`'s output. `value` is already resolved by
 * `resolveValue` and passes `isSerializable`; each child is resolved with its own
 * key before it is written, so no toJSON runs twice on one value. An array of
 * only primitives is one native JSON.stringify call. In other arrays, runs of
 * primitive items are written by native calls and every other item goes through
 * the walk.
 */
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
		case "string":
			emit(JSON.stringify(value));
			return;
		case "bigint":
			throw new TypeError("Do not know how to serialize a BigInt");
		case "object":
			break;
		case "undefined":
		case "function":
		case "symbol":
			throw new TypeError("walkJson needs a serializable value");
	}
	const inner: readonly unknown[] = [...stack, value];
	if (Array.isArray(value)) {
		const items: readonly unknown[] = value;
		// Holes are null in JSON.stringify and `every` skips them, so the whole array is native output.
		if (items.every(isPrimitiveItem)) {
			emit(JSON.stringify(items));
			return;
		}
		emit("[");
		let first = true;
		let index = 0;
		while (index < items.length) {
			if (!first) emit(",");
			first = false;
			const runEnd = primitiveRunEnd(items, index);
			if (runEnd > index) {
				emit(JSON.stringify(items.slice(index, runEnd)).slice(1, -1));
				index = runEnd;
				continue;
			}
			const item = resolveValue(items[index], index);
			if (isSerializable(item)) walkJson(item, emit, inner);
			else emit("null");
			index++;
		}
		emit("]");
		return;
	}
	emit("{");
	let firstProp = true;
	const entries: [string, unknown][] = Object.entries(value);
	for (const [key, held] of entries) {
		const item = resolveValue(held, key);
		if (!isSerializable(item)) continue;
		if (!firstProp) emit(",");
		firstProp = false;
		emit(JSON.stringify(key));
		emit(":");
		walkJson(item, emit, inner);
	}
	emit("}");
}

/**
 * Streams `JSON.stringify(value)` for a top-level value. Throws when that is
 * undefined, so the caller substitutes `String(value)` as `stringify` does.
 */
function walkTop(value: unknown, emit: (part: string) => void): void {
	const resolved = resolveValue(value, "");
	if (!isSerializable(resolved)) throw new TypeError("top-level value has no JSON form");
	walkJson(resolved, emit, []);
}

/**
 * `truncate(JSON.stringify(value) ?? String(value), limit)` in one bounded pass
 * over `walkTop`'s output. For JSON-parsed values, which is what the transcript
 * holds, the result is byte-identical to that expression. A value with a toJSON,
 * boxed primitives or undefined members is walked by JSON.stringify's rules, but
 * a toJSON that mutates the value it serializes is not covered. A value with no
 * JSON form, a cycle, a BigInt or a throwing toJSON takes the `String(value)`
 * fallback.
 */
const stringifyWithin = (value: unknown, limit: number): string => {
	try {
		return boundedText((emit) => walkTop(value, emit), limit);
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
 * copies. Prefer the view, fall back to the copy on hosts that do not expose it.
 * A host result that is not an array counts as an empty branch.
 */
const branchEntries = (ctx: ExtensionContext): readonly unknown[] => {
	const manager: unknown = ctx.sessionManager;
	if (typeof manager !== "object" || manager === null) return [];
	const view: unknown =
		"getBranchView" in manager && typeof manager.getBranchView === "function"
			? manager.getBranchView()
			: "getBranch" in manager && typeof manager.getBranch === "function"
				? manager.getBranch()
				: [];
	return Array.isArray(view) ? view : [];
};

/**
 * The run's own transcript: the branch suffix from the latest `session_init`
 * on. A single forward pass records each call with its arguments plus
 * references to its assistant entry and its result entry. Text is never
 * materialized here; the render layer resolves only the calls it keeps. Entries
 * that are null, have no `message`, fall outside the message schema, or carry
 * `message: null` are skipped, so they never affect the assignment or the calls.
 */
const readTranscript = (ctx: ExtensionContext): Transcript | undefined => {
	const view = branchEntries(ctx);
	// Latest `session_init` first: everything at or before it is background.
	// Structural match (`type: "session_init"` with a string `task`).
	let start = -1;
	let assignment = "";
	for (let index = view.length - 1; index >= 0; index--) {
		const entry: unknown = view[index];
		if (
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "session_init" &&
			"task" in entry &&
			typeof entry.task === "string"
		) {
			start = index;
			assignment = entry.task;
			break;
		}
	}
	if (start === -1) return undefined;
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
 * (F108). The extraction equals `getSystemPrompt().join("\n")`, then
 * `indexOf("§ Context\n")`, then the slice up to the next `"\n§ "` heading, then
 * `trim()`. The marker and the heading each hold exactly one `"\n"`, the character
 * the join puts between pieces, so a marker that straddles a seam is one whose
 * text ends a piece, its `"\n"` being that seam. A match inside a piece starts
 * before the seam after it, so each piece is checked with `indexOf` before the
 * seam after it is checked with `endsWith`.
 */
const sharedContextOf = (ctx: ExtensionContext): string => {
	const pieces = ctx.getSystemPrompt();
	const marker = "§ Context\n";
	const bodyEnd = "\n§ ";
	/**
	 * `carry` is the body text that begins right after the marker: the rest of
	 * the marker's own piece, or the next piece when the marker straddled a seam.
	 * `restIndex` is the first piece after the one `carry` comes from. The body is
	 * `carry`, then each later piece after a seam `"\n"`, stopped by the heading.
	 * The heading's `"\n"` lies inside the carry, inside a later piece, or on the
	 * seam before a later piece whose text opens with `"§ "`.
	 */
	const bodyOf = (carry: string, restIndex: number): string => {
		// The body is the carry, then each later piece after a seam "\n". The
		// heading may cut the carry itself, cut a later piece, or ride the seam
		// into a piece that opens with "§ ".
		const headingInCarry = carry.indexOf(bodyEnd);
		if (headingInCarry !== -1) return carry.slice(0, headingInCarry).trim();
		let held = carry; // body prefixes consumed so far
		for (let index = restIndex; index < pieces.length; index++) {
			const piece = pieces[index] ?? "";
			// Heading riding the seam into this piece.
			if (piece.startsWith("§ ")) return held.trim();
			const inside = piece.indexOf(bodyEnd);
			if (inside !== -1) return `${held}\n${piece.slice(0, inside)}`.trim();
			held = `${held}\n${piece}`;
		}
		// No heading anywhere: the body is `held`, the carry followed by every
		// later piece.
		return held.trim();
	};
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index] ?? "";
		const at = piece.indexOf(marker);
		if (at !== -1) return bodyOf(piece.slice(at + marker.length), index + 1);
		// Straddling: this piece ends with the marker's text and its seam is the
		// marker's `"\n"`, so the next piece is the body's first text.
		if (index + 1 < pieces.length && piece.endsWith("§ Context")) return bodyOf(pieces[index + 1] ?? "", index + 2);
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
 * The history is filled from the newest call backwards. Each call is rendered
 * once and its estimated tokens counted from that rendering; the walk stops at
 * the first call that would push the total past `budget`. That call is rendered
 * and then dropped, so it is the only call read beyond the window. What is kept
 * is the newest unbroken run, returned in chronological order. Numbers count
 * every prior call, so a gap in `n` marks dropped calls.
 */
const fitToolCalls = (prior: readonly ToolCallRecord[], results: ResultsByCallId, budget: number): readonly string[] => {
	const newestFirst = prior.map((call, index) => ({ call, n: index + 1 })).reverse();
	const kept: string[] = [];
	let used = 0;
	for (const { call, n } of newestFirst) {
		const rendered = renderCall(call, n, results);
		const tokens = estimateTokens(rendered);
		if (used + tokens > budget) break;
		used += tokens;
		kept.push(rendered);
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
	const calls = fitToolCalls(prior, transcript.resultsByCallId, budget);
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
