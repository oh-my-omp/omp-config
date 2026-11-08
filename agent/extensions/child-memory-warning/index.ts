/**
 * Warns the interactive omp process's main UI and agent when an owned descendant OS
 * child process's macOS phys_footprint exceeds the configured threshold. Only OS
 * child processes are in scope: subagents running in-process (on the main thread,
 * or in a worker thread when more than 8 subagents run concurrently and
 * `task.workerThreads` is greater than 0) share the omp process's memory and are
 * not tracked here. Main session_start starts one process-shared monitor;
 * session_switch refreshes delivery, and its owning main's session_shutdown clears
 * the managed timer before closing libproc; a scan suspended in the settings read
 * returns on resume without touching libproc or delivering. Child factories never
 * own it. Native 2 s stable scans retain PID+birth ownership after reparenting;
 * observed descendant-led process groups can discover surviving members.
 * A process born and orphaned between observations without a known surviving group
 * anchor cannot be attributed retroactively from the process table.
 * Reads the `child-memory-warning.thresholdGiB` plugin setting (omp-config;
 * `/settings → Plugins → omp-config` or `omp plugin config`; the project's
 * `.omp/plugin-overrides.json` wins over the machine value) every scan; an
 * unreadable or invalid value pauses alerts while tracking continues, and each
 * new config problem warns once.
 * No model calls, sampling subprocesses, signals, or automatic kills.
 * Unsupported platforms log once and never import the Darwin binding. Native/hook
 * failures warn without escaping into omp; delivery is attempted once per identity.
 */
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";
import { type ProcessRecord, type ProcessSource, ProcessTracker } from "./tracker.ts";

const POLL_MS = 2_000;

const configSchema = z
	.object({
		thresholdGiB: z.number().refine((value) => Number.isFinite(value) && value > 0, "a positive number"),
	})
	.strict();
const settingsSection = defineSettings(import.meta.dir, configSchema);

interface Threshold {
	readonly gib: number;
	readonly bytes: bigint;
}

type ThresholdLoad = { readonly kind: "found"; readonly threshold: Threshold } | { readonly kind: "invalid"; readonly problem: string };

interface Monitor {
	readonly pi: ExtensionAPI;
	ctx: ExtensionContext;
	readonly source: ProcessSource;
	readonly tracker: ProcessTracker;
	readonly timer: Timer;
	problem: string | null;
	configProblem: string | null;
	/** A sample is suspended in its settings read or FFI loop; ticks skip rather than pile up. */
	inFlight: boolean;
}

type Lifetime =
	| { kind: "not-started" }
	| { kind: "starting"; pi: ExtensionAPI; ctx: ExtensionContext }
	| { kind: "active"; monitor: Monitor }
	| { kind: "stopped" };

// The loader reuses this module but invokes its factory separately for each child.
let lifetime: Lifetime = { kind: "not-started" };

function warn(pi: ExtensionAPI, message: string, error: unknown): void {
	try {
		pi.logger.warn(`child-memory-warning: ${message}`, { error: errorText(error) });
	} catch {
		// A failing logger must not escape an observational hook or suppress the other delivery channel.
	}
}

async function loadThreshold(cwd: string): Promise<ThresholdLoad> {
	const loaded = await readSettings(settingsSection, { kind: "project", cwd });
	switch (loaded.kind) {
		case "ok": {
			const gib = loaded.value.thresholdGiB;
			return { kind: "found", threshold: { gib, bytes: BigInt(Math.round(gib * 1024 ** 3)) } };
		}
		case "invalid":
			return {
				kind: "invalid",
				problem: tr(
					`Invalid ${settingsSection.id} settings (${loaded.reason}); alerts paused`,
					`${settingsSection.id} 设置无效（${loaded.reason}），告警暂停`,
				),
			};
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}

/** Config problems are user-actionable: report each new one to the log and the main UI, once. */
function reportConfigProblem(monitor: Monitor, problem: string | null): void {
	if (problem === monitor.configProblem) return;
	monitor.configProblem = problem;
	if (problem === null) return;
	const text = tr(`child-memory-warning: ${problem}`, `child-memory-warning：${problem}`);
	try {
		monitor.pi.logger.warn(text);
	} catch {
		// A failing logger must not suppress the UI channel.
	}
	try {
		monitor.ctx.ui.notify(text, "warning");
	} catch (error) {
		warn(monitor.pi, "UI config warning failed", error);
	}
}

function deliver(monitor: Monitor, current: ProcessRecord, bytes: bigint, command: string, threshold: Threshold): void {
	const { pi, ctx } = monitor;
	const uiText = tr(
		`Child process memory limit exceeded: PID ${current.pid}, PPID ${current.parentPid}, orphan: ${
			current.parentPid === 1 ? "yes" : "no"
		}; phys_footprint ${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB (${bytes} bytes), threshold > ${threshold.gib} GiB.\nCommand: ${command}\nWarning only; process was not terminated.`,
		`子进程内存超限：PID ${current.pid}，PPID ${current.parentPid}，孤儿：${current.parentPid === 1 ? "是" : "否"}；` +
			`phys_footprint ${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB（${bytes} bytes），阈值 > ${threshold.gib} GiB。\n命令：${command}\n仅告警，未结束该进程。`,
	);
	const agentText =
		`子进程内存超限：PID ${current.pid}，PPID ${current.parentPid}，孤儿：${current.parentPid === 1 ? "是" : "否"}；` +
		`phys_footprint ${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB（${bytes} bytes），阈值 > ${threshold.gib} GiB。\n命令：${command}\n仅告警，未结束该进程。`;
	try {
		ctx.ui.notify(uiText, "warning");
	} catch (error) {
		warn(pi, "UI warning failed", error);
	}
	try {
		pi.sendUserMessage(agentText, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "aside", attribution: "agent" });
	} catch (error) {
		warn(pi, "main-agent warning failed", error);
	}
}

async function sample(monitor: Monitor): Promise<void> {
	try {
		const result = monitor.source.snapshot();
		if (result.kind === "unavailable") {
			if (monitor.problem !== result.reason) monitor.pi.logger.warn(`child-memory-warning: ${result.reason}`);
			monitor.problem = result.reason;
			return;
		}
		monitor.problem = null;
		// Ownership tracking must see every scan, even while alerts are paused by config.
		const owned = monitor.tracker.observe(result.snapshot);
		// owned aliases the tracker's reused result buffer; consume it synchronously here.
		const config = await loadThreshold(monitor.ctx.cwd);
		// The session may have shut down while the settings read was suspended:
		// a stopped lifetime means libproc is already closed and delivery is over.
		switch (lifetime.kind) {
			case "active": {
				if (lifetime.monitor !== monitor) return;
				break;
			}
			case "not-started":
			case "starting":
			case "stopped": {
				return;
			}
			default: {
				const unreachable: never = lifetime;
				return unreachable;
			}
		}
		reportConfigProblem(monitor, config.kind === "invalid" ? config.problem : null);
		if (config.kind === "invalid") return;
		for (const tracked of owned) {
			if (tracked.alerted) continue;
			const { pid, startedAt } = tracked.identity;
			const bytes = monitor.source.footprint(pid);
			if (bytes === null || bytes <= config.threshold.bytes) continue;
			const command = monitor.source.command(pid);
			// A PID can exit/recycle while memory and argv are read. Also use the latest PPID.
			const current = monitor.source.process(pid);
			if (current === null || current.startedAt !== startedAt) continue;
			tracked.alerted = true;
			deliver(monitor, current, bytes, command, config.threshold);
		}
	} catch (error) {
		const problem = errorText(error);
		if (monitor.problem !== problem) warn(monitor.pi, "sampling failed", error);
		monitor.problem = problem;
	} finally {
		// Single-flight release: every sample path (tick or the first one from start())
		// clears the flag it set, so one thrown sample never stops monitoring.
		monitor.inFlight = false;
	}
}

async function start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main" || lifetime.kind !== "not-started") return;
	if (process.platform !== "darwin") {
		lifetime = { kind: "stopped" };
		pi.logger.info("child-memory-warning: 未启用（仅支持 darwin）");
		return;
	}
	const starting: Lifetime = { kind: "starting", pi, ctx };
	lifetime = starting;
	let source: ProcessSource | null = null;
	try {
		// Keep the Darwin-only FFI module outside unsupported-platform startup.
		const native = await import("./native.ts");
		if (lifetime !== starting) return;
		source = native.openDarwinProcesses();
		const root = source.process(process.pid);
		if (root === null) {
			pi.logger.warn("child-memory-warning: cannot read omp process identity; monitoring not started");
			return;
		}
		const tracker = new ProcessTracker(root);
		// Declared before the timer so the tick closure can claim single-flight on it;
		// assigned exactly once below before the first sample runs.
		let monitor: Monitor | undefined;
		const timer = ctx.setInterval(() => {
			if (lifetime.kind !== "active" || lifetime.monitor.pi !== pi || monitor === undefined) return;
			// Single-flight: a still-running sample owns the FFI buffers; skip this tick instead
			// of holding a second full-table snapshot beside it. sample() clears the flag itself.
			if (lifetime.monitor.inFlight) return;
			monitor.inFlight = true;
			void sample(monitor);
		}, POLL_MS);
		monitor = { pi, ctx: starting.ctx, source, tracker, timer, problem: null, configProblem: null, inFlight: true };
		lifetime = { kind: "active", monitor };
		source = null; // Ownership moves to the active monitor before its first sample.
		await sample(monitor);
	} catch (error) {
		warn(pi, "monitor initialization failed", error);
	} finally {
		if (source !== null) source.close();
		if (lifetime === starting) lifetime = { kind: "stopped" };
	}
}

export default function childMemoryWarning(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await start(pi, ctx);
		} catch (error) {
			warn(pi, "session_start failed", error);
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (lifetime.kind === "active" && lifetime.monitor.pi === pi) lifetime.monitor.ctx = ctx;
		else if (lifetime.kind === "starting" && lifetime.pi === pi) lifetime.ctx = ctx;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return;
			if (lifetime.kind === "starting" && lifetime.pi === pi) lifetime = { kind: "stopped" };
			else if (lifetime.kind === "active" && lifetime.monitor.pi === pi) {
				const { monitor } = lifetime;
				lifetime = { kind: "stopped" };
				try {
					monitor.ctx.clearTimer(monitor.timer);
				} finally {
					monitor.source.close();
				}
			}
		} catch (error) {
			warn(pi, "shutdown failed", error);
		}
	});
}
