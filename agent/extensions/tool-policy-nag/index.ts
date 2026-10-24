/**
 * Watches main-session shell commands and eval code for work the built-in
 * tools own (`APPEND_SYSTEM.md`), and injects an attributed reminder when the
 * shell or the eval kernel was used instead. Reminders only: no call is ever
 * blocked, and a working call is left alone.
 *
 * CONFIGURED in the `tool-policy-nag` section of omomp.* (project copy first,
 * then the agent dir; re-read at every watched call, so edits apply to the next
 * shell or eval call). Nothing is preset in code: without a valid section no
 * lane runs. `detector` picks one way to catch tool-routing violations:
 *
 * - `heuristic` — the deterministic string lane (`shell-parser.ts` splits the
 *   line, `shell-command.ts` resolves each command through wrappers to the
 *   program it runs, `shell-programs.ts` judges each program, `heuristic.ts`
 *   applies pipeline policy): counts every operation a built-in tool covers
 *   whose output reaches the agent, and once the hits exceed `form.afterHits` sends `form.prompt`
 *   as a steer, at most `form.maxNags` times per context, then goes quiet until a boundary that
 *   replaces the context (compaction, `/clear`, a branch summary). Branch and
 *   tree navigation rebuild the branch's own state; it does not reset it. No
 *   JUDGE request is made and `INTENT-*.md` is not read.
 * - `jev` — the intent lane (`intent.ts`): asks a judgment model one `choice`
 *   question per watched call — what is this call trying to accomplish and
 *   which built-in tool does that intent belong to — and injects a reminder
 *   naming the intent and the required tool. The question, its options and
 *   their cases come from the spec beside this extension (`INTENT-*.md`), read
 *   per call. No counting, no cap: one reminder per offending call. A failed
 *   judge request warns once per reason and reminds nothing. An optional
 *   `form` block makes the string lane count beside it and send its prompt
 *   only while the intent lane cannot run (no valid enabled spec, or no judge
 *   model at all); a failed judge request does not fall back.
 *
 * `risk` — the risk lane (`risk.ts`): no judge, no counting. A shell call that
 * is long, runs many different programs and writes something has an outcome
 * nobody can read off the call; it gets one reminder naming the length, the
 * programs and the writing steps. Deterministic and independent of
 * `detector`: a call can be a tool violation, a risk, both, or neither.
 *
 * BASH INTERCEPTOR. While `detector` is `heuristic`, every watched call first
 * puts a runtime-only override `bashInterceptor.enabled = false` on the main
 * session's live settings, whatever config.yml says; subagents read those
 * settings through, so they lose the interceptor too. The override is the
 * extension's own: it is cleared when the detector changes and at
 * `session_shutdown`, and no other layer is touched. Under any other detector
 * the interceptor follows config, and while it is on, `bash` calls (direct or
 * through `xd://bash`) are skipped by every lane because the interceptor
 * already refuses routing violations before they run; `exec_command`,
 * `bash_bg` and eval stay watched.
 *
 * Registers session lifecycle and tool_call hooks; appends counter entries to
 * the session branch, overrides one OMP setting at runtime and injects
 * attributed user reminders. Main sessions only. Hook failures are logged and
 * do not escape into omp.
 */
import type { Judge } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type Settings, z } from "@oh-my-pi/pi-coding-agent";
import { cfgBashInterceptorEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { errorText } from "../_shared/errors.ts";
import { openJudge } from "../_shared/judge.ts";
import { sessionSettings } from "../_shared/settings.ts";
import { type WatchedCall, watchedCallOf } from "./calls.ts";
import { type FormLane, type IntentLane, type Lanes, loadLanes } from "./detector-config.ts";
import { detectEvalViolations, detectShellViolations } from "./heuristic.ts";
import { type IntentSpec, intentReminder, intentViolation, JUDGE_TIMEOUT_MS, judgeIntent, loadIntentSpec } from "./intent.ts";
import { inspectRisk, riskReminder } from "./risk.ts";

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

function heuristicCheck(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	call: WatchedCall,
	form: FormLane,
	state: NagState,
	commit: (next: NagState) => void,
	deliver: boolean,
): void {
	// The configured cap decides, so raising `maxNags` re-arms an exhausted context.
	if (state.nagsSent >= form.maxNags) return;
	const violations = call.kind === "shell" ? detectShellViolations(call.command) : detectEvalViolations(call.language, call.code);
	if (violations.length === 0) return;

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
		return;
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
	if (!deliver) return;
	pi.sendUserMessage(form.prompt, { deliverAs: "steer", attribution: "agent" });
	ctx.ui.notify(
		`Shell policy nag ${nagsSent}/${form.maxNags} sent for hit #${hits} (${programs.join(", ")}) — detector ${
			detectorArmed ? "still armed" : "exhausted until compaction"
		}`,
		"warning",
	);
}
async function runForMainSession(pi: ExtensionAPI, ctx: ExtensionContext, handler: () => void | Promise<void>): Promise<void> {
	if (ctx.agent.kind !== "main") return;
	try {
		await handler();
	} catch (error) {
		pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
	}
}

export default function toolPolicyNag(pi: ExtensionAPI): void {
	let state: NagState = WATCHING;
	const nestedDeviceCalls = new Set<string>();
	/** Bumped by every session move; an intent verdict from an older epoch is shown, never sent. */
	let epoch = 0;
	/** Config, spec and judge failures already reported, so a broken setup warns once per process. */
	const warned = new Set<string>();

	const commit = (next: NagState): void => {
		state = next;
		pi.appendEntry(STATE_ENTRY_TYPE, next);
	};

	const rearm = (reason: string): void => {
		if (state.kind === "watching" && state.hits === 0 && state.nagsSent === 0) return;
		pi.logger.info("Tool-policy nag re-armed", { reason, previous: state });
		commit(WATCHING);
	};

	const restore = (reason: string, ctx: ExtensionContext): void => {
		epoch += 1;
		state = rebuildState(ctx);
		pi.logger.info("Tool-policy nag state restored", { reason, state });
	};

	const warnOnce = (ctx: ExtensionContext, text: string): void => {
		if (warned.has(text)) return;
		warned.add(text);
		pi.logger.warn(text);
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
	};

	/** Resolve all activation inputs once, before deciding which tool lane owns delivery. */
	const prepareIntent = async (ctx: ExtensionContext): Promise<{ readonly judge: Judge; readonly spec: IntentSpec } | null> => {
		const loaded = await loadIntentSpec(SPEC_DIR);
		switch (loaded.kind) {
			case "missing":
				warnOnce(ctx, `tool-policy-nag: 意向 spec 缺失（${SPEC_DIR}/INTENT-*.md），意向通道不提醒`);
				return null;
			case "invalid":
				warnOnce(ctx, `tool-policy-nag: 意向 spec 无效（${loaded.reason}），意向通道不提醒`);
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
	};

	/** Runs beside the tool call; the verdict lands after it, so the reminder goes out as an aside. */
	const intentCheck = async (ctx: ExtensionContext, judge: Judge, lane: IntentLane, spec: IntentSpec, call: WatchedCall): Promise<void> => {
		const startedAt = epoch;
		const verdict = await judgeIntent(judge, spec, call, AbortSignal.timeout(JUDGE_TIMEOUT_MS));
		switch (verdict.kind) {
			case "failed":
				warnOnce(ctx, `tool-policy-nag: 意向判定失败（${verdict.reason}）`);
				return;
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
		pi.logger.info("Tool-policy intent verdict", {
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
		if (!fired) return;
		const option = spec.options.find((candidate) => candidate.label === verdict.label);
		if (option === undefined) return;
		const summary = `tool-policy-nag 意向：${tool} → ${verdict.label} ${verdict.probability.toFixed(2)}（${option.title}）`;
		if (epoch !== startedAt) {
			if (ctx.hasUI) ctx.ui.notify(`${summary}；判断返回前会话已切换，未发送提醒`, "info");
			return;
		}
		pi.sendUserMessage(
			intentReminder(call, option),
			ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "aside", attribution: "agent" },
		);
		if (ctx.hasUI) ctx.ui.notify(summary, "warning");
	};

	/** Settings carrying this extension's interceptor override; only this override is ever cleared. */
	let interceptorOff: Settings | null = null;

	const releaseInterceptor = (reason: string): void => {
		if (interceptorOff === null) return;
		cfgBashInterceptorEnabled.clearOverride(interceptorOff);
		interceptorOff = null;
		pi.logger.info("Tool-policy bash interceptor override cleared", { reason });
	};

	/** Under the heuristic detector the interceptor is off whatever config says; otherwise config decides. */
	const syncInterceptor = (ctx: ExtensionContext, lanes: Lanes): Settings => {
		const settings = sessionSettings(ctx);
		if (settings === undefined) throw new Error("tool-policy-nag: current OMP session is not registered");
		if (lanes.tool?.detector !== "heuristic") {
			releaseInterceptor("detector is not heuristic");
			return settings;
		}
		if (interceptorOff !== settings) releaseInterceptor("session settings changed");
		if (interceptorOff === settings && cfgBashInterceptorEnabled.get(settings) === false) return settings;
		cfgBashInterceptorEnabled.override(settings, false);
		interceptorOff = settings;
		pi.logger.info("Tool-policy bash interceptor overridden off", { detector: "heuristic" });
		return settings;
	};

	pi.on("session_start", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_start", ctx)));
	pi.on("session_switch", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_switch", ctx)));
	pi.on("session_branch", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_branch", ctx)));
	pi.on("session_tree", (_event, ctx) => runForMainSession(pi, ctx, () => restore("session_tree", ctx)));
	pi.on("session_compact", (_event, ctx) => runForMainSession(pi, ctx, () => rearm("session_compact")));
	pi.on("auto_compaction_end", (event, ctx) =>
		runForMainSession(pi, ctx, () => {
			if (event.aborted || event.skipped === true || event.result === undefined) return;
			rearm(`auto_compaction_end:${event.action}`);
		}),
	);

	pi.on("session_shutdown", (_event, ctx) => runForMainSession(pi, ctx, () => releaseInterceptor("session_shutdown")));

	pi.on("tool_call", (event, ctx) =>
		runForMainSession(pi, ctx, async () => {
			if (event.toolName !== "write" && nestedDeviceCalls.delete(event.toolCallId)) return;
			const call = watchedCallOf(event.toolName, event.input);
			if (call === null) return;
			// The device re-dispatches its payload as a nested tool call with the same id.
			if (event.toolName === "write") nestedDeviceCalls.add(event.toolCallId);
			const { lanes, warnings }: { lanes: Lanes; warnings: readonly string[] } = loadLanes(ctx.cwd);
			for (const warning of warnings) warnOnce(ctx, warning);
			// The tool runs after this hook, so the override reaches this very call.
			const settings = syncInterceptor(ctx, lanes);
			if (call.kind === "shell" && call.tool === "bash" && cfgBashInterceptorEnabled.get(settings) === true) return;
			if (lanes.risk !== null && call.kind === "shell") {
				const finding = inspectRisk(call.command, lanes.risk);
				if (finding !== null) {
					pi.logger.info("Tool-policy risk", { limits: lanes.risk, ...finding });
					pi.sendUserMessage(
						riskReminder(call.tool, call.command, finding),
						ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "aside", attribution: "agent" },
					);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`tool-policy-nag 风险：${call.tool} ${finding.commands} 段 / ${finding.programs.length} 个程序，会写 ${finding.writes.join("、")}`,
							"warning",
						);
					}
				}
			}
			const tool = lanes.tool;
			if (tool === null) return;
			switch (tool.detector) {
				case "heuristic":
					heuristicCheck(pi, ctx, call, tool.form, state, commit, true);
					return;
				case "jev": {
					const startedAt = epoch;
					const intent = await prepareIntent(ctx).catch((error) => {
						warnOnce(ctx, `tool-policy-nag: JUDGE 准备失败（${errorText(error)}）`);
						return null;
					});
					if (epoch !== startedAt) return;
					if (tool.fallback !== null) heuristicCheck(pi, ctx, call, tool.fallback, state, commit, intent === null);
					if (intent === null) return;
					void intentCheck(ctx, intent.judge, tool.intent, intent.spec, call).catch((error) => {
						pi.logger.warn("Tool-policy nag hook failed", { error: errorText(error) });
					});
					return;
				}
				default: {
					const unreachable: never = tool;
					return unreachable;
				}
			}
		}),
	);
}
