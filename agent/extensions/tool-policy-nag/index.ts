/**
 * Watches host shell commands and eval code; plugin calls are ignored. Four
 * lanes, each with its own scope, hook and effect:
 *
 * - `pty` (`pty.ts`) — main AND sub sessions, BLOCKING, at `tool_call`. A
 *   `bash` call (direct, or a write to `xd://bash`; `pty: true` does not
 *   exempt it) or an eval cell that starts a passthrough, terminal or
 *   open-ended command is refused before any process starts, with a short
 *   reason and one `xd://exec_command` pointer. Runs only when `pty.enabled`
 *   is on and the calling session's active tools include `exec_command`.
 *   A refused call reaches no other lane (no count, no reminder, no judge
 *   request, no nested-device marker). Entry routing, not risk judgment.
 * - `form`/`intent` (tool routing) and `risk` — main session only,
 *   REMINDERS ONLY, judged at `tool_result` once the call has run: no call is
 *   ever blocked by them. They catch work the built-in tools own
 *   (`APPEND_SYSTEM.md`) done through the shell or the eval kernel, and calls
 *   whose outcome the agent cannot read off their result.
 *
 * FACTS. A foreground `bash` call that ran to its end carries pi-shell's
 * execution trace (`details.trace`, read by `trace.ts`): the lanes judge the
 * commands that actually ran, with their expanded argv; commands that did not
 * run are not there. A call that went to the background before it ended, an
 * eval cell and any call without a usable trace are judged from their text,
 * as before the trace existed. A run cut short (timeout, cancel) is not
 * judged for risk.
 *
 * DELIVERY. Reminders are returned as the result's `additionalContext`, so
 * they reach the model with that call's result and never steer the running
 * turn (a steer pushes the turn's other running bash calls to the
 * background). An intent verdict that lands after its call's result rides on
 * the next watched result, or starts a turn when the session is idle.
 *
 * CONFIGURED in the `tool-policy-nag.*` plugin settings of `omp-config`
 * (`/settings → Plugins → omp-config` or `omp plugin config`; the project's
 * `.omp/plugin-overrides.json` wins over the machine values; re-read at every
 * watched call, so edits apply to the next shell or eval call). The manifest
 * carries the defaults; an unreadable or invalid value warns and runs no
 * lane. `detector` picks one way to catch tool-routing violations:
 *
 * - `heuristic` — the deterministic string lane (`shell-parser.ts` splits the
 *   line, `shell-command.ts` resolves each command through wrappers to the
 *   program it runs, `shell-programs.ts` judges each program, `heuristic.ts`
 *   applies pipeline policy; on a traced run the commands come from the trace
 *   instead of the split): counts every operation a built-in tool covers
 *   whose output reaches the agent, and once the hits exceed `form.afterHits`
 *   reminds with `form.prompt`, at most `form.maxNags` times per context,
 *   then goes quiet until a boundary that replaces the context (compaction,
 *   `/clear`, a branch summary). Branch and tree navigation rebuild the
 *   branch's own state; it does not reset it. No JUDGE request is made and
 *   `INTENT-*.md` is not read.
 * - `jev` — the intent lane (`intent.ts`): asks a judgment model one `choice`
 *   question per watched call — what is this call trying to accomplish and
 *   which built-in tool does that intent belong to — started at `tool_call`
 *   so it runs beside the call, and reminds naming the intent and the
 *   required tool. The question, its options and their cases come from the
 *   spec beside this extension (`INTENT-*.md`), read per call; `intent.threshold`
 *   is the probability at which a judged violation counts. No counting,
 *   no cap: one reminder per offending call. A failed judge request warns
 *   once per reason and reminds nothing. The `form.*` settings make the
 *   string lane count beside it and remind only while the intent lane cannot
 *   run (no valid enabled spec, or no judge model at all); a failed judge
 *   request does not fall back.
 *
 * `tool-policy-nag.risk.*` — the risk lane (`risk.ts`), only when
 * `risk.enabled`: no judge, no counting. On a traced run
 * it reminds when a step failed silently (a non-zero status nothing tested,
 * no output of its own); a text-judged call keeps the size, breadth and write
 * thresholds (`risk.minCommands`/`risk.minChars`/`risk.minPrograms`).
 * Independent of `detector`: a call can be a tool violation, a risk, both,
 * or neither.
 *
 * BASH INTERCEPTOR. While `detector` is `heuristic`, every watched main-session
 * call that the pty lane let through first puts a runtime-only override
 * `bashInterceptor.enabled = false` on the main session's live settings,
 * whatever config.yml says; subagents read those settings through, so they
 * lose the interceptor too. The override is the extension's own: it is
 * cleared when the detector changes and at `session_shutdown`, and no other
 * layer is touched. Under any other detector the interceptor follows config,
 * and while it is on, `bash` calls (direct or through `xd://bash`) are skipped
 * by the form, intent and risk lanes because the interceptor already refuses
 * routing violations before they run; `bash_bg` and eval stay watched.
 * The pty lane runs before this skip.
 *
 * Registers session lifecycle, tool_call and tool_result hooks; appends
 * counter entries to the session branch, overrides one OMP setting at
 * runtime, returns reminders as tool-result context and pty refusals as
 * tool-call blocks. Hook failures are logged and do not escape into omp; a
 * pty lane failure lets the call run.
 */
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
import { sessionSettings } from "../_shared/settings.ts";
import { type WatchedCall, watchedCallOf } from "../_shared/tool-calls.ts";
import { type FormLane, type IntentLane, type Lanes, type LaneWarning, loadLanes } from "./detector-config.ts";
import { detectEvalViolations, detectShellViolations, detectTraceViolations } from "./heuristic.ts";
import { type IntentSpec, intentReminder, intentViolation, JUDGE_TIMEOUT_MS, judgeIntent, loadIntentSpec } from "./intent.ts";
import { ptyEvalHit, ptyRefusal, ptyShellHit } from "./pty.ts";
import { inspectMaskedFailure, inspectRisk, maskedFailureReminder, riskReminder } from "./risk.ts";
import type { ShellViolation } from "./shell-programs.ts";
import { type ShellOutcome, shellOutcome } from "./trace.ts";

const STATE_ENTRY_TYPE = "mouriya.omp.tool-policy-nag.state";
/** The intent spec is read from beside this extension, not from the agent root. */
const SPEC_DIR = import.meta.dir;

type NagState =
	| { readonly kind: "watching"; readonly hits: number; readonly nagsSent: number }
	| { readonly kind: "exhausted"; readonly hits: number; readonly nagsSent: number };

const WATCHING: NagState = { kind: "watching", hits: 0, nagsSent: 0 };

const stateSchema = z.object({
	kind: z.enum(["watching", "exhausted"]),
	hits: z
		.number()
		.refine(Number.isFinite)
		.transform((value) => Math.max(0, Math.trunc(value))),
	nagsSent: z
		.number()
		.refine(Number.isFinite)
		.transform((value) => Math.max(0, Math.trunc(value))),
});

function parseState(data: unknown): NagState | null {
	const parsed = stateSchema.safeParse(data);
	if (!parsed.success) return null;
	const { kind, hits, nagsSent } = parsed.data;
	return kind === "watching" ? { kind, hits, nagsSent } : { kind, hits, nagsSent };
}

/**
 * Rebuilds the counter from the session branch so a resumed process keeps its
 * word: a boundary that replaces the model's context (compaction, `/clear`,
 * a branch summary) discards every hit recorded before it.
 */
function rebuildState(ctx: ExtensionContext): NagState {
	let state: NagState = WATCHING;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
			state = WATCHING;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parseState(entry.data);
		if (parsed !== null) state = parsed;
	}
	return state;
}

/**
 * How long a result waits for its call's intent verdict; below the host's
 * 30 s handler budget. A later verdict is delivered with the next result.
 */
const INTENT_WAIT_MS = 20_000;

/** The tool-routing violations of a watched call, from its trace when the run left a usable one. */
function violationsOf(call: WatchedCall, outcome: ShellOutcome | null): ReturnType<typeof detectEvalViolations> | ShellViolation[] {
	if (call.kind === "eval") return detectEvalViolations(call.language, call.code);
	if (outcome?.kind === "traced") return detectTraceViolations(outcome.trace);
	if (outcome?.kind === "timedOut" && outcome.trace !== null) return detectTraceViolations(outcome.trace);
	return detectShellViolations(call.command);
}

/** Counts a call's violations; past the threshold returns `form.prompt` when `deliver`, else null. */
function heuristicCheck(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	violations: ReturnType<typeof violationsOf>,
	form: FormLane,
	state: NagState,
	commit: (next: NagState) => void,
	deliver: boolean,
): string | null {
	// The configured cap decides, so raising `maxNags` re-arms an exhausted context.
	if (state.nagsSent >= form.maxNags) return null;
	if (violations.length === 0) return null;

	// Every offending command counts, so four `cat`s batched into one bash
	// call are four hits rather than one.
	const hits = state.hits + violations.length;
	const programs = violations.map((violation) => `${violation.program} ${violation.target}`);
	const violationDetails = violations.map(({ categories, program, target }) => ({ categories, program, target }));
	if (hits <= form.afterHits) {
		pi.logger.info("Tool-policy violation observed", {
			hits,
			threshold: form.afterHits,
			programs,
			violations: violationDetails,
			nagNumber: state.nagsSent,
			nagsSent: state.nagsSent,
			maxNags: form.maxNags,
			detectorArmed: true,
		});
		commit({ kind: "watching", hits, nagsSent: state.nagsSent });
		return null;
	}
	const nagsSent = state.nagsSent + 1;
	const detectorArmed = nagsSent < form.maxNags;
	pi.logger.info("Tool-policy violation past threshold — nagging", {
		hits,
		programs,
		violations: violationDetails,
		nagNumber: nagsSent,
		nagsSent,
		maxNags: form.maxNags,
		detectorArmed,
		delivering: deliver,
	});
	commit(detectorArmed ? { kind: "watching", hits, nagsSent } : { kind: "exhausted", hits, nagsSent });
	if (!deliver) return null;
	ctx.ui.notify(
		tr(
			`Shell policy nag ${nagsSent}/${form.maxNags} sent for hit #${hits} (${programs.join(", ")}) — detector ${
				detectorArmed ? "still armed" : "exhausted until compaction"
			}`,
			`Shell 策略提醒已发送 ${nagsSent}/${form.maxNags} 次，命中 #${hits}（${programs.join("、")}）—检测器${
				detectorArmed ? "仍在工作" : "已耗尽，直到压缩后重新启用"
			}`,
		),
		"warning",
	);
	return form.prompt;
}

/** The risk reminder for a watched shell call, judged from its trace or, without one, from its text. */
function riskCheck(
	ctx: ExtensionContext,
	lanes: Lanes,
	call: Extract<WatchedCall, { kind: "shell" }>,
	outcome: ShellOutcome,
	log: (finding: object) => void,
): string | null {
	if (lanes.risk === null) return null;
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
			const finding = inspectRisk(call.command, lanes.risk);
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

async function runForMainSession(pi: ExtensionAPI, ctx: ExtensionContext, handler: () => void | Promise<void>): Promise<void> {
	if (ctx.agent.kind !== "main") return;
	try {
		await handler();
	} catch (error) {
		pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
	}
}

/**
 * The pty lane's refusal for a watched call, or null to let it through: the
 * lane is configured, the calling session has `exec_command` to go to, and a
 * `bash` line or an eval cell hits a rule. Never throws; a failure lets the
 * call run.
 */
async function ptyRefusalFor(pi: ExtensionAPI, lanes: Lanes, call: WatchedCall): Promise<string | null> {
	if (lanes.pty === null) return null;
	try {
		if (!pi.getActiveTools().includes("exec_command")) return null;
		switch (call.kind) {
			case "shell": {
				if (call.tool !== "bash") return null;
				const hit = ptyShellHit(call.command);
				if (hit === null) return null;
				pi.logger.info("Tool-policy pty route refused", { tool: call.tool, ...hit });
				return ptyRefusal(hit, call.tool);
			}
			case "eval": {
				const hit = await ptyEvalHit(call.language, call.code);
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

/** An intent judgment started at `tool_call`, collected at the call's `tool_result`. */
type IntentJob = {
	readonly epoch: number;
	/** Whether the intent lane can run at all; the form fallback reminds only when it cannot. */
	readonly available: Promise<boolean>;
	readonly reminder: Promise<string | null>;
};

/** The factory-owned runtime state the closures used to share by capture, now passed to each hook. */
type Nag = {
	readonly pi: ExtensionAPI;
	state: NagState;
	readonly nestedDeviceCalls: Set<string>;
	/** Bumped by every session move; an intent verdict from an older epoch is shown, never sent. */
	epoch: number;
	/** Config, spec and judge failures already reported, so a broken setup warns once per process. */
	readonly warned: Set<string>;
	/** Intent judgments in flight, by tool call id. */
	readonly intentJobs: Map<string, IntentJob>;
	/** Intent reminders whose call's result had already gone out; they ride on the next watched result. */
	readonly lateReminders: string[];
	/** Settings carrying this extension's interceptor override; only this override is ever cleared. */
	interceptorOff: Settings | null;
};

function commit(nag: Nag, next: NagState): void {
	nag.state = next;
	nag.pi.appendEntry(STATE_ENTRY_TYPE, next);
}

function rearm(nag: Nag, reason: string): void {
	if (nag.state.kind === "watching" && nag.state.hits === 0 && nag.state.nagsSent === 0) return;
	nag.pi.logger.info("Tool-policy nag re-armed", { reason, previous: nag.state });
	commit(nag, WATCHING);
}

function restore(nag: Nag, reason: string, ctx: ExtensionContext): void {
	nag.epoch += 1;
	nag.intentJobs.clear();
	nag.lateReminders.length = 0;
	nag.state = rebuildState(ctx);
	nag.pi.logger.info("Tool-policy nag state restored", { reason, state: nag.state });
}

function warnOnce(nag: Nag, ctx: ExtensionContext, warning: LaneWarning): void {
	if (nag.warned.has(warning.en)) return;
	nag.warned.add(warning.en);
	nag.pi.logger.warn(warning.en);
	if (ctx.hasUI) ctx.ui.notify(tr(warning.en, warning.zh), "warning");
}

/** Resolve all activation inputs once, before deciding which tool lane owns delivery. */
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

/** The intent reminder for a call, or null when the verdict does not fire. */
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

/** Starts the intent judgment beside the call; the result collects it. */
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

/** Waits briefly for a verdict; one that lands later is held for the next result, or sent when idle. */
async function collectIntent(nag: Nag, ctx: ExtensionContext, job: IntentJob): Promise<string | null> {
	const settled = await Promise.race([
		job.reminder.then((reminder) => ({ kind: "ready", reminder }) as const),
		Bun.sleep(INTENT_WAIT_MS).then(() => ({ kind: "late" }) as const),
	]);
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

/** Under the heuristic detector the interceptor is off whatever config says; otherwise config decides. */
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

/** The interceptor already refuses routing violations of `bash` before they run. */
function interceptorOwns(call: WatchedCall, settings: Settings): boolean {
	return call.kind === "shell" && call.tool === "bash" && cfgBashInterceptorEnabled.get(settings) === true;
}

function onSessionMove(nag: Nag, reason: string, ctx: ExtensionContext): Promise<void> {
	return runForMainSession(nag.pi, ctx, () => restore(nag, reason, ctx));
}

function onSessionCompact(nag: Nag, ctx: ExtensionContext): Promise<void> {
	return runForMainSession(nag.pi, ctx, () => rearm(nag, "session_compact"));
}

function onAutoCompactionEnd(nag: Nag, event: AutoCompactionEndEvent, ctx: ExtensionContext): Promise<void> {
	return runForMainSession(nag.pi, ctx, () => {
		if (event.aborted || event.skipped === true || event.result === undefined) return;
		rearm(nag, `auto_compaction_end:${event.action}`);
	});
}

function onSessionShutdown(nag: Nag, ctx: ExtensionContext): Promise<void> {
	return runForMainSession(nag.pi, ctx, () => releaseInterceptor(nag, "session_shutdown"));
}

async function onToolCall(nag: Nag, event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	// The device re-dispatches its payload as a nested tool call with the same id;
	// the outer write already went through every lane.
	if (event.toolName !== "write" && nag.nestedDeviceCalls.delete(event.toolCallId)) return;
	const call = watchedCallOf(event.toolName, event.input);
	if (call === null) return;
	let loaded: { lanes: Lanes; warnings: readonly LaneWarning[] };
	try {
		loaded = await loadLanes(ctx.cwd);
	} catch (error) {
		nag.pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
		return;
	}
	const { lanes, warnings } = loaded;
	// Main and sub sessions: a refused call is stopped before every other lane, so nothing counts or reminds.
	const refusal = await ptyRefusalFor(nag.pi, lanes, call);
	if (refusal !== null) return { block: true, reason: refusal };
	if (event.toolName === "write") nag.nestedDeviceCalls.add(event.toolCallId);
	await runForMainSession(nag.pi, ctx, () => {
		for (const warning of warnings) warnOnce(nag, ctx, warning);
		// The tool runs after this hook, so the override reaches this very call.
		const settings = syncInterceptor(nag, ctx, lanes);
		if (interceptorOwns(call, settings)) return;
		if (lanes.tool?.detector === "jev") nag.intentJobs.set(event.toolCallId, startIntent(nag, ctx, lanes.tool.intent, call));
	});
}

async function onToolResult(nag: Nag, event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
	if (ctx.agent.kind !== "main") return;
	// A device write's payload ran as a nested call with the same id; its own result carries the facts.
	if (event.toolName === "write") return;
	const call = watchedCallOf(event.toolName, event.input);
	if (call === null) return;
	const job = nag.intentJobs.get(event.toolCallId);
	nag.intentJobs.delete(event.toolCallId);
	const reminders = nag.lateReminders.splice(0);
	try {
		const { lanes } = await loadLanes(ctx.cwd);
		const settings = sessionSettings(ctx);
		if (settings !== undefined && interceptorOwns(call, settings)) return context(reminders);
		const outcome = call.kind === "shell" ? shellOutcome(event.details, event.isError) : null;
		if (call.kind === "shell" && outcome !== null) {
			const risk = riskCheck(ctx, lanes, call, outcome, (finding) =>
				nag.pi.logger.info("Tool-policy risk", { tool: call.tool, outcome: outcome.kind, ...finding }),
			);
			if (risk !== null) reminders.push(risk);
		}
		const tool = lanes.tool;
		if (tool === null) return context(reminders);
		switch (tool.detector) {
			case "heuristic": {
				const reminder = heuristicCheck(nag.pi, ctx, violationsOf(call, outcome), tool.form, nag.state, (next) => commit(nag, next), true);
				if (reminder !== null) reminders.push(reminder);
				break;
			}
			case "jev": {
				const available = job === undefined ? false : await job.available;
				const reminder = heuristicCheck(
					nag.pi,
					ctx,
					violationsOf(call, outcome),
					tool.fallback,
					nag.state,
					(next) => commit(nag, next),
					!available,
				);
				if (reminder !== null) reminders.push(reminder);
				if (job === undefined || !available) break;
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
		state: WATCHING,
		nestedDeviceCalls: new Set(),
		epoch: 0,
		warned: new Set(),
		intentJobs: new Map(),
		lateReminders: [],
		interceptorOff: null,
	};

	pi.on("session_start", (_event, ctx) => onSessionMove(nag, "session_start", ctx));
	pi.on("session_switch", (_event, ctx) => onSessionMove(nag, "session_switch", ctx));
	pi.on("session_branch", (_event, ctx) => onSessionMove(nag, "session_branch", ctx));
	pi.on("session_tree", (_event, ctx) => onSessionMove(nag, "session_tree", ctx));
	pi.on("session_compact", (_event, ctx) => onSessionCompact(nag, ctx));
	pi.on("auto_compaction_end", (event, ctx) => onAutoCompactionEnd(nag, event, ctx));
	pi.on("session_shutdown", (_event, ctx) => onSessionShutdown(nag, ctx));
	pi.on("tool_call", (event, ctx) => onToolCall(nag, event, ctx));
	pi.on("tool_result", (event, ctx) => onToolResult(nag, event, ctx));
}

/** Reminders ride on the call's result as context for the next model request. */
function context(reminders: readonly string[]): { additionalContext: string } | undefined {
	return reminders.length === 0 ? undefined : { additionalContext: reminders.join("\n\n") };
}
