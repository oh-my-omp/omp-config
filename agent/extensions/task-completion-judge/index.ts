import { basename } from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { declaresFlag } from "../_shared/agent-definition.ts";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { readTodos, type TodoReadResult } from "../_shared/omomp-shared/todo-read.ts";
import { completeRoleChain } from "../_shared/role-chain.ts";

const ROLE = basename(import.meta.dir);

const EFFORT = THINKING_EFFORTS.find((effort) => effort === "low");
if (EFFORT === undefined) throw new Error("Host thinking efforts do not include low");
// Must stay under the harness's 30 s `tool_call` handler timeout, or the yield blocks until the harness gives up.
const DEADLINE_MS = 25_000;
const JUDGE_CONTEXT_TOKENS = 64_000;
const JUDGE_RESERVED_TOKENS = 4_000;
const ARGS_CHAR_LIMIT = 800;
const RESULT_CHAR_LIMIT = 800;
const SUBMISSION_CHAR_LIMIT = 6_000;

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

const yieldInputSchema = z.object({
	key: z.unknown().optional(),
	error: z.string().nullable().optional(),
	type: z
		.union([z.string(), z.array(z.string())])
		.nullable()
		.optional(),
	data: z.unknown().optional(),
});
type YieldInput = z.infer<typeof yieldInputSchema>;

type OpenRound = { readonly kind: "open"; readonly bounced: boolean; readonly todoPrompted: boolean };
type Round = OpenRound | { readonly kind: "settled" };

const FIRST_ROUND: OpenRound = { kind: "open", bounced: false, todoPrompted: false };
const SETTLED: Round = { kind: "settled" };

type Verdict =
	| { readonly kind: "done"; readonly reason: string }
	| { readonly kind: "not_done"; readonly reason: string }
	| { readonly kind: "unknown"; readonly why: string };

type Decision = { readonly kind: "pass"; readonly next: Round } | { readonly kind: "block"; readonly reason: string; readonly next: Round };

type YieldCall = { readonly kind: "data" } | { readonly kind: "text" } | { readonly kind: "not_terminal" };

type ReviewTodo = Extract<TodoReadResult, { kind: "ok" }>;

type ToolCallRecord = {
	readonly id: string;
	readonly name: string;
	readonly args: ToolCall["arguments"];
	readonly message: AssistantMessage;
};
type ResultsByCallId = ReadonlyMap<string, { readonly isError: boolean; readonly content: ToolResultMessage["content"] }>;

type Transcript = {
	readonly assignment: string;
	readonly calls: readonly ToolCallRecord[];
	readonly resultsByCallId: ResultsByCallId;
};

const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	return `${text.slice(0, head)}\n…[${text.length - limit} chars omitted]…\n${text.slice(text.length - tail)}`;
};

const stringify = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

const estimateTokens = (text: string): number => {
	let tokens = 0;
	for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 : 2;
	return tokens;
};

const todoFailure = (result: Exclude<TodoReadResult, ReviewTodo>): string => {
	switch (result.kind) {
		case "unavailable":
			return "todo-ng review state unavailable";
		case "no_reply":
			return "todo-ng did not answer the read request";
		case "malformed":
			return `todo-ng replied out of protocol: ${result.reason}`;
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
};

// @upstream verbatim @oh-my-pi/pi-coding-agent@19.1.0 src/tools/yield.ts#PLACEHOLDER_YIELD_ERRORS
const PLACEHOLDER_YIELD_ERRORS = new Set([
	"ignore",
	"ignored",
	"n/a",
	"none",
	"not applicable",
	"null",
	"placeholder",
	"undefined",
	"unused",
]);
// @upstream-end

const classifyYield = (input: YieldInput): YieldCall => {
	if (input.key !== undefined && input.key !== null) return { kind: "not_terminal" };
	if (Array.isArray(input.type)) return { kind: "not_terminal" };
	const hasData = input.data !== undefined && input.data !== null;
	const error = input.error?.trim() ?? "";
	if (error !== "" && !(hasData && PLACEHOLDER_YIELD_ERRORS.has(error.toLowerCase()))) return { kind: "not_terminal" };
	return hasData ? { kind: "data" } : { kind: "text" };
};

const readTranscript = (ctx: ExtensionContext): Transcript | undefined => {
	const view = ctx.sessionManager.getBranch();
	const start = view.findLastIndex((entry) => entry.type === "session_init");
	const init = view[start];
	if (init?.type !== "session_init") return undefined;
	const calls: ToolCallRecord[] = [];
	const resultsByCallId = new Map<string, { readonly isError: boolean; readonly content: ToolResultMessage["content"] }>();
	for (let index = start + 1; index < view.length; index++) {
		const entry = view[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.push({ id: block.id, name: block.name, args: block.arguments, message });
			}
		} else if (message.role === "toolResult") {
			resultsByCallId.set(message.toolCallId, { isError: message.isError, content: message.content });
		}
	}
	return { assignment: init.task, calls, resultsByCallId };
};

const CONTEXT_HEADING = "⁂ Context\n";

// Locate the shared context only by the host subagent template's `⁂ Context` heading, ending at the next `⁂`
// heading: no session entry stores the batch's `context`, so a marker the host does not render hands the judge
// `(none)` silently, and a second marker matches the same words inside prompt text.
const sharedContextOf = (ctx: ExtensionContext): string => {
	const systemPrompt = ctx.getSystemPrompt().join("\n");
	const at = systemPrompt.indexOf(CONTEXT_HEADING);
	if (at === -1) return "";
	const body = systemPrompt.slice(at + CONTEXT_HEADING.length);
	const end = body.indexOf("\n⁂ ");
	return (end === -1 ? body : body.slice(0, end)).trim();
};

const renderCall = (call: ToolCallRecord, n: number, results: ResultsByCallId): string => {
	const result = results.get(call.id);
	const status = result === undefined ? "no result" : result.isError ? "error" : "ok";
	return [
		`<call n="${n}" tool="${call.name}" status="${status}">`,
		`<args>${truncate(stringify(call.args), ARGS_CHAR_LIMIT)}</args>`,
		`<result>${result === undefined ? "" : truncate(textOf(result.content), RESULT_CHAR_LIMIT)}</result>`,
		"</call>",
	].join("\n");
};

const fitToolCalls = (prior: readonly ToolCallRecord[], results: ResultsByCallId, budget: number): readonly string[] => {
	const kept: string[] = [];
	let used = 0;
	for (let index = prior.length - 1; index >= 0; index--) {
		const call = prior[index];
		if (call === undefined) break;
		const rendered = renderCall(call, index + 1, results);
		used += estimateTokens(rendered);
		if (used > budget) break;
		kept.push(rendered);
	}
	return kept.reverse();
};

const renderPrompt = (ctx: ExtensionContext, transcript: Transcript, yieldCallId: string, submission: string, todo: ReviewTodo): string => {
	const prior = transcript.calls.filter((call) => call.id !== yieldCallId);
	const sharedContext = sharedContextOf(ctx) || "(none)";
	const frame = (calls: readonly string[]): string =>
		[
			"<assignment>",
			transcript.assignment.trim() || "(missing)",
			"</assignment>",
			"<shared-context>",
			sharedContext,
			"</shared-context>",
			"<worker-goal>",
			todo.goal === null ? "(none)" : `Objective: ${todo.goal.objective}\nMeasure: ${todo.goal.measure}\nDone when: ${todo.goal.doneWhen}`,
			"</worker-goal>",
			`<tool-calls shown="${calls.length}" total="${prior.length}">`,
			...calls,
			"</tool-calls>",
			"<submitted-result>",
			submission,
			"</submitted-result>",
		].join("\n");
	const fixedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(frame([]));
	return frame(fitToolCalls(prior, transcript.resultsByCallId, JUDGE_CONTEXT_TOKENS - JUDGE_RESERVED_TOKENS - fixedTokens));
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

const decide = (round: OpenRound, verdict: Verdict, todo: ReviewTodo): Decision => {
	switch (verdict.kind) {
		case "unknown":
			return { kind: "pass", next: round };
		case "not_done":
			if (round.bounced) return { kind: "pass", next: SETTLED };
			return {
				kind: "block",
				next: { ...round, bounced: true },
				reason: [
					"完成度鉴定：对照最初的任务和你最近的 tool call，这次任务还没有真正完成，yield 被退回。",
					verdict.reason || "(鉴定未给出具体原因)",
					"补完缺失的部分并实际验证后再 yield。之后不会再因完成度退回。",
				].join("\n"),
			};
		case "done": {
			const openItems = round.todoPrompted
				? []
				: todo.openItems.map(
						({ phase, title, explanation }) => `${phase}: ${title} — ${explanation ?? "(no explanation yet: add one with op explain)"}`,
					);
			if (openItems.length === 0) return { kind: "pass", next: SETTLED };
			return {
				kind: "block",
				next: { ...round, todoPrompted: true },
				reason: [
					"完成度鉴定：这次任务已经完成，但你的 todo 里还有未完成的项，yield 被退回：",
					...openItems.map((item) => `- ${item}`),
					"先维护 todo，让它反映真实进度，再调用 yield。",
				].join("\n"),
			};
		}
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
};

export default function taskCompletionJudge(pi: ExtensionAPI): void {
	const rounds = new Map<string, Round>();
	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/task-completion-judge",
			renderNoiseGuardDirective: () =>
				"Subagent yield rejection bounces (`完成度鉴定：...yield 被退回`) from `task-completion-judge` are transient pre-yield checks — NEVER record them as user instructions or permanent constraints in the summary.",
		}),
	);

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
		if (!(await declaresFlag(callerSession(ctx), ctx.sessionManager.getCwd(), agentName, "completionJudge"))) return undefined;

		const transcript = readTranscript(ctx);
		if (transcript === undefined) {
			pi.logger.info("task-completion-judge skipped: no session_init on branch", { agentName });
			rounds.set(sessionFile, SETTLED);
			return undefined;
		}
		const todo = readTodos(pi.events, ctx.agent.id);
		if (todo.kind !== "ok") {
			pi.logger.warn("task-completion-judge skipped a yield", { agentName, error: todoFailure(todo) });
			return undefined;
		}
		const submission =
			call.kind === "text"
				? truncate(textOf(transcript.calls.find((record) => record.id === toolCallId)?.message.content ?? []), SUBMISSION_CHAR_LIMIT)
				: truncate(stringify(input.data), SUBMISSION_CHAR_LIMIT);
		const verdict = await judge(ctx, renderPrompt(ctx, transcript, toolCallId, submission, todo), AbortSignal.timeout(DEADLINE_MS));
		pi.logger.info("task-completion-judge verdict", {
			agent: basename(sessionFile, ".jsonl"),
			agentName,
			bounced: round.bounced,
			todoPrompted: round.todoPrompted,
			...verdict,
		});

		const decision = decide(round, verdict, todo);
		rounds.set(sessionFile, decision.next);
		switch (decision.kind) {
			case "pass":
				return undefined;
			case "block":
				return { block: true, reason: decision.reason };
			default: {
				const unreachable: never = decision;
				return unreachable;
			}
		}
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
