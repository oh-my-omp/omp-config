/**
 * `omp-todo-more:read` wire protocol: the single declaration of the request and
 * reply shapes that pass over the host's synchronous extension event channel.
 *
 * The producing plugin owns the protocol's semantics; this file only declares
 * them so every party validates against one shape. A request is `{ agentId,
 * reply }` for a session agent; the owner replies synchronously, before
 * `emit` returns, with `{ kind: "ok", goal, openItems, counts }` —
 * `counts` is always present and totals every item of the list across all five
 * statuses — or `{ kind: "unavailable" }` when it has no state for the agent.
 *
 * Producer side: `isTodoReadRequest` validates an incoming request.
 * Consumer side: `readTodos` emits the request and reports one of four
 * outcomes — the `ok` reply, `unavailable`, `no_reply` (no listener answered,
 * or emitting failed), or `malformed` (the reply broke the protocol, `reason`
 * naming the offending field). `parseTodoReadResponse` is the reply parser on
 * its own. `readTodos` never throws: a malformed or absent reply is a result,
 * never an empty list and never an exception.
 */

/** The event channel name the request travels on. */
export const TODO_READ_EVENT = "omp-todo-more:read";

/** Every item status, in protocol order: the fixed key set of `counts`. */
export const TODO_READ_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"] as const;

/** One item status. */
export type TodoReadStatus = (typeof TODO_READ_STATUSES)[number];

/** The list goal: what the work is, how it is measured, and how far it must go. */
export type TodoReadGoal = { readonly objective: string; readonly measure: string; readonly doneWhen: string };

/** One still-open item with its phase name; `explanation` is null when the item has none. */
export type TodoReadOpenItem = { readonly phase: string; readonly title: string; readonly explanation: string | null };

/** Items per status over the whole list; every key of `TODO_READ_STATUSES` is present, all zero for an empty list. */
export type TodoReadCounts = Readonly<Record<TodoReadStatus, number>>;

/** The reply the owner passes to the request's `reply` callback. */
export type TodoReadResponse =
	| {
			readonly kind: "ok";
			readonly goal: TodoReadGoal | null;
			readonly openItems: readonly TodoReadOpenItem[];
			readonly counts: TodoReadCounts;
	  }
	| { readonly kind: "unavailable" };

/** What the owner receives on the channel: a session agent id and the synchronous reply callback. */
export interface TodoReadRequest {
	readonly agentId: string;
	readonly reply: (value: unknown) => void;
}

/** Whether `value` is a well-formed request: an object with a non-blank `agentId` and a `reply` function. */
export function isTodoReadRequest(value: unknown): value is TodoReadRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"agentId" in value &&
		typeof value.agentId === "string" &&
		value.agentId.trim().length > 0 &&
		"reply" in value &&
		typeof value.reply === "function"
	);
}

/** A parsed reply, or `malformed` with `reason` naming the first field that broke the protocol. */
export type TodoReadResponseParsed = TodoReadResponse | { readonly kind: "malformed"; readonly reason: string };

/** The outcome of one `readTodos` call. */
export type TodoReadResult =
	| {
			readonly kind: "ok";
			readonly goal: TodoReadGoal | null;
			readonly openItems: readonly TodoReadOpenItem[];
			readonly counts: TodoReadCounts;
	  }
	| { readonly kind: "unavailable" }
	| { readonly kind: "no_reply" }
	| { readonly kind: "malformed"; readonly reason: string };

const malformed = (reason: string): { readonly kind: "malformed"; readonly reason: string } => ({ kind: "malformed", reason });

/** A plain object (record), or undefined: arrays, null and primitives are not objects here. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Readonly<Record<string, unknown>>;
}

function parseCounts(value: unknown): TodoReadCounts | undefined {
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const counts: Record<TodoReadStatus, number> = { pending: 0, in_progress: 0, completed: 0, abandoned: 0, blocked: 0 };
	for (const status of TODO_READ_STATUSES) {
		const n = record[status];
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return undefined;
		counts[status] = n;
	}
	return counts;
}

function parseGoal(value: unknown): TodoReadGoal | null | undefined {
	if (value === null) return null;
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const { objective, measure, doneWhen } = record;
	if (typeof objective !== "string" || typeof measure !== "string" || typeof doneWhen !== "string") return undefined;
	return { objective, measure, doneWhen };
}

function parseOpenItem(value: unknown): TodoReadOpenItem | undefined {
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const { phase, title, explanation } = record;
	if (typeof phase !== "string" || typeof title !== "string" || (explanation !== null && typeof explanation !== "string")) {
		return undefined;
	}
	return { phase, title, explanation };
}

/**
 * Parse a reply passed to the request's `reply` callback. Returns the reply, or
 * `malformed` whose `reason` names the first field that broke the protocol:
 * `kind`, `goal`, `openItems`, `openItems[<index>]`, or `counts`.
 */
export function parseTodoReadResponse(value: unknown): TodoReadResponseParsed {
	const record = recordOf(value);
	if (record === undefined) return malformed("kind: expected a reply object");
	if (record.kind === "unavailable") return { kind: "unavailable" };
	if (record.kind !== "ok") return malformed('kind: expected "ok" or "unavailable"');
	const goal = parseGoal(record.goal);
	if (goal === undefined) return malformed("goal: expected null or { objective, measure, doneWhen } strings");
	if (!Array.isArray(record.openItems)) return malformed("openItems: expected an array");
	const openItems: TodoReadOpenItem[] = [];
	for (const [index, item] of record.openItems.entries()) {
		const parsed = parseOpenItem(item);
		if (parsed === undefined) return malformed(`openItems[${index}]: expected { phase, title } strings and a string or null explanation`);
		openItems.push(parsed);
	}
	const counts = parseCounts(record.counts);
	if (counts === undefined) return malformed("counts: expected a non-negative integer per todo status");
	return { kind: "ok", goal, openItems, counts };
}

/** The member of the host extension API `readTodos` needs: the synchronous event emitter. */
export interface TodoReadEvents {
	emit(channel: string, data: unknown): void;
}

/**
 * Emit one `omp-todo-more:read` request for `agentId` and report the outcome.
 * `no_reply` means no listener answered synchronously (the owner is not loaded)
 * or emitting itself failed; `unavailable` means the owner answered that it has
 * no state for the agent. Never throws.
 */
export function readTodos(events: TodoReadEvents, agentId: string): TodoReadResult {
	let sent = false;
	let value: unknown;
	try {
		events.emit(TODO_READ_EVENT, {
			agentId,
			reply: (response: unknown) => {
				sent = true;
				value = response;
			},
		});
	} catch {
		return { kind: "no_reply" };
	}
	if (!sent) return { kind: "no_reply" };
	return parseTodoReadResponse(value);
}
