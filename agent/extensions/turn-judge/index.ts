import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import { defineStatelessNoiseGuard, isCompacting, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { type InjectMode, producerMatches, targetsSession } from "../_shared/session-filter.ts";
import { discoverSpecFiles } from "../_shared/spec-files.ts";
import { type Comparison, parseSpecFile, type TurnJudgeSpec } from "./spec.ts";
import { fitState, type TimelineEntry, type TurnState } from "./state.ts";

const FILE_PATTERN = /^TURN-JUDGE-.+\.md$/i;
const JUDGE_TIMEOUT_MS = 90_000;
const SUB_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const REMINDER_MAX_CHARS = 400;
const PROMPT_CUSTOM_TYPE = "turn-judge";
const REMINDER_CUSTOM_TYPES: ReadonlySet<string> = new Set(["watchdog", PROMPT_CUSTOM_TYPE]);

type Verdict = Readonly<Record<string, number>>;

type JudgeResult = { readonly kind: "ok"; readonly verdict: Verdict } | { readonly kind: "failed"; readonly reason: string };

type Action = { readonly kind: "prompt"; readonly rule: string; readonly prompt: string } | { readonly kind: "info" };

type Judged =
	| { readonly kind: "failed"; readonly line: string }
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "prompt"; readonly line: string; readonly prompt: string; readonly inject: InjectMode };

type Report =
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "warning"; readonly line: string }
	| { readonly kind: "sent" };

type Delivery = { readonly kind: "sent" } | { readonly kind: "unsent"; readonly reason: string } | { readonly kind: "unconfirmed" };

type Prepared = { readonly spec: TurnJudgeSpec; readonly state: TurnState };

type Admission = { readonly matches: (message: AgentMessage) => boolean; readonly settle: (admitted: boolean) => void };

type AdmissionWatcher = {
	watch(matches: (message: AgentMessage) => boolean, signal: AbortSignal): Promise<boolean>;
};

type SubPrompts = { readonly system: string; readonly user: string };

type SubTurn = {
	readonly specs: readonly TurnJudgeSpec[];
	readonly timeline: readonly TimelineEntry[];
	readonly reply: string;
	readonly judgedTimestamp: number;
	readonly deadline: AbortSignal;
};

const warnedFiles = new Set<string>();

function notify(pi: ExtensionAPI, ctx: ExtensionContext, lines: readonly string[], level: "info" | "warning"): void {
	if (lines.length === 0) return;
	const text = lines.join("\n");
	if (ctx.hasUI) ctx.ui.notify(text, level);
	if (level === "warning") pi.logger.warn(text);
	else pi.logger.info(text);
}

function applyingSpecs(pi: ExtensionAPI, ctx: ExtensionContext, message: AssistantMessage): TurnJudgeSpec[] {
	const specs: TurnJudgeSpec[] = [];
	const warnings: string[] = [];
	for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
		const parsed = parseSpecFile(path);
		switch (parsed.kind) {
			case "ok":
				if (targetsSession(parsed.spec.filter, ctx.agent, ctx.cwd) && producerMatches(parsed.spec.filter, message)) specs.push(parsed.spec);
				break;
			case "disabled":
				break;
			case "invalid": {
				const key = `${path}\0${parsed.reason}`;
				if (warnedFiles.has(key)) break;
				warnedFiles.add(key);
				warnings.push(tr(`turn-judge: skipped ${path}: ${parsed.reason}`, `turn-judge：跳过 ${path}：${parsed.reason}`));
				break;
			}
			default: {
				const unreachable: never = parsed;
				return unreachable;
			}
		}
	}
	notify(pi, ctx, warnings, "warning");
	return specs;
}

function* ancestors(ctx: ExtensionContext): Generator<SessionEntry> {
	const visited = new Set<string>();
	for (let id = ctx.sessionManager.getLeafId(); id !== null && !visited.has(id); ) {
		visited.add(id);
		const entry = ctx.sessionManager.getEntry(id);
		if (entry === undefined) return;
		yield entry;
		id = entry.parentId;
	}
}

function assistantEvents(message: AssistantMessage, withText: boolean): TimelineEntry[] {
	const events: TimelineEntry[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "thinking": {
				const text = block.thinking.trim();
				if (text !== "") events.push({ 类型: block.narration === true ? "模型说" : "模型想", 内容: text });
				break;
			}
			case "text": {
				const text = block.text.trim();
				if (withText && text !== "") events.push({ 类型: "模型说", 内容: text });
				break;
			}
			case "toolCall": {
				const intent = block.intent?.trim();
				events.push({ 类型: "模型调用工具", 内容: intent ? `${block.name}：${intent}` : block.name });
				break;
			}
			default:
				break;
		}
	}
	return events;
}

function reminder(text: string): TimelineEntry {
	return { 类型: "提醒", 内容: text.length > REMINDER_MAX_CHARS ? `${text.slice(0, REMINDER_MAX_CHARS)}…` : text };
}

function toolCallsSinceLastStop(ctx: ExtensionContext, judged: AssistantMessage): ReadonlySet<string> {
	const calls = new Set<string>();
	for (const entry of ancestors(ctx)) {
		if (entry.type !== "message" || entry.message.timestamp >= judged.timestamp) continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "stop") break;
		for (const block of message.content) if (block.type === "toolCall") calls.add(block.name);
	}
	return calls;
}

function timelineSinceHumanInput(ctx: ExtensionContext, judged: AssistantMessage): TimelineEntry[] {
	const main = ctx.agent.kind === "main";
	const newestFirst = assistantEvents(judged, false)
		.filter((event) => event.类型 !== "模型调用工具")
		.reverse();
	for (const entry of ancestors(ctx)) {
		if (entry.type === "custom_message") {
			if (!REMINDER_CUSTOM_TYPES.has(entry.customType) || Date.parse(entry.timestamp) >= judged.timestamp) continue;
			const text = textOf(entry.content, "\n").trim();
			if (text !== "") newestFirst.push(reminder(text));
			continue;
		}
		if (entry.type !== "message" || entry.message.timestamp >= judged.timestamp) continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = textOf(message.content, "\n").trim();
			if (text === "") continue;
			if (message.synthetic !== true && (!main || message.attribution === "user")) {
				newestFirst.push({ 类型: "用户说", 内容: text });
				break;
			}
			newestFirst.push(reminder(text));
		} else if (message.role === "assistant") {
			newestFirst.push(...assistantEvents(message, true).reverse());
		} else if (message.role === "toolResult") {
			const answers = askAnswers(message);
			if (answers !== null) newestFirst.push({ 类型: "用户在ask中回答", 内容: formatAskAnswers(answers) });
		}
	}
	return newestFirst.reverse();
}

function hasMessageAfter(ctx: ExtensionContext, judgedTimestamp: number): boolean {
	for (const entry of ancestors(ctx)) if (entry.type === "message") return entry.message.timestamp > judgedTimestamp;
	return false;
}

async function runJudge(judge: Judge, spec: TurnJudgeSpec, state: TurnState, signal: AbortSignal): Promise<JudgeResult> {
	try {
		const result = await judge.judge({ state, questions: spec.questions }, { signal });
		const verdict: Record<string, number> = {};
		for (const id of Object.keys(spec.questions)) {
			const answer = result.answers[id];
			if (answer === undefined) return { kind: "failed", reason: tr(`no answer for question.${id}`, `question.${id} 没有回答`) };
			verdict[id] = answer.noul;
		}
		return { kind: "ok", verdict };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

function holds(condition: Comparison, verdict: Verdict): boolean {
	const p = verdict[condition.question] ?? 0;
	switch (condition.op) {
		case "atLeast":
			return p >= condition.value;
		case "below":
			return p < condition.value;
		default: {
			const unreachable: never = condition.op;
			return unreachable;
		}
	}
}

function decide(spec: TurnJudgeSpec, verdict: Verdict): Action {
	const rule = spec.rules.find((r) => r.conditions.every((c) => holds(c, verdict)));
	return rule === undefined ? { kind: "info" } : { kind: "prompt", rule: rule.name, prompt: spec.prompt };
}

function describeVerdict(spec: TurnJudgeSpec, verdict: Verdict, action: Action): string {
	const parts = Object.keys(spec.questions)
		.map((id) => `${id} ${(verdict[id] ?? 0).toFixed(2)}`)
		.join(" · ");
	switch (action.kind) {
		case "prompt":
			return tr(`turn-judge ${spec.name}: when.${action.rule} (${parts})`, `turn-judge ${spec.name}：when.${action.rule}（${parts}）`);
		case "info":
			return tr(`turn-judge ${spec.name}: no rule (${parts})`, `turn-judge ${spec.name}：未命中规则（${parts}）`);
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

function prepareJudgments(specs: readonly TurnJudgeSpec[], timeline: readonly TimelineEntry[], reply: string): Prepared[] {
	const byBudget = new Map<number, TurnState>();
	return specs.map((spec) => {
		let state = byBudget.get(spec.maxBytes);
		if (state === undefined) {
			state = fitState(timeline, reply, spec.maxBytes);
			byBudget.set(spec.maxBytes, state);
		}
		return { spec, state };
	});
}

async function judgeSpec(judge: Judge, spec: TurnJudgeSpec, state: TurnState, signal: AbortSignal): Promise<Judged> {
	const result = await runJudge(judge, spec, state, signal);
	if (result.kind === "failed")
		return {
			kind: "failed",
			line: tr(`turn-judge ${spec.name}: judgment failed (${result.reason})`, `turn-judge ${spec.name}：判断失败（${result.reason}）`),
		};
	const action = decide(spec, result.verdict);
	const line = describeVerdict(spec, result.verdict, action);
	switch (action.kind) {
		case "info":
			return { kind: "info", line };
		case "prompt":
			return { kind: "prompt", line, prompt: action.prompt, inject: spec.inject };
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

async function waitUntil(ready: () => boolean, signal: AbortSignal): Promise<boolean> {
	while (!ready()) {
		if (signal.aborted) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

function createAdmissionWatcher(pi: ExtensionAPI): AdmissionWatcher {
	const pending = new Set<Admission>();
	pi.on("message_start", (event) => {
		for (const admission of pending) if (admission.matches(event.message)) admission.settle(true);
	});
	return {
		watch(matches, signal) {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const admission: Admission = {
				matches,
				settle(admitted) {
					pending.delete(admission);
					signal.removeEventListener("abort", abort);
					resolve(admitted);
				},
			};
			const abort = () => admission.settle(false);
			pending.add(admission);
			if (signal.aborted) admission.settle(false);
			else signal.addEventListener("abort", abort, { once: true });
			return promise;
		},
	};
}

// Do not return before the new turn is admitted: the executor would collect the judged reply instead.
async function deliverToSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	admissions: AdmissionWatcher,
	prompts: SubPrompts,
	turn: SubTurn,
): Promise<Delivery> {
	const { deadline, judgedTimestamp } = turn;
	if (deadline.aborted) return { kind: "unsent", reason: tr("judgment timed out", "判断超出时限") };
	if (!(await waitUntil(() => ctx.isIdle(), deadline)))
		return { kind: "unsent", reason: tr("subagent did not become idle in time", "时限内子会话未空闲") };
	if (hasMessageAfter(ctx, judgedTimestamp))
		return { kind: "unsent", reason: tr("a new message arrived before the judgment returned", "判断返回前已有新消息") };
	let admitted: Promise<boolean>;
	if (prompts.user === "") {
		const deliveryId = crypto.randomUUID();
		admitted = admissions.watch(
			(message) =>
				message.role === "custom" &&
				message.customType === PROMPT_CUSTOM_TYPE &&
				typeof message.details === "object" &&
				message.details !== null &&
				"deliveryId" in message.details &&
				message.details.deliveryId === deliveryId,
			deadline,
		);
		pi.sendMessage(
			{ customType: PROMPT_CUSTOM_TYPE, content: prompts.system, display: true, attribution: "agent", details: { deliveryId } },
			{ triggerTurn: true },
		);
	} else {
		if (prompts.system !== "")
			pi.sendMessage(
				{ customType: PROMPT_CUSTOM_TYPE, content: prompts.system, display: true, attribution: "agent" },
				{ deliverAs: "steer" },
			);
		admitted = admissions.watch((message) => message.role === "user" && message.timestamp > judgedTimestamp, deadline);
		pi.sendUserMessage(prompts.user, { attribution: "agent" });
	}
	return (await admitted) ? { kind: "sent" } : { kind: "unconfirmed" };
}

function deliveryLines(delivery: Delivery, triggered: readonly Judged[], tag: string): Report[] {
	switch (delivery.kind) {
		case "sent":
			return triggered.map((t) => ({ kind: "info", line: tr(`${t.line} → prompt (${tag})`, `${t.line} → 提示（${tag}）`) }));
		case "unsent":
			return triggered.map((t) => ({
				kind: "info",
				line: tr(`${t.line}; ${delivery.reason}, prompt not sent (${tag})`, `${t.line}；${delivery.reason}，未发送提示（${tag}）`),
			}));
		case "unconfirmed":
			return triggered.map((t) => ({
				kind: "warning",
				line: tr(
					`${t.line} → prompt (${tag}); the start of a new turn was not confirmed within the deadline, so the parent agent may receive the original reply`,
					`${t.line} → 提示（${tag}）；时限内未确认新回合开始，父代理可能收到原回复`,
				),
			}));
		default: {
			const unreachable: never = delivery;
			return unreachable;
		}
	}
}

function notifyReports(pi: ExtensionAPI, ctx: ExtensionContext, reports: readonly Report[]): void {
	notify(
		pi,
		ctx,
		reports.flatMap((r) => (r.kind === "warning" ? [r.line] : [])),
		"warning",
	);
	notify(
		pi,
		ctx,
		reports.flatMap((r) => (r.kind === "info" ? [r.line] : [])),
		"info",
	);
}

async function judgeSubagentTurn(pi: ExtensionAPI, ctx: ExtensionContext, admissions: AdmissionWatcher, turn: SubTurn): Promise<void> {
	const opened = openJudge(ctx, "turn-judge");
	if (opened.kind === "inactive") return;
	const judged = await Promise.all(
		prepareJudgments(turn.specs, turn.timeline, turn.reply).map(({ spec, state }) => judgeSpec(opened.judge, spec, state, turn.deadline)),
	);
	const reports: Report[] = judged.flatMap((j): Report[] => {
		switch (j.kind) {
			case "failed":
				return [{ kind: "warning", line: j.line }];
			case "info":
				return [{ kind: "info", line: j.line }];
			case "prompt":
				return [];
			default: {
				const unreachable: never = j;
				return unreachable;
			}
		}
	});
	const triggered = judged.flatMap((j) => (j.kind === "prompt" ? [j] : []));
	if (triggered.length > 0) {
		const joined = (inject: InjectMode): string =>
			triggered
				.filter((t) => t.inject === inject)
				.map((t) => t.prompt)
				.join("\n\n");
		const delivery = await deliverToSubagent(pi, ctx, admissions, { system: joined("system"), user: joined("user") }, turn);
		reports.push(...deliveryLines(delivery, triggered, `${ctx.agent.name} (${ctx.agent.id})`));
	}
	notifyReports(pi, ctx, reports);
}

export default function turnJudge(pi: ExtensionAPI): void {
	const admissions = createAdmissionWatcher(pi);
	let epoch = 0;

	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/turn-judge",
			renderNoiseGuardDirective: () =>
				'`customType: "turn-judge"` prompts are automated single-turn judge nudges — NEVER record them as permanent user constraints or session rulings in the summary.',
		}),
	);

	const settleMain = (ctx: ExtensionContext, judged: Judged, startedAt: number): Report => {
		switch (judged.kind) {
			case "failed":
				return { kind: "warning", line: judged.line };
			case "info":
				return { kind: "info", line: judged.line };
			case "prompt":
				if (epoch !== startedAt || isCompacting(ctx.sessionManager))
					return {
						kind: "info",
						line: tr(
							`${judged.line}; new input or compaction arrived before the judgment returned, prompt not sent`,
							`${judged.line}；判断返回前已有新输入或正在压缩，未发送提示`,
						),
					};
				pi.logger.info(`${judged.line} → prompt (${judged.inject})`);
				switch (judged.inject) {
					case "system":
						pi.sendMessage(
							{ customType: PROMPT_CUSTOM_TYPE, content: judged.prompt, display: true, attribution: "agent" },
							ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
						);
						return { kind: "sent" };
					case "user":
						pi.sendUserMessage(judged.prompt, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
						return { kind: "sent" };
					default: {
						const unreachable: never = judged.inject;
						return unreachable;
					}
				}
			default: {
				const unreachable: never = judged;
				return unreachable;
			}
		}
	};

	const judgeMainTurnInBackground = (
		ctx: ExtensionContext,
		specs: readonly TurnJudgeSpec[],
		timeline: readonly TimelineEntry[],
		reply: string,
	): void => {
		const startedAt = epoch;
		const opened = openJudge(ctx, "turn-judge");
		if (opened.kind === "inactive") return;
		void Promise.all(
			prepareJudgments(specs, timeline, reply).map(async ({ spec, state }) =>
				settleMain(ctx, await judgeSpec(opened.judge, spec, state, AbortSignal.timeout(JUDGE_TIMEOUT_MS)), startedAt),
			),
		)
			.then((reports) => notifyReports(pi, ctx, reports))
			.catch((error) => {
				pi.logger.warn("turn-judge: background judgment failed", { error: errorText(error) });
			});
	};

	pi.on("input", (event) => {
		if (event.source !== "extension") epoch += 1;
	});
	pi.on("session_switch", () => {
		epoch += 1;
	});
	pi.on("session_branch", () => {
		epoch += 1;
	});
	pi.on("session_tree", () => {
		epoch += 1;
	});
	pi.on("session_before_compact", () => {
		epoch += 1;
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			const message = event.message;
			if (message.role !== "assistant" || message.stopReason !== "stop") return;
			const reply = textOf(message.content, "\n").trim();
			if (reply === "") return;
			const scoped = applyingSpecs(pi, ctx, message);
			if (scoped.length === 0) return;
			const calls = toolCallsSinceLastStop(ctx, message);
			const specs = scoped.filter((spec) => calls.isDisjointFrom(spec.skipTools));
			if (specs.length === 0) return;
			const timeline = timelineSinceHumanInput(ctx, message);
			switch (ctx.agent.kind) {
				case "main":
					judgeMainTurnInBackground(ctx, specs, timeline, reply);
					return;
				case "sub":
					await judgeSubagentTurn(pi, ctx, admissions, {
						specs,
						timeline,
						reply,
						judgedTimestamp: message.timestamp,
						deadline: AbortSignal.timeout(SUB_DEADLINE_MS),
					});
					return;
				default: {
					const unreachable: never = ctx.agent.kind;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
		}
	});
}
