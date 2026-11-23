import { basename } from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, type TaskItem, type TaskParams, z, type zod } from "@oh-my-pi/pi-coding-agent";
import { declaresFlag } from "../_shared/agent-definition.ts";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { type AttemptBudget, completeRoleChain } from "../_shared/role-chain.ts";
import { modelLabel } from "../_shared/roles.ts";

const ROLE = basename(import.meta.dir);
const SPLIT_CHECK_KEY = "splitCheck";
const EFFORT =
	THINKING_EFFORTS.find((effort) => effort === "medium") ??
	(() => {
		throw new Error("task-split-check: host does not recognize medium reasoning effort");
	})();
// Keep under the harness's 30 s tool_call handler timeout, or the call is blocked.
const DEADLINE_MS = 25_000;

const taskItemShape = {
	task: z
		.string()
		.refine((task) => task.trim() !== "")
		.optional(),
	steps: z
		.array(z.string())
		.min(1)
		.refine((steps) => steps.every((step) => step.trim() !== ""))
		.optional(),
	name: z.string().optional(),
	agent: z.string().optional(),
} satisfies { [K in keyof TaskItem]?: zod.ZodLikeSchema<TaskItem[K]> };
const taskItemSchema: zod.ZodLikeSchema<TaskItem> = z
	.object(taskItemShape)
	.refine((item) => (item.task === undefined) !== (item.steps === undefined));
const batchShape = { context: z.string().optional(), tasks: z.array(taskItemSchema) } satisfies {
	[K in keyof TaskParams]?: zod.ZodLikeSchema<TaskParams[K]>;
};
const batchSchema: zod.ZodLikeSchema<Pick<TaskParams, "context"> & Required<Pick<TaskParams, "tasks">>> = z.object(batchShape);
type TaskCall = { readonly context: string | undefined; readonly items: readonly TaskItem[] };

const parseTaskCall = (input: unknown): TaskCall | null => {
	const batch = batchSchema.safeParse(input);
	if (batch.success) return { context: batch.data.context, items: batch.data.tasks };
	const flat = taskItemSchema.safeParse(input);
	return flat.success ? { context: undefined, items: [flat.data] } : null;
};

type Verdict =
	| { readonly kind: "flagged" }
	| { readonly kind: "clear" }
	| { readonly kind: "repeat" }
	| { readonly kind: "unknown"; readonly why: string };

type Memory = "pass-repeats" | "skip-clear";

type Check = {
	readonly id: string;
	readonly covers: (ctx: ExtensionContext, agent: string | undefined) => Promise<boolean>;
	readonly question: string;
	readonly memory: Memory;
	readonly reason: (labels: string) => string;
};

const CHECKS: readonly Check[] = [
	{
		id: "split",
		covers: (ctx, agent) =>
			ctx.agent.kind === "main" && agent !== undefined
				? declaresFlag(callerSession(ctx), ctx.sessionManager.getCwd(), agent, SPLIT_CHECK_KEY)
				: Promise.resolve(false),
		question: [
			"Does this one assignment cover more than one topic, so that it should have been split into separate assignments for separate workers?",
			"A topic is one subject: one question to answer, one outcome to deliver, one area to investigate. The number of files, documents, steps, or edits does not matter: one change applied across many files, or several documents written about the same subject, is still one topic.",
			"It covers several topics when it asks one worker to handle distinct subjects that do not depend on each other, for example a broad investigation sweeping several separate areas or questions, or unrelated features, bugs, or commands put into one assignment.",
			"Not several topics: steps toward one outcome; one change together with its verification; several questions about the same subject; one subject spread over many files.",
			"For this question the shared context is background only. Judge the assignment text.",
			"`true` if the assignment covers more than one topic, `false` otherwise.",
		].join("\n"),
		memory: "pass-repeats",
		reason: (labels) =>
			`你没有好好规划任务：${labels} 把多个主题塞给了一个 agent，按主题拆成多个 item 后重新派发；确认是单一主题的项可以原样重新派发，第二次直接放行。`,
	},
	{
		id: "report-limit",
		covers: (_ctx, agent) => Promise.resolve(agent === undefined || agent.startsWith("task:")),
		question: [
			"Does the dispatch limit the length of the report the worker returns: a cap on words, characters, lines, tokens, sentences, bullets or paragraphs, or an instruction to keep the report or answer short, brief or within some size?",
			"For this question both the shared context and the assignment count: a length limit in either one applies to this worker.",
			"Not a report limit: size requirements on a deliverable the worker writes into the repository or a file (a 200-word README section, a function under 50 lines); instructions to write a long report to a file and return its path.",
			"`true` if the dispatch limits the report length, `false` otherwise.",
		].join("\n"),
		memory: "skip-clear",
		reason: (labels) =>
			`禁止限制 task 系列 subagent 的报告字数：${labels} 的共享 context 或 task 限制了报告长度。删掉字数/长度限制后重新派发；报告长时让 worker 写入文件（如 \`local://<name>.md\`）并在回复里给出路径，而不是直接汇报全文。`,
	},
];

const renderSystemPrompt = (checks: readonly Check[]): string =>
	[
		"You check one dispatch that an orchestrating agent is about to send to a single worker agent: a shared context describing the whole batch, plus one assignment for this worker.",
		"Answer each question below independently.",
		...checks.map((check) => `## Question \`${check.id}\`\n${check.question}`),
		`Answer with exactly one line per question, in the form \`<question id>: true\` or \`<question id>: false\`, and nothing else. Question ids: ${checks.map((check) => check.id).join(", ")}.`,
	].join("\n\n");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseAnswer = (text: string, check: Check): Verdict => {
	const line = new RegExp(`^[\\s\`*-]*${escapeRegExp(check.id)}[\`*]*\\s*:\\s*[\`*]*(true|false)\\b`, "im").exec(text);
	if (line === null) return { kind: "unknown", why: `unparseable answer: ${text.slice(0, 80)}` };
	return line[1]?.toLowerCase() === "true" ? { kind: "flagged" } : { kind: "clear" };
};

const renderPrompt = (context: string | undefined, item: TaskItem): string =>
	[
		"<shared-context>",
		context?.trim() || "(none)",
		"</shared-context>",
		"<assignment>",
		(item.steps?.join("\n") ?? item.task ?? "").trim(),
		"</assignment>",
	].join("\n");

const remembered = new Set<string>();

const recall = (check: Check, key: string): Verdict | null => {
	if (!remembered.has(key)) return null;
	switch (check.memory) {
		case "pass-repeats":
			return { kind: "repeat" };
		case "skip-clear":
			return { kind: "clear" };
		default: {
			const unreachable: never = check.memory;
			throw new Error(`unknown memory: ${String(unreachable)}`);
		}
	}
};

const memorize = (check: Check, key: string, verdict: Verdict): void => {
	switch (check.memory) {
		case "pass-repeats":
			if (verdict.kind !== "unknown") remembered.add(key);
			return;
		case "skip-clear":
			if (verdict.kind === "clear") remembered.add(key);
			return;
		default: {
			const unreachable: never = check.memory;
			throw new Error(`unknown memory: ${String(unreachable)}`);
		}
	}
};

type Reply = { readonly kind: "text"; readonly text: string } | Extract<Verdict, { kind: "unknown" }>;

type ItemVerdicts = { readonly label: string; readonly verdicts: ReadonlyMap<Check, Verdict> };

export default function taskSplitCheck(pi: ExtensionAPI): void {
	const ask = async (
		ctx: ExtensionContext,
		systemPrompt: string,
		prompt: string,
		signal: AbortSignal,
		budget: AttemptBudget,
	): Promise<Reply> => {
		const reply = await completeRoleChain(
			ctx,
			[ROLE, "default"],
			systemPrompt,
			prompt,
			EFFORT,
			signal,
			budget,
			(stopReason) => stopReason === "stop",
		);
		switch (reply.kind) {
			case "text":
				pi.logger.info("task-split-check answered", { model: modelLabel(reply.model.model), failures: reply.failures });
				return { kind: "text", text: reply.text };
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

	const judgeItem = async (
		ctx: ExtensionContext,
		checks: readonly Check[],
		context: string | undefined,
		item: TaskItem,
		label: string,
		signal: AbortSignal,
		budget: AttemptBudget,
	): Promise<ReadonlyMap<Check, Verdict>> => {
		const prompt = renderPrompt(context, item);
		const scope = `${ctx.sessionManager.getSessionId()}:${new Bun.CryptoHasher("sha256").update(prompt).digest("hex")}`;
		const keyOf = (check: Check): string => `${check.id}:${scope}`;
		const verdicts = new Map<Check, Verdict>();
		const pending: Check[] = [];
		for (const check of checks) {
			const known = recall(check, keyOf(check));
			if (known === null) pending.push(check);
			else verdicts.set(check, known);
		}
		if (pending.length === 0) return verdicts;

		const reply = await ask(ctx, renderSystemPrompt(pending), prompt, signal, budget);
		for (const check of pending) {
			const verdict = reply.kind === "text" ? parseAnswer(reply.text, check) : reply;
			if (verdict.kind === "unknown") {
				pi.logger.warn("task-split-check check failed", { check: check.id, item: label, error: verdict.why });
			}
			memorize(check, keyOf(check), verdict);
			verdicts.set(check, verdict);
		}
		return verdicts;
	};

	const inspect = async (toolName: string, input: unknown, ctx: ExtensionContext): Promise<string | null> => {
		if (toolName !== "task") return null;
		const call = parseTaskCall(input);
		if (call === null) return null;
		const deadline = AbortSignal.timeout(DEADLINE_MS);
		const budget: AttemptBudget = { kind: "split", deadlineAt: Date.now() + DEADLINE_MS };
		const judged: ItemVerdicts[] = (
			await Promise.all(
				call.items.map(async (item, index): Promise<ItemVerdicts | undefined> => {
					const covered = (await Promise.all(CHECKS.map(async (check) => ((await check.covers(ctx, item.agent)) ? [check] : [])))).flat();
					if (covered.length === 0) return undefined;
					const label = `\`${item.name ?? `item ${index + 1}`}\``;
					return {
						label,
						verdicts: await judgeItem(ctx, covered, call.context, item, label, deadline, budget),
					};
				}),
			)
		).filter((entry): entry is ItemVerdicts => entry !== undefined);
		if (judged.length === 0) return null;
		pi.logger.info("task-split-check verdicts", {
			verdicts: judged.map(({ label, verdicts }) => ({
				label,
				...Object.fromEntries([...verdicts].map(([check, verdict]) => [check.id, verdict])),
			})),
		});

		const reasons = CHECKS.flatMap((check) => {
			const flagged = judged.filter(({ verdicts }) => verdicts.get(check)?.kind === "flagged").map(({ label }) => label);
			return flagged.length === 0 ? [] : [check.reason(flagged.join("、"))];
		});
		return reasons.length === 0 ? null : reasons.join("\n");
	};

	// A throwing tool_call handler blocks the tool, so every failure lets the call run.
	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = await inspect(event.toolName, event.input, ctx);
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("task-split-check skipped a task call", { error: errorText(error) });
			return undefined;
		}
	});
}
