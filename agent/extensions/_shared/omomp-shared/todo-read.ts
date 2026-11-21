import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const TODO_READ_EVENT = "omp-todo-more:read";

export const TODO_READ_STATUSES = ["pending", "in_progress", "completed", "abandoned"] as const;

export type TodoReadStatus = (typeof TODO_READ_STATUSES)[number];

export type TodoReadGoal = { readonly objective: string; readonly measure: string; readonly doneWhen: string };

export type TodoReadOpenItem = { readonly phase: string; readonly title: string; readonly explanation: string | null };

export type TodoReadCounts = Readonly<Record<TodoReadStatus, number>>;

export type TodoReadResponse =
	| {
			readonly kind: "ok";
			readonly goal: TodoReadGoal | null;
			readonly openItems: readonly TodoReadOpenItem[];
			readonly counts: TodoReadCounts;
	  }
	| { readonly kind: "unavailable" };

export interface TodoReadRequest {
	readonly agentId: string;
	readonly reply: (value: unknown) => void;
}

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

export type TodoReadResponseParsed = TodoReadResponse | { readonly kind: "malformed"; readonly reason: string };

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

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Readonly<Record<string, unknown>>;
}

function parseCounts(value: unknown): TodoReadCounts | undefined {
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const counts: Record<TodoReadStatus, number> = { pending: 0, in_progress: 0, completed: 0, abandoned: 0 };
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

export type TodoReadEvents = Pick<ExtensionAPI["events"], "emit">;

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
