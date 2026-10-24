/**
 * Registers `tool_call`; takes its model from the OMP model role `@task-split-check` and writes no files. Split checks are main-only;
 * report-limit checks apply to main and sub sessions. Unexpected hook errors
 * are logged as warnings and let the call run.
 *
 * Dispatch checks for `task` / `fork_task` calls. Each check is one yes/no
 * question about an item (shared context + item task). Per item, every check
 * that covers it and still needs a verdict goes into ONE fast-model request
 * — prompt only, no tools, nothing read — that answers each question on its
 * own line. All items are judged concurrently under one deadline; when any
 * item is flagged by any check the whole call is blocked with the reasons of
 * every flagging check. Checks differ only in their definition:
 *
 * - `split`: main session `task` calls, items for `task:low` / `task:free` /
 *   `task:mid`; does the item cover more than one topic. A prompt that got a
 *   verdict passes unchanged the second time, so the main agent can force an
 *   item it judges to be one topic.
 * - `report-limit`: every session, `task` and `fork_task`, every task-series
 *   item (`task:*`, or `agent` omitted); does the dispatch cap the length of
 *   the worker's report. No re-dispatch bypass — the cap must go and long
 *   reports go to a file; only `false` prompts are remembered, to skip asking
 *   again.
 *
 * Memory is per process, keyed by check + sha256 of the item prompt.
 * The model is the OMP model role `@task-split-check` (assign it in `/model`), then the role named by
 * `fallbackRole` in the `task-split-check` section of omomp.*, both resolved at every request; a
 * provider failure moves to the next model of that chain. Every failure (no model in either role,
 * every model failing, unparseable answer, deadline) lets the item pass for the affected checks.
 * The deadline stays under the harness's 30 s `tool_call` handler timeout, which would otherwise
 * block the call.
 */
import { createHash } from "node:crypto";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import { modelLabel, roleModels, roleName } from "../_shared/roles.ts";

const configSchema = z.object({
	/** OMP model role (`smol`, `@smol`, …) whose models answer when `@task-split-check` resolves none or all of its models fail. */
	fallbackRole: z.string().min(1).optional(),
});
const omompSection = defineOmompSection(import.meta.dir, configSchema);
/** The OMP model role this extension's model comes from: the extension's own name. */
const ROLE = omompSection.id;
/** Effort when the role entry has no `:level` suffix. */
const EFFORT = THINKING_EFFORTS.find((effort) => effort === "medium");
if (EFFORT === undefined) throw new Error("task-split-check: host does not recognize medium reasoning effort");
const DEADLINE_MS = 25_000;

const taskItemSchema = z
	.object({
		task: z.string(),
		name: z.string().optional(),
		agent: z.string().optional(),
	})
	.passthrough();
const batchSchema = z.object({ context: z.string().optional(), tasks: z.array(taskItemSchema) }).passthrough();
type TaskItem = z.infer<typeof taskItemSchema>;
type TaskCall = { readonly context: string | undefined; readonly items: readonly TaskItem[] };

/** Batch calls carry `context` + `tasks[]`; the runtime still accepts a flat single item. */
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

/**
 * What a check remembers of a prompt it judged, and what that memory returns:
 * `pass-repeats` records every verdict and lets the same prompt through as
 * `repeat`; `skip-clear` records only `clear` verdicts and returns `clear`.
 */
type Memory = "pass-repeats" | "skip-clear";

type Check = {
	readonly id: string;
	readonly tools: Readonly<Record<string, true>>;
	readonly mainSessionOnly: boolean;
	readonly covers: (agent: string | undefined) => boolean;
	/** The question put to the model; `true` means the item is flagged. */
	readonly question: string;
	readonly memory: Memory;
	readonly reason: (labels: string) => string;
};

const SPLIT_AGENTS: Record<string, true> = { "task:low": true, "task:free": true, "task:mid": true };

const CHECKS: readonly Check[] = [
	{
		id: "split",
		tools: { task: true },
		mainSessionOnly: true,
		covers: (agent) => agent !== undefined && Object.hasOwn(SPLIT_AGENTS, agent),
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
		tools: { task: true, fork_task: true },
		mainSessionOnly: false,
		covers: (agent) => agent === undefined || agent.startsWith("task:"),
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
	["<shared-context>", context?.trim() || "(none)", "</shared-context>", "<assignment>", item.task.trim(), "</assignment>"].join("\n");

const itemLabel = (item: TaskItem, index: number): string => `\`${item.name ?? `item ${index + 1}`}\``;

/** `<check id>:<sha256 of item prompt>` for every prompt the check's memory keeps. */
const remembered = new Set<string>();

/** The verdict memory already holds for this check, or null when the model must be asked. */
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

type Reply = { readonly kind: "text"; readonly text: string } | { readonly kind: "failed"; readonly why: string };

type ItemVerdicts = { readonly label: string; readonly verdicts: ReadonlyMap<Check, Verdict> };

export default function taskSplitCheck(pi: ExtensionAPI): void {
	const ask = async (ctx: ExtensionContext, systemPrompt: string, prompt: string, signal: AbortSignal): Promise<Reply> => {
		const config = loadOmompSection(omompSection, ctx.cwd);
		const fallbackRole = config.kind === "found" ? config.value.fallbackRole : undefined;
		const failures: string[] = [];
		try {
			const models = roleModels(ctx, fallbackRole === undefined ? [ROLE] : [ROLE, fallbackRole]);
			if (models.length === 0) {
				return {
					kind: "failed",
					why: `no model: assign @${ROLE} in /model${fallbackRole === undefined ? "" : ` or @${roleName(fallbackRole)}`}`,
				};
			}
			for (const { model, level } of models) {
				if (signal.aborted) return { kind: "failed", why: "deadline" };
				try {
					const reply = await completeSimple(
						model,
						{
							systemPrompt: [systemPrompt],
							messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
						},
						level === "off"
							? { apiKey: ctx.modelRegistry.resolver(model), disableReasoning: true, signal }
							: { apiKey: ctx.modelRegistry.resolver(model), reasoning: level ?? EFFORT, signal },
					);
					if (reply.stopReason === "aborted") return { kind: "failed", why: "aborted" };
					if (reply.stopReason === "error") {
						failures.push(`${modelLabel(model)}: ${reply.errorMessage ?? "error"}`);
						continue;
					}
					return { kind: "text", text: textOf(reply.content) };
				} catch (error) {
					if (signal.aborted) return { kind: "failed", why: "deadline" };
					failures.push(`${modelLabel(model)}: ${errorText(error)}`);
				}
			}
			return { kind: "failed", why: `every model failed: ${failures.join("; ")}` };
		} catch (error) {
			return { kind: "failed", why: signal.aborted ? "deadline" : errorText(error) };
		}
	};

	/** One model request for every check of this item that memory cannot answer. */
	const judgeItem = async (
		ctx: ExtensionContext,
		checks: readonly Check[],
		prompt: string,
		signal: AbortSignal,
	): Promise<ReadonlyMap<Check, Verdict>> => {
		const hash = createHash("sha256").update(prompt).digest("hex");
		const keyOf = (check: Check): string => `${check.id}:${hash}`;
		const verdicts = new Map<Check, Verdict>();
		const pending: Check[] = [];
		for (const check of checks) {
			const known = recall(check, keyOf(check));
			if (known === null) pending.push(check);
			else verdicts.set(check, known);
		}
		if (pending.length === 0) return verdicts;

		const reply = await ask(ctx, renderSystemPrompt(pending), prompt, signal);
		for (const check of pending) {
			const verdict: Verdict = reply.kind === "text" ? parseAnswer(reply.text, check) : { kind: "unknown", why: reply.why };
			memorize(check, keyOf(check), verdict);
			verdicts.set(check, verdict);
		}
		return verdicts;
	};

	/** Returns the joined block reasons, or null to let the call run as written. */
	const inspect = async (toolName: string, input: unknown, ctx: ExtensionContext): Promise<string | null> => {
		const main = ctx.agent.kind === "main";
		const checks = CHECKS.filter((check) => Object.hasOwn(check.tools, toolName) && (main || !check.mainSessionOnly));
		if (checks.length === 0) return null;
		const call = parseTaskCall(input);
		if (call === null) return null;

		const deadline = AbortSignal.timeout(DEADLINE_MS);
		const judged: ItemVerdicts[] = await Promise.all(
			call.items.flatMap((item, index) => {
				const covering = checks.filter((check) => check.covers(item.agent));
				if (covering.length === 0) return [];
				return [
					(async (): Promise<ItemVerdicts> => ({
						label: itemLabel(item, index),
						verdicts: await judgeItem(ctx, covering, renderPrompt(call.context, item), deadline),
					}))(),
				];
			}),
		);
		if (judged.length === 0) return null;
		pi.logger.info("task-split-check verdicts", {
			verdicts: judged.map(({ label, verdicts }) => ({
				label,
				...Object.fromEntries([...verdicts].map(([check, verdict]) => [check.id, verdict])),
			})),
		});

		const reasons = checks.flatMap((check) => {
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
