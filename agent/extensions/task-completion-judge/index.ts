/**
 * Completion judge for `task:low` / `task:mid` / `task:free` subagents. It runs
 * inside the subagent's own session and intercepts a terminal `yield` when
 * that run has a structured yield tool. Unstructured task runs have no yield
 * to intercept. A fast model compares the assignment (the `task` prompt the
 * executor recorded in the run's `session_init`, plus the batch's shared
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
 * bounce. Every yield that passes after a definitive verdict carries it to
 * the parent as `data.completion_judge = { verdict, reason, bounced }`, where
 * `bounced` records only the NOT done bounce. Later yields in the same
 * session pass unjudged.
 *
 * The verdict is attached only when the yield's `data` is the schema-free open
 * object; a caller `outputSchema` could reject the extra field, so there the
 * yield passes unchanged (the bounce still applies). A data-less text result
 * is converted to `data: { result: <that text>, completion_judge }`.
 *
 * Registers `tool_call` and `session_shutdown`; it reads the host-managed session
 * branch for the assignment/tools and requests the independent Todo owner's
 * synchronous read projection before and after judging. Its model is the OMP
 * model role `@task-completion-judge` (assign it in `/model`), then the role
 * named by `fallbackRole` in the `task-completion-judge` section of omomp.* (a
 * project copy wins), both resolved at every judgment, and it writes only
 * in-memory round state. Only the named task subagents
 * are judged; main sessions pass.
 * Every failure (agent not identified, Todo owner unavailable, no model in
 * either role, every model's provider failing, unparseable answer, deadline) lets
 * the yield pass as written. A provider failure moves to the next model of the
 * chain; an unparseable answer does not. The deadline stays under the harness's 30 s
 * `tool_call` handler timeout, which would otherwise block the yield.
 */
import { basename } from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import { modelLabel, roleModels, roleName } from "../_shared/roles.ts";

const configSchema = z.object({
	/** OMP model role (`smol`, `@smol`, …) whose models answer when `@task-completion-judge` resolves none or all of its models fail. */
	fallbackRole: z.string().min(1).optional(),
});

const omompSection = defineOmompSection(import.meta.dir, configSchema);
/** The OMP model role this extension's judge model comes from: the extension's own name. */
const ROLE = omompSection.id;

/** Effort when the role entry has no `:level` suffix. */
const EFFORT = THINKING_EFFORTS.find((effort) => effort === "low");
if (EFFORT === undefined) throw new Error("Host thinking efforts do not include low");
const DEADLINE_MS = 25_000;
const JUDGED_AGENTS: Record<string, true> = { "task:low": true, "task:free": true, "task:mid": true };
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

const dataObjectSchema = z.record(z.string(), z.unknown());

const toolCallBlockSchema = z
	.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.unknown() })
	.passthrough();

/** Written by the task executor when the run starts; `task` is the exact prompt it dispatches. */
const sessionInitEntrySchema = z.object({ type: z.literal("session_init"), task: z.string() }).passthrough();

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

/** The schema-free yield `data` is `{ type: 'object', additionalProperties: true }` with no declared properties. */
const openYieldParametersSchema = z
	.object({
		properties: z
			.object({
				data: z
					.object({
						additionalProperties: z.literal(true),
						properties: z.unknown().refine((value) => value === undefined),
					})
					.passthrough(),
			})
			.passthrough(),
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

type CompletionJudge = {
	readonly verdict: "done" | "not_done";
	readonly reason: string;
	readonly bounced: boolean;
};

/** Terminal yields are judged; incremental sections, error yields, and workpool items pass untouched. */
type YieldCall =
	| { readonly kind: "data"; readonly data: Readonly<Record<string, unknown>> }
	| { readonly kind: "text" }
	| { readonly kind: "opaque" }
	| { readonly kind: "not_terminal" };

type ToolCallRecord = { readonly id: string; readonly name: string; readonly args: unknown };
type ToolResultRecord = { readonly text: string; readonly isError: boolean };

type Transcript = {
	readonly assignment: string;
	readonly calls: readonly ToolCallRecord[];
	readonly results: ReadonlyMap<string, ToolResultRecord>;
	readonly assistantTextByCallId: ReadonlyMap<string, string>;
};

// --- pure helpers ---

const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	return `${text.slice(0, head)}\n…[${text.length - limit} chars omitted]…\n${text.slice(text.length - tail)}`;
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

const stringify = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		// Circular structures and non-JSON values (such as bigint) use their textual representation.
		return String(value);
	}
};

const classifyYield = (input: YieldInput): YieldCall => {
	if (input.key !== undefined && input.key !== null) return { kind: "not_terminal" };
	if (typeof input.error === "string" && input.error.trim() !== "") return { kind: "not_terminal" };
	if (Array.isArray(input.type)) return { kind: "not_terminal" };
	if (input.data === undefined || input.data === null) return { kind: "text" };
	const data = dataObjectSchema.safeParse(input.data);
	return data.success && !Array.isArray(input.data) ? { kind: "data", data: data.data } : { kind: "opaque" };
};

/**
 * The run's own part of the branch: from the latest `session_init` on. Returns
 * undefined when the branch has none, i.e. the session is not a task run.
 */
const readTranscript = (ctx: ExtensionContext): Transcript | undefined => {
	let assignment: string | undefined;
	const calls: ToolCallRecord[] = [];
	const results = new Map<string, ToolResultRecord>();
	const assistantTextByCallId = new Map<string, string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		const init = sessionInitEntrySchema.safeParse(entry);
		if (init.success) {
			assignment = init.data.task;
			calls.length = 0;
			results.clear();
			assistantTextByCallId.clear();
			continue;
		}
		if (assignment === undefined) continue;
		const parsed = messageEntrySchema.safeParse(entry);
		if (!parsed.success) continue;
		const message = parsed.data.message;
		switch (message.role) {
			case "assistant": {
				const text = textOf(message.content);
				for (const block of message.content) {
					const call = toolCallBlockSchema.safeParse(block);
					if (!call.success) continue;
					calls.push({ id: call.data.id, name: call.data.name, args: call.data.arguments });
					assistantTextByCallId.set(call.data.id, text);
				}
				break;
			}
			case "toolResult":
				results.set(message.toolCallId, { text: textOf(message.content), isError: message.isError === true });
				break;
			default: {
				const unexpected: never = message;
				throw new Error(`Unexpected transcript message: ${unexpected}`);
			}
		}
	}
	return assignment === undefined ? undefined : { assignment, calls, results, assistantTextByCallId };
};

/** The batch's shared `context` is rendered into the subagent system prompt as its `§ Context` section. */
const sharedContextOf = (ctx: ExtensionContext): string => {
	const prompt = ctx.getSystemPrompt().join("\n");
	const marker = "§ Context\n";
	const start = prompt.indexOf(marker);
	if (start === -1) return "";
	const body = prompt.slice(start + marker.length);
	const end = body.indexOf("\n§ ");
	return (end === -1 ? body : body.slice(0, end)).trim();
};

/** One tool call with its arguments and result, each already truncated; `n` is its position among all the worker's prior calls. */
const renderCall = (call: ToolCallRecord, n: number, results: ReadonlyMap<string, ToolResultRecord>): string => {
	const result = results.get(call.id);
	const status = result === undefined ? "no result" : result.isError ? "error" : "ok";
	return [
		`<call n="${n}" tool="${call.name}" status="${status}">`,
		`<args>${truncate(stringify(call.args), ARGS_CHAR_LIMIT)}</args>`,
		`<result>${result === undefined ? "" : truncate(result.text, RESULT_CHAR_LIMIT)}</result>`,
		"</call>",
	].join("\n");
};

/**
 * The history is filled from the newest call backwards until the next call would
 * push the request past `budget` estimated tokens. The first call that does not
 * fit ends the walk: what is kept is the newest unbroken run, in chronological
 * order. Numbers count every prior call, so a gap in `n` marks dropped calls.
 */
const fitToolCalls = (prior: readonly ToolCallRecord[], results: ReadonlyMap<string, ToolResultRecord>, budget: number): string[] => {
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
			truncate(submission, SUBMISSION_CHAR_LIMIT),
			"</submitted-result>",
		].join("\n");
	// Everything but the tool calls is counted first; the calls get what is left of the window.
	const fixedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(frame([], 0));
	const budget = JUDGE_CONTEXT_TOKENS - JUDGE_RESERVED_TOKENS - fixedTokens;
	const kept = fitToolCalls(prior, transcript.results, budget);
	return frame(kept, kept.length);
};

const parseAnswer = (text: string): Verdict => {
	const lines = text.trim().split("\n");
	const head = (lines[0] ?? "")
		.trim()
		.replace(/^[`*\s]+|[`*\s]+$/g, "")
		.toUpperCase();
	const reason = lines.slice(1).join("\n").trim();
	if (head === "NOT_DONE") return { kind: "not_done", reason };
	if (head === "DONE") return { kind: "done", reason };
	return { kind: "unknown", why: `unparseable answer: ${text.slice(0, 80)}` };
};

const judge = async (ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<Verdict> => {
	const config = loadOmompSection(omompSection, ctx.cwd);
	const fallbackRole = config.kind === "found" ? config.value.fallbackRole : undefined;
	const failures: string[] = [];
	try {
		const models = roleModels(ctx, fallbackRole === undefined ? [ROLE] : [ROLE, fallbackRole]);
		if (models.length === 0) {
			return {
				kind: "unknown",
				why: `no model: assign @${ROLE} in /model${fallbackRole === undefined ? "" : ` or @${roleName(fallbackRole)}`}`,
			};
		}
		for (const { model, level } of models) {
			if (signal.aborted) return { kind: "unknown", why: "deadline" };
			try {
				const reply = await completeSimple(
					model,
					{
						systemPrompt: [SYSTEM_PROMPT],
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					level === "off"
						? { apiKey: ctx.modelRegistry.resolver(model), disableReasoning: true, signal }
						: { apiKey: ctx.modelRegistry.resolver(model), reasoning: level ?? EFFORT, signal },
				);
				if (reply.stopReason === "aborted") return { kind: "unknown", why: "aborted" };
				if (reply.stopReason === "error") {
					failures.push(`${modelLabel(model)}: ${reply.errorMessage ?? "error"}`);
					continue;
				}
				return parseAnswer(textOf(reply.content));
			} catch (error) {
				if (signal.aborted) return { kind: "unknown", why: "deadline" };
				failures.push(`${modelLabel(model)}: ${errorText(error)}`);
			}
		}
		return { kind: "unknown", why: `every model failed: ${failures.join("; ")}` };
	} catch (error) {
		return { kind: "unknown", why: signal.aborted ? "deadline" : errorText(error) };
	}
};

/** Pending or in-progress items of the session's own todo list, with their explanations. */
const openTodoItems = (todo: ReviewTodo): string[] =>
	todo.openItems.map(
		({ phase, title, explanation }) => `${phase}: ${title} — ${explanation ?? "(no explanation yet: add one with op explain)"}`,
	);

export default function taskCompletionJudge(pi: ExtensionAPI): void {
	const rounds = new Map<string, Round>();

	const annotate = (
		input: YieldInput,
		call: YieldCall,
		assistantText: string | undefined,
		completionJudge: CompletionJudge,
	): Record<string, unknown> | undefined => {
		// Only the schema-free `data` can take an extra field without failing validation.
		const yieldTool = pi.getAllTools().find((tool) => tool.name === "yield");
		if (!openYieldParametersSchema.safeParse(yieldTool?.parameters).success) return undefined;
		switch (call.kind) {
			case "data":
				return { ...input, data: { ...call.data, completion_judge: completionJudge } };
			case "text":
				return assistantText === undefined ? undefined : { ...input, data: { result: assistantText, completion_judge: completionJudge } };
			case "opaque":
			case "not_terminal":
				return undefined;
			default: {
				const unexpected: never = call;
				throw new Error(`Unexpected yield call: ${unexpected}`);
			}
		}
	};

	const review = async (
		toolCallId: string,
		rawInput: unknown,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | { input: Record<string, unknown> } | undefined> => {
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
		if (ref === undefined || !Object.hasOwn(JUDGED_AGENTS, ref.displayName)) return undefined;
		const agentName = ref.displayName;

		const transcript = readTranscript(ctx);
		if (transcript === undefined) {
			// No recorded assignment to judge against: let this and later yields pass.
			pi.logger.info("task-completion-judge skipped: no session_init on branch", { agentName });
			rounds.set(sessionFile, { kind: "settled" });
			return undefined;
		}
		const assistantText = transcript.assistantTextByCallId.get(toolCallId);
		const submission = call.kind === "text" ? (assistantText ?? "") : stringify(input.data);
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
				rounds.set(sessionFile, { kind: "settled" });
				return undefined;
			case "not_done":
				if (!round.bounced) {
					rounds.set(sessionFile, { ...round, bounced: true });
					const reason = [
						"完成度鉴定：对照最初的任务和你最近的 tool call，这次任务还没有真正完成，yield 被退回。",
						verdict.reason || "(鉴定未给出具体原因)",
						"补完缺失的部分并实际验证后再 yield。之后不会再因完成度退回，鉴定结论会一并交给主 agent。",
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
		const revised = annotate(input, call, assistantText, {
			verdict: verdict.kind,
			reason: verdict.reason,
			bounced: round.bounced,
		});
		return revised === undefined ? undefined : { input: revised };
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
