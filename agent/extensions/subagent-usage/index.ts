// ============================================================================
// subagent-usage — the agent-side `/usage`: `subagent_usage` estimates how many
// more dispatches each available subagent can make before the provider quota
// of its first bound model runs out. Off until a human enables it.
//
// Consent: the machine-wide `subagent-usage.enabled` plugin setting
// (`omp-config`; `/settings → Plugins → omp-config` or `omp plugin config`;
// a project override cannot grant it), written only by the human command
// `/subagent-usage on|off|status|recalibrate|reset`. Enabling is consent to
// read this machine's session transcripts and usage history; without it the
// extension reads neither and the tool stays inactive. Consent is re-checked
// before every calibration, before committing its result and in every tool
// call. No model is ever called: calibration is deterministic code.
//
// Calibration (calibrate.ts, worker.ts): a Bun Worker reads the transcripts
// under the sessions root, continuing each file from the byte position its
// cache entry records, and keeps a per-file aggregate cache
// (<agentDir>/cache/subagent-usage/); the main thread derives, from this
// machine's data only, per-dispatch averages (on `on` and `recalibrate`) and
// per-account USD-per-quota-limit constants over the trailing 21 days
// (refreshed when older than a day, inside the tool call), and writes
// <agentDir>/subagent-usage/calibration.json atomically. `off` stops a running
// scan and keeps the data; `reset` deletes it.
//
// Per call the tool discovers agents like the task tool, keeps only each
// agent's FIRST bound model, skips untracked channels (no omp usage provider,
// or a models.yml transport/model; channels.ts), rescans through the cache and
// averages every eligible dispatch of the last 21 days in the project's
// sessions and worktrees (samples.ts), prices each account's live quota with
// its constant (quota.ts) and prints pools grouped by provider (report.ts).
//
// Registers tool `subagent_usage` (defaultInactive; activated on
// session_start/switch while enabled) and command `/subagent-usage` in main
// and sub sessions. Failures are tool errors or UI warnings, never thrown into omp.
// ============================================================================
import { dirname } from "node:path";
import { type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { worktreeSessionDirs } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { applyActiveTools } from "../_shared/active-tools.ts";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineSettings, readSettings, writeSetting } from "../_shared/plugin-settings.ts";
import { availableAgents, bindAgent, rootSession } from "./agents.ts";
import { type CalibrationOutcome, calibrate, QUOTA_MAX_AGE_MS, QUOTA_WINDOW_MS, scanTranscripts, stopCalibration } from "./calibrate.ts";
import { channelsOf } from "./channels.ts";
import type { ScanResult } from "./records.ts";
import { formatReport } from "./report.ts";
import { observedCosts, type Target } from "./samples.ts";
import { type Calibration, calibrationPath, deleteStoredData, readCalibration } from "./store.ts";

const TOOL = "subagent_usage";
const COMMAND = "subagent-usage";
const DESCRIPTION = [
	"How many more times each available subagent can be dispatched before the provider quota of its first bound model runs out (the agent-side /usage).",
	"Output groups agents into POOLs that share one quota: counts inside a pool are alternatives, never add them. PENDING, NOT TRACKED and NO ESTIMATE mean no number, not unlimited.",
].join("\n");

const params = z.object({});
const consentSection = defineSettings(import.meta.dir, z.object({ enabled: z.boolean() }).strict());

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

/** Machine scope only: a project override cannot grant consent. Any problem reads as off. */
async function consented(): Promise<boolean> {
	const loaded = await readSettings(consentSection, { kind: "machine" });
	return loaded.kind === "ok" && loaded.value.enabled;
}

async function setToolActive(pi: ExtensionAPI, active: boolean): Promise<void> {
	const tools = new Set(pi.getActiveTools());
	if (tools.has(TOOL) === active) return;
	if (active) tools.add(TOOL);
	else tools.delete(TOOL);
	await applyActiveTools(pi, tools);
}

/** Calibration fresh enough to use, computing it first when missing, unreadable or older than a day. */
async function freshCalibration(session: AgentSession): Promise<CalibrationOutcome> {
	const stored = readCalibration();
	switch (stored.kind) {
		case "ready":
			if (Date.now() - stored.calibration.quota.generatedAt < QUOTA_MAX_AGE_MS) {
				return { kind: "ready", calibration: stored.calibration, files: 0, parsed: 0 };
			}
			return calibrate(session, "quota", consented);
		case "none":
		case "invalid":
			return calibrate(session, "full", consented);
		default: {
			const never: never = stored;
			return never;
		}
	}
}

function text(value: string, isError?: true): ToolResult {
	return isError ? { content: [{ type: "text", text: value }], isError } : { content: [{ type: "text", text: value }] };
}

async function runTool(ctx: ExtensionContext): Promise<ToolResult> {
	if (!(await consented())) {
		return text("subagent_usage is disabled on this machine. Only a human can enable it with /subagent-usage on; do not retry.", true);
	}
	const session = callerSession(ctx);
	if (!session) return text("subagent_usage: could not resolve the calling session in the agent registry.", true);
	const outcome = await freshCalibration(session);
	let calibration: Calibration;
	let scanned: ScanResult | undefined;
	switch (outcome.kind) {
		case "ready":
			calibration = outcome.calibration;
			scanned = outcome.scan;
			break;
		case "declined":
			return text("subagent_usage was disabled while calibrating. Only a human can enable it with /subagent-usage on; do not retry.", true);
		case "failed":
			return text(`subagent_usage: calibration failed (${outcome.reason}). Report this to the user; do not retry.`, true);
		default: {
			const never: never = outcome;
			return never;
		}
	}
	await session.modelRegistry.awaitBackgroundRefresh();
	const channels = channelsOf(session);
	const bindings = (await availableAgents(session, ctx.sessionManager.getCwd())).map((agent) => {
		const binding = bindAgent(session, agent);
		return { binding, channel: binding.kind === "resolved" ? channels.model(binding.model) : undefined };
	});
	const targets: Target[] = bindings.flatMap(({ binding, channel }) =>
		binding.kind === "resolved" && channel?.kind === "tracked"
			? [{ agent: binding.agent, provider: binding.model.provider, modelId: binding.model.id, thinking: binding.thinking }]
			: [],
	);
	const root = rootSession(session);
	// A root on another thread (this subagent runs in a subagent worker) is a handle exposing its
	// session file and cwd but not getSessionDir; a persisted main session's directory holds its file.
	const rootFile = root.sessionManager.getSessionFile();
	const sessionDir = rootFile ? dirname(rootFile) : isLocalAgentSession(root) ? root.sessionManager.getSessionDir() : undefined;
	if (sessionDir === undefined) {
		return text(
			"subagent_usage: the root session runs in another OMP thread and has no persisted transcript. Report this to the user; do not retry.",
			true,
		);
	}
	const dirs = [sessionDir, ...(await worktreeSessionDirs(root.sessionManager.getCwd(), sessionDir))];
	if (!(await consented())) {
		return text("subagent_usage was disabled. Only a human can enable it with /subagent-usage on; do not retry.", true);
	}
	// A calibration that just ran scanned the transcripts; reuse that scan instead of reading them again.
	const [scan, reports] = await Promise.all([scanned ?? scanTranscripts(), session.fetchUsageReports()]);
	if (scan.kind === "failed")
		return text(`subagent_usage: transcript scan failed (${scan.reason}). Report this to the user; do not retry.`, true);
	const now = Date.now();
	const history = session.modelRegistry.authStorage.usage.history({ sinceMs: now - QUOTA_WINDOW_MS });
	const report = formatReport({
		now,
		calibration,
		bindings,
		costs: observedCosts(scan.dispatches, dirs, targets, now),
		reports: reports ?? [],
		history,
	});
	return text(report);
}

function outcomeMessage(outcome: CalibrationOutcome): { readonly message: string; readonly level: "info" | "warning" } {
	switch (outcome.kind) {
		case "ready": {
			const constants = Object.keys(outcome.calibration.quota.constants).length;
			const missing = Object.keys(outcome.calibration.quota.missing).length;
			return {
				message: tr(
					`subagent-usage: calibrated from ${outcome.files} transcripts (${outcome.parsed} read this time); ${constants} quota limits priced, ${missing} still pending.`,
					`subagent-usage：已用 ${outcome.files} 个会话文件完成校准（本次读取 ${outcome.parsed} 个）；${constants} 个额度窗口可换算，${missing} 个暂缺数据。`,
				),
				level: "info",
			};
		}
		case "declined":
			return {
				message: tr(
					"subagent-usage: disabled during calibration; nothing was written.",
					"subagent-usage：校准期间已关闭，未写入任何数据。",
				),
				level: "warning",
			};
		case "failed":
			return {
				message: tr(`subagent-usage: calibration failed: ${outcome.reason}`, `subagent-usage：校准失败：${outcome.reason}`),
				level: "warning",
			};
		default: {
			const never: never = outcome;
			return never;
		}
	}
}

/** Runs a calibration in the background and reports its end in the UI; the command returns at once. */
function calibrateInBackground(pi: ExtensionAPI, ctx: ExtensionCommandContext, session: AgentSession): void {
	ctx.ui.notify(
		tr(
			"subagent-usage: calibrating from this machine's sessions and usage history in the background…",
			"subagent-usage：正在后台用本机会话与用量历史校准…",
		),
		"info",
	);
	void calibrate(session, "full", consented).then(
		(outcome) => {
			const { message, level } = outcomeMessage(outcome);
			ctx.ui.notify(message, level);
		},
		(error: unknown) => pi.logger.warn("subagent-usage: calibration failed", { error: errorText(error) }),
	);
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const stored = readCalibration();
	const state = (await consented()) ? tr("enabled", "已开启") : tr("disabled", "已关闭");
	let detail: string;
	switch (stored.kind) {
		case "none":
			detail = tr("no calibration on this machine", "本机尚无校准数据");
			break;
		case "invalid":
			detail = tr(`calibration unreadable (${stored.reason})`, `校准数据无法读取（${stored.reason}）`);
			break;
		case "ready": {
			const { dispatch, quota } = stored.calibration;
			detail = tr(
				`per-dispatch averages ${new Date(dispatch.generatedAt).toISOString()}, quota ${new Date(quota.generatedAt).toISOString()}: ${Object.keys(quota.constants).length} limits priced, ${Object.keys(quota.missing).length} pending`,
				`单次派发均值 ${new Date(dispatch.generatedAt).toISOString()}，额度换算 ${new Date(quota.generatedAt).toISOString()}：${Object.keys(quota.constants).length} 个窗口可换算，${Object.keys(quota.missing).length} 个暂缺`,
			);
			break;
		}
		default: {
			const never: never = stored;
			detail = never;
		}
	}
	ctx.ui.notify(`subagent-usage: ${state}; ${detail} (${calibrationPath()})`, "info");
}

async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const action = args.trim().toLowerCase() || "status";
	switch (action) {
		case "on": {
			await writeSetting("subagent-usage.enabled", true);
			await setToolActive(pi, true);
			const session = callerSession(ctx);
			if (session) calibrateInBackground(pi, ctx, session);
			return;
		}
		case "off":
			await writeSetting("subagent-usage.enabled", false);
			stopCalibration();
			await setToolActive(pi, false);
			ctx.ui.notify(
				tr(
					"subagent-usage: disabled; nothing more is read. Existing calibration is kept and unused; /subagent-usage reset deletes it.",
					"subagent-usage：已关闭，不再读取任何数据。已有校准数据保留但不使用；/subagent-usage reset 可删除。",
				),
				"info",
			);
			return;
		case "recalibrate": {
			if (!(await consented())) {
				ctx.ui.notify(
					tr("subagent-usage: disabled; run /subagent-usage on first.", "subagent-usage：未开启，请先执行 /subagent-usage on。"),
					"warning",
				);
				return;
			}
			const session = callerSession(ctx);
			if (session) calibrateInBackground(pi, ctx, session);
			return;
		}
		case "reset":
			stopCalibration();
			deleteStoredData();
			ctx.ui.notify(tr("subagent-usage: calibration and scan cache deleted.", "subagent-usage：已删除校准数据与扫描缓存。"), "info");
			return;
		case "status":
			await showStatus(ctx);
			return;
		default:
			ctx.ui.notify(
				tr("Usage: /subagent-usage [status|on|off|recalibrate|reset]", "用法：/subagent-usage [status|on|off|recalibrate|reset]"),
				"warning",
			);
	}
}

export default function subagentUsage(pi: ExtensionAPI): void {
	const activate = async (): Promise<void> => {
		try {
			await setToolActive(pi, await consented());
		} catch (error) {
			pi.logger.warn("subagent-usage: tool activation failed", { error: errorText(error) });
		}
	};
	pi.on("session_start", activate);
	pi.on("session_switch", activate);
	pi.registerTool({
		name: TOOL,
		label: tr("Subagent Usage", "子代理用量"),
		description: DESCRIPTION,
		approval: "read",
		loadMode: "essential",
		defaultInactive: true,
		parameters: params,
		async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
			try {
				return await runTool(ctx);
			} catch (error) {
				pi.logger.warn("subagent-usage: tool failed", { error: errorText(error) });
				return text(`subagent_usage failed: ${errorText(error)}`, true);
			}
		},
	});
	pi.registerCommand(COMMAND, {
		description: tr(
			"Agent-side /usage for subagents: /subagent-usage [status|on|off|recalibrate|reset]. `on` consents to reading this machine's sessions and usage history.",
			"子代理的 AI 侧 /usage：/subagent-usage [status|on|off|recalibrate|reset]。`on` 即同意读取本机会话与用量历史。",
		),
		handler: async (args, ctx) => {
			try {
				await handleCommand(pi, args, ctx);
			} catch (error) {
				pi.logger.warn("subagent-usage: command failed", { error: errorText(error) });
				ctx.ui.notify(tr(`subagent-usage: ${errorText(error)}`, `subagent-usage：${errorText(error)}`), "warning");
			}
		},
	});
}
