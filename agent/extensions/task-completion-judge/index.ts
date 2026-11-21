/**
 * The deadline stays under the harness's 30 s `tool_call` handler timeout, which would otherwise block the
 * yield.
 *
 * The host keeps a batch's shared `context` only in the subagent system prompt it renders under `⁂ Context`; no
 * session entry stores it. Locating any other marker hands the judge `(none)` without a warning.
 */

import { basename } from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { declaresFlag } from "../_shared/agent-definition.ts";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { readTodos, type TodoReadResponse } from "../_shared/omomp-shared/todo-read.ts";
import { completeRoleChain } from "../_shared/role-chain.ts";

const ROLE = basename(import.meta.dir);

const EFFORT = THINKING_EFFORTS.find((effort) => effort === "low");
if (EFFORT === undefined) throw new Error("Host thinking efforts do not include low");
const DEADLINE_MS = 25_000;
const JUDGE_CONTEXT_TOKENS = 64_000;
const JUDGE_RESERVED_TOKENS = 4_000;
const ARGS_CHAR_LIMIT = 800;
const RESULT_CHAR_LIMIT = 800;
const SUBMISSION_CHAR_LIMIT = 6_000;
const SHORT_JSON_DEPTH = 64;
const STRING_CHUNK = 4096;

type ReviewTodo = Extract<TodoReadResponse, { kind: "ok" }>;

function requireReviewTodo(pi: ExtensionAPI, agentId: string): ReviewTodo {
	const result = readTodos(pi.events, agentId);
	switch (result.kind) {
		case "ok":
			return result;
		case "unavailable":
			throw new Error("todo-more review state unavailable");
		case "no_reply":
			throw new Error("todo-more did not answer the read request");
		case "malformed":
			throw new Error(`todo-more replied out of protocol: ${result.reason}`);
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
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

type Round = { readonly kind: "open"; readonly bounced: boolean; readonly todoPrompted: boolean } | { readonly kind: "settled" };

const FIRST_ROUND: Round = { kind: "open", bounced: false, todoPrompted: false };

type Verdict =
	| { readonly kind: "done"; readonly reason: string }
	| { readonly kind: "not_done"; readonly reason: string }
	| { readonly kind: "unknown"; readonly why: string };

type YieldCall = { readonly kind: "data" } | { readonly kind: "text" } | { readonly kind: "not_terminal" };

type ToolCallRecord = {
	readonly id: string;
	readonly name: string;
	readonly args: ToolCall["arguments"];
	readonly message: AssistantMessage;
};
type ResultsByCallId = ReadonlyMap<string, { readonly isError: boolean; readonly content: ToolResultMessage["content"] }>;
type MessageContent = AssistantMessage["content"] | ToolResultMessage["content"];

type Transcript = {
	readonly assignment: string;
	readonly calls: readonly ToolCallRecord[];
	readonly callById: ReadonlyMap<string, ToolCallRecord>;
	readonly resultsByCallId: ResultsByCallId;
};

const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	return `${text.slice(0, head)}\n…[${text.length - limit} chars omitted]…\n${text.slice(text.length - tail)}`;
};

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
	if (seen <= limit) return tail > 0 && seen > head ? held + trailing.slice(Math.max(0, head - (seen - trailing.length))) : held;
	return `${held}\n…[${seen - limit} chars omitted]…\n${trailing}`;
};

const textWithin = (content: MessageContent, separator: string, limit: number): string =>
	boundedText((emit) => {
		let first = true;
		for (const block of content) {
			if (block.type !== "text") continue;
			if (!first) emit(separator);
			first = false;
			emit(block.text);
		}
	}, limit);

const estimateTokens = (text: string): number => {
	let tokens = 0;
	for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 : 2;
	return tokens;
};

class NotJsonData {}

type JsonRecord = Readonly<Record<string, unknown>>;

const NEEDS_ESCAPE = /["\\]|[^ -\ud7ff\ue000-\uffff]/;

const isJsonObject = (value: object): value is JsonRecord => {
	if ("toJSON" in value) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

const isJsonArray = (value: object): boolean => !("toJSON" in value) && Object.getPrototypeOf(value) === Array.prototype;

function isShortJson(value: unknown, depth: number): boolean {
	if (value === null) return true;
	switch (typeof value) {
		case "boolean":
		case "number":
			return true;
		case "string":
			return value.length <= STRING_CHUNK;
		case "object":
			break;
		case "undefined":
		case "function":
		case "symbol":
		case "bigint":
			return false;
	}
	if (depth === 0) return false;
	if (Array.isArray(value)) {
		if (!isJsonArray(value)) return false;
		const items: readonly unknown[] = value;
		for (let index = 0; index < items.length; index++) if (!isShortJson(items[index], depth - 1)) return false;
		return true;
	}
	if (!isJsonObject(value)) return false;
	for (const key in value) if (Object.hasOwn(value, key) && !isShortJson(value[key], depth - 1)) return false;
	return true;
}

const writeString = (text: string, emit: (part: string) => void): void => {
	if (text.length <= STRING_CHUNK) {
		emit(JSON.stringify(text));
		return;
	}
	emit('"');
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + STRING_CHUNK, text.length);
		const before = text.charCodeAt(end - 1);
		const after = text.charCodeAt(end);
		if (end < text.length && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
		const chunk = text.slice(start, end);
		emit(NEEDS_ESCAPE.test(chunk) ? JSON.stringify(chunk).slice(1, -1) : chunk);
		start = end;
	}
	emit('"');
};

function walkJson(value: unknown, emit: (part: string) => void, stack: object[]): void {
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
			writeString(value, emit);
			return;
		case "object":
			break;
		case "undefined":
		case "function":
		case "symbol":
		case "bigint":
			throw new NotJsonData();
	}
	if (isShortJson(value, SHORT_JSON_DEPTH)) {
		emit(JSON.stringify(value));
		return;
	}
	if (Array.isArray(value)) {
		if (!isJsonArray(value) || stack.includes(value)) throw new NotJsonData();
		const items: readonly unknown[] = value;
		stack.push(value);
		emit("[");
		let index = 0;
		while (index < items.length) {
			if (index > 0) emit(",");
			let end = index;
			while (end < items.length && isShortJson(items[end], SHORT_JSON_DEPTH)) end++;
			if (end > index) {
				emit(JSON.stringify(items.slice(index, end)).slice(1, -1));
				index = end;
			} else {
				walkJson(items[index], emit, stack);
				index++;
			}
		}
		emit("]");
	} else {
		if (!isJsonObject(value) || stack.includes(value)) throw new NotJsonData();
		stack.push(value);
		emit("{");
		let first = true;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (!first) emit(",");
			first = false;
			emit(NEEDS_ESCAPE.test(key) ? `${JSON.stringify(key)}:` : `"${key}":`);
			walkJson(value[key], emit, stack);
		}
		emit("}");
	}
	stack.pop();
}

const stringify = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

const stringifyWithin = (value: unknown, limit: number): string => {
	try {
		return boundedText((emit) => walkJson(value, emit, []), limit);
	} catch {
		return truncate(stringify(value), limit);
	}
};
const classifyYield = (input: YieldInput): YieldCall => {
	if (input.key !== undefined && input.key !== null) return { kind: "not_terminal" };
	if (typeof input.error === "string" && input.error.trim() !== "") return { kind: "not_terminal" };
	if (Array.isArray(input.type)) return { kind: "not_terminal" };
	return input.data === undefined || input.data === null ? { kind: "text" } : { kind: "data" };
};

const readTranscript = (ctx: ExtensionContext): Transcript | undefined => {
	const view = ctx.sessionManager.getBranch();
	let start = -1;
	let assignment = "";
	for (let index = view.length - 1; index >= 0; index--) {
		const entry = view[index];
		if (entry?.type === "session_init") {
			start = index;
			assignment = entry.task;
			break;
		}
	}
	if (start === -1) return undefined;
	const calls: ToolCallRecord[] = [];
	const resultsByCallId = new Map<string, { readonly isError: boolean; readonly content: ToolResultMessage["content"] }>();
	for (let index = start + 1; index < view.length; index++) {
		const entry = view[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				calls.push({ id: block.id, name: block.name, args: block.arguments, message });
			}
		} else if (message.role === "toolResult") {
			resultsByCallId.set(message.toolCallId, { isError: message.isError, content: message.content });
		}
	}
	const callById = new Map<string, ToolCallRecord>();
	for (const call of calls) callById.set(call.id, call);
	return { assignment, calls, callById, resultsByCallId };
};

// Locate the shared context only by the host subagent template's `⁂ Context` heading, ending at the next `⁂`
// heading: no session entry stores the batch's `context`, so a marker the host does not render hands the judge
// `(none)` silently, and a second marker matches the same words inside prompt text.
const sharedContextOf = (ctx: ExtensionContext): string => {
	const pieces = ctx.getSystemPrompt();
	const marker = "⁂ Context\n";
	const bodyEnd = "\n⁂ ";
	const bodyOf = (carry: string, restIndex: number): string => {
		const headingInCarry = carry.indexOf(bodyEnd);
		if (headingInCarry !== -1) return carry.slice(0, headingInCarry).trim();
		let held = carry; // body prefixes consumed so far
		for (let index = restIndex; index < pieces.length; index++) {
			const piece = pieces[index] ?? "";
			if (piece.startsWith("⁂ ")) return held.trim();
			const inside = piece.indexOf(bodyEnd);
			if (inside !== -1) return `${held}\n${piece.slice(0, inside)}`.trim();
			held = `${held}\n${piece}`;
		}
		return held.trim();
	};
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index] ?? "";
		const at = piece.indexOf(marker);
		if (at !== -1) return bodyOf(piece.slice(at + marker.length), index + 1);
		if (index + 1 < pieces.length && piece.endsWith("⁂ Context")) return bodyOf(pieces[index + 1] ?? "", index + 2);
	}
	return "";
};

const renderCall = (call: ToolCallRecord, n: number, results: ResultsByCallId): string => {
	const result = results.get(call.id);
	const status = result === undefined ? "no result" : result.isError ? "error" : "ok";
	return [
		`<call n="${n}" tool="${call.name}" status="${status}">`,
		`<args>${stringifyWithin(call.args, ARGS_CHAR_LIMIT)}</args>`,
		`<result>${result === undefined ? "" : textWithin(result.content, "", RESULT_CHAR_LIMIT)}</result>`,
		"</call>",
	].join("\n");
};

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
	const fixedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(frame([], 0));
	const budget = JUDGE_CONTEXT_TOKENS - JUDGE_RESERVED_TOKENS - fixedTokens;
	const calls = fitToolCalls(prior, transcript.resultsByCallId, budget);
	return frame(calls, calls.length);
};
const VERDICT_HEAD = /^(NOT DONE|NOT_DONE|DONE)(?=$|(?!_)[\s\p{P}])/u;

const parseAnswer = (text: string): Verdict => {
	const lines = text.trim().split("\n");
	const lead = (lines[0] ?? "").trim().replace(/^[`*\s]+/, "");
	const head = lead.replace(/[`*\s]+$/, "").toUpperCase();
	const match = VERDICT_HEAD.exec(head);
	if (match === null) return { kind: "unknown", why: `unparseable answer: ${text.slice(0, 80)}` };
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
		const ref = AgentRegistry.global()
			.list()
			.find((candidate) => candidate.sessionFile === sessionFile);
		if (ref === undefined) return undefined;
		const agentName = ref.displayName;
		if (!(await declaresFlag(callerSession(ctx), ctx.sessionManager.getCwd(), agentName, "completionjudge"))) return undefined;

		const transcript = readTranscript(ctx);
		if (transcript === undefined) {
			pi.logger.info("task-completion-judge skipped: no session_init on branch", { agentName });
			rounds.set(sessionFile, { kind: "settled" });
			return undefined;
		}
		const yieldContent = transcript.callById.get(toolCallId)?.message.content;
		const submission =
			call.kind === "text" ? textWithin(yieldContent ?? [], "", SUBMISSION_CHAR_LIMIT) : stringifyWithin(input.data, SUBMISSION_CHAR_LIMIT);
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
