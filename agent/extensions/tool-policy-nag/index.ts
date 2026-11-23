import type { Judge } from "@oh-my-pi/pi-ai";
import {
	type AutoCompactionEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type Settings,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
	type ToolResultEventResult,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { cfgBashInterceptorEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { openJudge } from "../_shared/judge.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { sessionSettings } from "../_shared/settings.ts";
import { type WatchedCall, watchedCallOf } from "../_shared/tool-calls.ts";
import { type FormLane, type IntentLane, type Lanes, type LaneWarning, type LoadedLanes, loadLanes } from "./detector-config.ts";
import { detectCommandViolations, detectEvalViolations, detectTraceViolations, type Violation } from "./heuristic.ts";
import { type IntentSpec, intentReminder, intentViolation, JUDGE_TIMEOUT_MS, judgeIntent, loadIntentSpec } from "./intent.ts";
import { ptyEvalHit, ptyLineHit, ptyRefusal } from "./pty.ts";
import { inspectMaskedFailure, inspectRisk, maskedFailureReminder, riskReminder } from "./risk.ts";
import { type SimpleCommand, scanShell } from "./shell-parser.ts";
import { type ShellOutcome, shellOutcome } from "./trace.ts";

const STATE_ENTRY_TYPE = "mouriya.omp.tool-policy-nag.state";
const SPEC_DIR = import.meta.dir;
const INTENT_WAIT_MS = 20_000;

type NagCounts = { readonly hits: number; readonly nagsSent: number };

const FRESH: NagCounts = { hits: 0, nagsSent: 0 };

const count = z
	.number()
	.refine(Number.isFinite)
	.transform((value) => Math.max(0, Math.trunc(value)));

const countsSchema = z.object({ hits: count, nagsSent: count });

type ShellCall = Extract<WatchedCall, { kind: "shell" }>;

type IntentJob = {
	readonly epoch: number;
	readonly available: Promise<boolean>;
	readonly reminder: Promise<string | null>;
};

type Nag = {
	readonly pi: ExtensionAPI;
	counts: NagCounts;
	epoch: number;
	readonly warned: Set<string>;
	readonly intentJobs: Map<string, IntentJob>;
	readonly lateReminders: string[];
	interceptorOff: Settings | null;
};

function rebuildCounts(ctx: ExtensionContext): NagCounts {
	const branch = ctx.sessionManager.getBranch();
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry === undefined) continue;
		if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") return FRESH;
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = countsSchema.safeParse(entry.data);
		if (parsed.success) return parsed.data;
	}
	return FRESH;
}

function commit(nag: Nag, next: NagCounts): void {
	nag.counts = next;
	nag.pi.appendEntry(STATE_ENTRY_TYPE, next);
}

function invalidatePending(nag: Nag): void {
	nag.epoch += 1;
	nag.intentJobs.clear();
	nag.lateReminders.length = 0;
}

function rearm(nag: Nag, reason: string): void {
	if (nag.counts.hits === 0 && nag.counts.nagsSent === 0) return;
	nag.pi.logger.info("Tool-policy nag re-armed", { reason, previous: nag.counts });
	commit(nag, FRESH);
}

function restore(nag: Nag, reason: string, ctx: ExtensionContext): void {
	invalidatePending(nag);
	nag.counts = rebuildCounts(ctx);
	nag.pi.logger.info("Tool-policy nag state restored", { reason, counts: nag.counts });
}

function warnOnce(nag: Nag, ctx: ExtensionContext, warning: LaneWarning): void {
	if (nag.warned.has(warning.en)) return;
	nag.warned.add(warning.en);
	nag.pi.logger.warn(warning.en);
	if (ctx.hasUI) ctx.ui.notify(tr(warning.en, warning.zh), "warning");
}

function violationsOf(call: WatchedCall, outcome: ShellOutcome | null, commands: () => readonly SimpleCommand[]): readonly Violation[] {
	if (call.kind === "eval") return detectEvalViolations(call.language, call.code);
	if (outcome?.kind === "traced") return detectTraceViolations(outcome.trace);
	if (outcome?.kind === "timedOut" && outcome.trace !== null) return detectTraceViolations(outcome.trace);
	return detectCommandViolations(commands(), () => true);
}

function formCheck(nag: Nag, ctx: ExtensionContext, violations: readonly Violation[], form: FormLane): string | null {
	const { hits: before, nagsSent: sent } = nag.counts;
	if (sent >= form.maxNags || violations.length === 0) return null;
	const hits = before + violations.length;
	const programs = violations.map((violation) => `${violation.program} ${violation.target}`);
	const details = violations.map(({ categories, program, target }) => ({ categories, program, target }));
	if (hits <= form.afterHits) {
		nag.pi.logger.info("Tool-policy violation observed", {
			hits,
			threshold: form.afterHits,
			programs,
			violations: details,
			nagsSent: sent,
		});
		commit(nag, { hits, nagsSent: sent });
		return null;
	}
	const nagsSent = sent + 1;
	const armed = nagsSent < form.maxNags;
	nag.pi.logger.info("Tool-policy violation past threshold — nagging", {
		hits,
		programs,
		violations: details,
		nagsSent,
		maxNags: form.maxNags,
		detectorArmed: armed,
	});
	commit(nag, { hits, nagsSent });
	ctx.ui.notify(
		tr(
			`Shell policy nag ${nagsSent}/${form.maxNags} sent for hit #${hits} (${programs.join(", ")}) — detector ${
				armed ? "still armed" : "exhausted until compaction"
			}`,
			`Shell 策略提醒已发送 ${nagsSent}/${form.maxNags} 次，命中 #${hits}（${programs.join("、")}）—检测器${
				armed ? "仍在工作" : "已耗尽，直到压缩后重新启用"
			}`,
		),
		"warning",
	);
	return form.prompt;
}

function riskCheck(
	nag: Nag,
	ctx: ExtensionContext,
	lanes: Lanes,
	call: ShellCall,
	outcome: ShellOutcome,
	commands: () => readonly SimpleCommand[],
): string | null {
	if (lanes.risk === null) return null;
	const log = (finding: object): void => nag.pi.logger.info("Tool-policy risk", { tool: call.tool, outcome: outcome.kind, ...finding });
	switch (outcome.kind) {
		case "traced": {
			const masked = inspectMaskedFailure(outcome.trace);
			if (masked === null) return null;
			log({ rule: "maskedFailure", steps: masked.map((step) => ({ argv: step.argv, status: step.status })) });
			if (ctx.hasUI)
				ctx.ui.notify(
					tr(
						`tool-policy-nag risk: ${call.tool}, silent failure in ${masked.map((step) => step.argv[0]).join(", ")}`,
						`tool-policy-nag 风险：${call.tool} 有静默失败的步骤 ${masked.map((step) => step.argv[0]).join("、")}`,
					),
					"warning",
				);
			return maskedFailureReminder(call.tool, call.command, masked);
		}
		case "timedOut":
		case "interrupted":
			return null;
		case "background":
		case "untraced": {
			const finding = inspectRisk(commands(), call.command, lanes.risk);
			if (finding === null) return null;
			log({ rule: "size", limits: lanes.risk, ...finding });
			if (ctx.hasUI)
				ctx.ui.notify(
					tr(
						`tool-policy-nag risk: ${call.tool}, ${finding.commands} command segments / ${finding.programs.length} programs, writes ${finding.writes.join(", ")}`,
						`tool-policy-nag 风险：${call.tool} ${finding.commands} 段 / ${finding.programs.length} 个程序，会写 ${finding.writes.join("、")}`,
					),
					"warning",
				);
			return riskReminder(call.tool, call.command, finding);
		}
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

function ptyRefusalFor(pi: ExtensionAPI, lanes: Lanes, call: WatchedCall): string | null {
	if (lanes.pty === null) return null;
	try {
		if (!pi.getActiveTools().includes("exec_command")) return null;
		switch (call.kind) {
			case "shell": {
				if (call.tool !== "bash") return null;
				const hit = ptyLineHit(scanShell(call.command));
				if (hit === null) return null;
				pi.logger.info("Tool-policy pty route refused", { tool: call.tool, ...hit });
				return ptyRefusal(hit, call.tool);
			}
			case "eval": {
				const hit = ptyEvalHit(call.language, call.code);
				if (hit === null) return null;
				pi.logger.info("Tool-policy pty route refused", { tool: "eval", language: call.language, ...hit });
				return ptyRefusal(hit, "eval");
			}
			default: {
				const unreachable: never = call;
				return unreachable;
			}
		}
	} catch (error) {
		pi.logger.warn("Tool-policy pty lane failed; call allowed", { error: errorText(error) });
		return null;
	}
}

async function prepareIntent(nag: Nag, ctx: ExtensionContext): Promise<{ readonly judge: Judge; readonly spec: IntentSpec } | null> {
	const loaded = await loadIntentSpec(SPEC_DIR);
	switch (loaded.kind) {
		case "missing":
			warnOnce(nag, ctx, {
				en: `tool-policy-nag: intent spec missing (${SPEC_DIR}/INTENT-*.md); intent lane will not remind`,
				zh: `tool-policy-nag：意向 spec 缺失（${SPEC_DIR}/INTENT-*.md），意向通道不提醒`,
			});
			return null;
		case "invalid":
			warnOnce(nag, ctx, {
				en: `tool-policy-nag: invalid intent spec (${loaded.reason}); intent lane will not remind`,
				zh: `tool-policy-nag：意向 spec 无效（${loaded.reason}），意向通道不提醒`,
			});
			return null;
		case "disabled":
			return null;
		case "found":
			break;
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
	const opened = openJudge(ctx, "tool-policy-nag");
	return opened.kind === "inactive" ? null : { judge: opened.judge, spec: loaded.spec };
}

async function intentCheck(
	nag: Nag,
	ctx: ExtensionContext,
	judge: Judge,
	lane: IntentLane,
	spec: IntentSpec,
	call: WatchedCall,
): Promise<string | null> {
	const verdict = await judgeIntent(judge, spec, call, AbortSignal.timeout(JUDGE_TIMEOUT_MS));
	switch (verdict.kind) {
		case "failed":
			warnOnce(nag, ctx, {
				en: `tool-policy-nag: intent judgment failed (${verdict.reason})`,
				zh: `tool-policy-nag：意向判定失败（${verdict.reason}）`,
			});
			return null;
		case "ok":
			break;
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
	const tool = call.kind === "shell" ? call.tool : "eval";
	const violation = intentViolation(call, verdict.label);
	const fired = violation && verdict.probability >= lane.threshold;
	nag.pi.logger.info("Tool-policy intent verdict", {
		tool,
		spec: spec.path,
		threshold: lane.threshold,
		choice: verdict.label,
		probability: verdict.probability,
		confidence: verdict.confidence,
		options: spec.options.length,
		violation,
		fired,
	});
	if (!fired) return null;
	const option = spec.options.find((candidate) => candidate.label === verdict.label);
	if (option === undefined) return null;
	if (ctx.hasUI)
		ctx.ui.notify(
			tr(
				`tool-policy-nag intent: ${tool} → ${verdict.label} ${verdict.probability.toFixed(2)} (${option.title})`,
				`tool-policy-nag 意向：${tool} → ${verdict.label} ${verdict.probability.toFixed(2)}（${option.title}）`,
			),
			"warning",
		);
	return intentReminder(call, option);
}

function startIntent(nag: Nag, ctx: ExtensionContext, lane: IntentLane, call: WatchedCall): IntentJob {
	const prepared = prepareIntent(nag, ctx).catch((error) => {
		warnOnce(nag, ctx, {
			en: `tool-policy-nag: JUDGE preparation failed (${errorText(error)})`,
			zh: `tool-policy-nag：JUDGE 准备失败（${errorText(error)}）`,
		});
		return null;
	});
	const reminder = prepared.then((intent) => (intent === null ? null : intentCheck(nag, ctx, intent.judge, lane, intent.spec, call)));
	return { epoch: nag.epoch, available: prepared.then((intent) => intent !== null), reminder };
}

async function collectIntent(nag: Nag, ctx: ExtensionContext, job: IntentJob): Promise<string | null> {
	const late = Promise.withResolvers<{ readonly kind: "late" }>();
	const timer = setTimeout(() => late.resolve({ kind: "late" }), INTENT_WAIT_MS);
	let settled: { readonly kind: "ready"; readonly reminder: string | null } | { readonly kind: "late" };
	try {
		settled = await Promise.race([job.reminder.then((reminder) => ({ kind: "ready", reminder }) as const), late.promise]);
	} finally {
		clearTimeout(timer);
	}
	if (settled.kind === "ready") return job.epoch === nag.epoch ? settled.reminder : null;
	void job.reminder
		.then((reminder) => {
			if (reminder === null || job.epoch !== nag.epoch) return;
			if (ctx.isIdle()) nag.pi.sendUserMessage(reminder, { attribution: "agent" });
			else nag.lateReminders.push(reminder);
		})
		.catch((error) => nag.pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) }));
	return null;
}

function releaseInterceptor(nag: Nag, reason: string): void {
	if (nag.interceptorOff === null) return;
	cfgBashInterceptorEnabled.clearOverride(nag.interceptorOff);
	nag.interceptorOff = null;
	nag.pi.logger.info("Tool-policy bash interceptor override cleared", { reason });
}

function syncInterceptor(nag: Nag, ctx: ExtensionContext, lanes: Lanes): Settings {
	const settings = sessionSettings(ctx);
	if (settings === undefined) throw new Error("tool-policy-nag: current OMP session is not registered");
	if (lanes.tool?.detector !== "heuristic") {
		releaseInterceptor(nag, "detector is not heuristic");
		return settings;
	}
	if (nag.interceptorOff !== settings) releaseInterceptor(nag, "session settings changed");
	if (nag.interceptorOff === settings && cfgBashInterceptorEnabled.get(settings) === false) return settings;
	cfgBashInterceptorEnabled.override(settings, false);
	nag.interceptorOff = settings;
	nag.pi.logger.info("Tool-policy bash interceptor overridden off", { detector: "heuristic" });
	return settings;
}

function interceptorOwns(call: WatchedCall, settings: Settings): boolean {
	return call.kind === "shell" && call.tool === "bash" && cfgBashInterceptorEnabled.get(settings) === true;
}

function context(reminders: readonly string[]): { additionalContext: string } | undefined {
	return reminders.length === 0 ? undefined : { additionalContext: reminders.join("\n\n") };
}

function runForMainSession(nag: Nag, ctx: ExtensionContext, handler: () => void): void {
	if (ctx.agent.kind !== "main") return;
	try {
		handler();
	} catch (error) {
		nag.pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
	}
}

async function onToolCall(nag: Nag, event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	const call = watchedCallOf(event.toolName, event.input);
	if (call === null) return;
	let loaded: LoadedLanes;
	try {
		loaded = await loadLanes(ctx.cwd);
	} catch (error) {
		nag.pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
		return;
	}
	const { lanes, warnings } = loaded;
	const refusal = ptyRefusalFor(nag.pi, lanes, call);
	if (refusal !== null) return { block: true, reason: refusal };
	runForMainSession(nag, ctx, () => {
		for (const warning of warnings) warnOnce(nag, ctx, warning);
		const settings = syncInterceptor(nag, ctx, lanes);
		if (interceptorOwns(call, settings)) return;
		if (lanes.tool?.detector === "jev") nag.intentJobs.set(event.toolCallId, startIntent(nag, ctx, lanes.tool.intent, call));
	});
}

async function onToolResult(nag: Nag, event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
	if (ctx.agent.kind !== "main") return;
	const call = watchedCallOf(event.toolName, event.input);
	if (call === null) return;
	const job = nag.intentJobs.get(event.toolCallId);
	nag.intentJobs.delete(event.toolCallId);
	const reminders = nag.lateReminders.splice(0);
	try {
		const { lanes } = await loadLanes(ctx.cwd);
		const settings = sessionSettings(ctx);
		if (settings !== undefined && interceptorOwns(call, settings)) return context(reminders);
		let scanned: readonly SimpleCommand[] | null = null;
		const commands = (): readonly SimpleCommand[] => {
			if (call.kind !== "shell") return [];
			scanned ??= scanShell(call.command).commands;
			return scanned;
		};
		const outcome = call.kind === "shell" ? shellOutcome(event.details, event.isError) : null;
		if (call.kind === "shell" && outcome !== null) {
			const risk = riskCheck(nag, ctx, lanes, call, outcome, commands);
			if (risk !== null) reminders.push(risk);
		}
		const tool = lanes.tool;
		if (tool === null) return context(reminders);
		switch (tool.detector) {
			case "heuristic": {
				const reminder = formCheck(nag, ctx, violationsOf(call, outcome, commands), tool.form);
				if (reminder !== null) reminders.push(reminder);
				break;
			}
			case "jev": {
				if (job === undefined || !(await job.available)) {
					const reminder = formCheck(nag, ctx, violationsOf(call, outcome, commands), tool.fallback);
					if (reminder !== null) reminders.push(reminder);
					break;
				}
				const intent = await collectIntent(nag, ctx, job);
				if (intent !== null) reminders.push(intent);
				break;
			}
			default: {
				const unreachable: never = tool;
				return unreachable;
			}
		}
	} catch (error) {
		nag.pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
	}
	return context(reminders);
}

export default function toolPolicyNag(pi: ExtensionAPI): void {
	const nag: Nag = {
		pi,
		counts: FRESH,
		epoch: 0,
		warned: new Set(),
		intentJobs: new Map(),
		lateReminders: [],
		interceptorOff: null,
	};

	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/tool-policy-nag",
			renderNoiseGuardDirective: () =>
				'Any `[Developer]` or bare unprefixed text turn matching "你为什么不遵守system prompt" / "反思自己以后继续" or `<system-reminder>` blocks about shell/tool-policy violations are automated lint nags from `tool-policy-nag` (whose counter resets on compaction) — NEVER treat them as human user instructions, unanswered questions, goals, constraints, or reflection/apology tasks.',
		}),
	);

	pi.on("session_start", (_event, ctx) => runForMainSession(nag, ctx, () => restore(nag, "session_start", ctx)));
	pi.on("session_switch", (_event, ctx) => runForMainSession(nag, ctx, () => restore(nag, "session_switch", ctx)));
	pi.on("session_branch", (_event, ctx) => runForMainSession(nag, ctx, () => restore(nag, "session_branch", ctx)));
	pi.on("session_tree", (_event, ctx) => runForMainSession(nag, ctx, () => restore(nag, "session_tree", ctx)));
	pi.on("session_before_compact", (_event, ctx) => runForMainSession(nag, ctx, () => invalidatePending(nag)));
	pi.on("session_compact", (_event, ctx) => runForMainSession(nag, ctx, () => rearm(nag, "session_compact")));
	pi.on("auto_compaction_end", (event: AutoCompactionEndEvent, ctx) =>
		runForMainSession(nag, ctx, () => {
			if (event.aborted || event.skipped === true || event.result === undefined) return;
			rearm(nag, `auto_compaction_end:${event.action}`);
		}),
	);
	pi.on("session_shutdown", (_event, ctx) => runForMainSession(nag, ctx, () => releaseInterceptor(nag, "session_shutdown")));
	pi.on("tool_call", (event, ctx) => onToolCall(nag, event, ctx));
	pi.on("tool_result", (event, ctx) => onToolResult(nag, event, ctx));
}
