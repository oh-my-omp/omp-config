import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineSettings, readSettings } from "../_shared/plugin-settings.ts";
import { type ProcessRecord, type ProcessSource, ProcessTracker } from "./tracker.ts";

const POLL_MS = 2_000;
const GIB = 1024 ** 3;

const configSchema = z
	.object({
		thresholdGiB: z.number().refine((value) => Number.isFinite(value) && value > 0, "a positive number"),
	})
	.strict();
const settingsSection = defineSettings(import.meta.dir, configSchema);

interface Threshold {
	readonly gib: number;
	readonly bytes: number;
}

type ThresholdLoad = { readonly kind: "found"; readonly threshold: Threshold } | { readonly kind: "invalid"; readonly problem: string };

interface Monitor {
	readonly pi: ExtensionAPI;
	ctx: ExtensionContext;
	readonly source: ProcessSource;
	readonly tracker: ProcessTracker;
	problem: string | null;
	configProblem: string | null;
	inFlight: boolean;
}

type Lifetime =
	| { kind: "not-started" }
	| { kind: "starting"; pi: ExtensionAPI; ctx: ExtensionContext }
	| { kind: "active"; monitor: Monitor; timer: Timer }
	| { kind: "stopped" };

let lifetime: Lifetime = { kind: "not-started" };

function warn(pi: ExtensionAPI, message: string, error: unknown): void {
	pi.logger.warn(`child-memory-warning: ${message}`, { error: errorText(error) });
}

async function loadThreshold(cwd: string): Promise<ThresholdLoad> {
	const loaded = await readSettings(settingsSection, { kind: "project", cwd });
	switch (loaded.kind) {
		case "ok": {
			const gib = loaded.value.thresholdGiB;
			return { kind: "found", threshold: { gib, bytes: Math.round(gib * GIB) } };
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

function reportConfigProblem(monitor: Monitor, problem: string | null): void {
	if (problem === monitor.configProblem) return;
	monitor.configProblem = problem;
	if (problem === null) return;
	const text = tr(`child-memory-warning: ${problem}`, `child-memory-warning：${problem}`);
	monitor.pi.logger.warn(text);
	try {
		monitor.ctx.ui.notify(text, "warning");
	} catch (error) {
		warn(monitor.pi, "UI config warning failed", error);
	}
}

function deliver(monitor: Monitor, current: ProcessRecord, bytes: number, command: string, threshold: Threshold): void {
	const { pi, ctx } = monitor;
	const orphan = current.parentPid === 1;
	const gib = (bytes / GIB).toFixed(2);
	const agentText =
		`子进程内存超限：PID ${current.pid}，PPID ${current.parentPid}，孤儿：${orphan ? "是" : "否"}；` +
		`phys_footprint ${gib} GiB（${bytes} bytes），阈值 > ${threshold.gib} GiB。\n命令：${command}\n仅告警，未结束该进程。`;
	const uiText = tr(
		`Child process memory limit exceeded: PID ${current.pid}, PPID ${current.parentPid}, orphan: ${orphan ? "yes" : "no"}; ` +
			`phys_footprint ${gib} GiB (${bytes} bytes), threshold > ${threshold.gib} GiB.\nCommand: ${command}\nWarning only; process was not terminated.`,
		agentText,
	);
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
		// Observe before reading the config: ownership tracking must not skip a scan while alerts are paused.
		const owned = monitor.tracker.observe(result.snapshot);
		const config = await loadThreshold(monitor.ctx.cwd);
		if (lifetime.kind !== "active" || lifetime.monitor !== monitor) return;
		reportConfigProblem(monitor, config.kind === "invalid" ? config.problem : null);
		if (config.kind === "found") {
			for (const tracked of owned) {
				if (tracked.alerted) continue;
				const { pid, startedAt } = tracked.identity;
				const bytes = monitor.source.footprint(pid);
				if (bytes === null || bytes <= config.threshold.bytes) continue;
				const command = monitor.source.command(pid);
				// Never alert on a PID that exited or was reused while its memory and argv were read.
				const current = monitor.source.process(pid);
				if (current === null || current.startedAt !== startedAt) continue;
				tracked.alerted = true;
				deliver(monitor, current, bytes, command, config.threshold);
			}
		}
		monitor.problem = null;
	} catch (error) {
		const problem = errorText(error);
		if (monitor.problem !== problem) warn(monitor.pi, "sampling failed", error);
		monitor.problem = problem;
	} finally {
		monitor.inFlight = false;
	}
}

async function start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main" || lifetime.kind !== "not-started") return;
	if (process.platform !== "darwin") {
		lifetime = { kind: "stopped" };
		pi.logger.info("child-memory-warning: disabled (darwin only)");
		return;
	}
	const starting: Lifetime = { kind: "starting", pi, ctx };
	lifetime = starting;
	try {
		// Never import the FFI module before the platform check: it binds a Darwin-only library.
		const { DarwinProcesses } = await import("./native.ts");
		if (lifetime !== starting) return;
		const source = new DarwinProcesses();
		const root = source.process(process.pid);
		if (root === null) {
			source.close();
			pi.logger.warn("child-memory-warning: cannot read omp process identity; monitoring not started");
			return;
		}
		const monitor: Monitor = {
			pi,
			ctx: starting.ctx,
			source,
			tracker: new ProcessTracker(root),
			problem: null,
			configProblem: null,
			inFlight: true,
		};
		const timer = ctx.setInterval(() => {
			// A running sample owns the FFI buffers: never start a second one beside it.
			if (lifetime.kind !== "active" || lifetime.monitor !== monitor || monitor.inFlight) return;
			monitor.inFlight = true;
			void sample(monitor);
		}, POLL_MS);
		lifetime = { kind: "active", monitor, timer };
		await sample(monitor);
	} catch (error) {
		warn(pi, "monitor initialization failed", error);
	} finally {
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
		if (ctx.agent.kind !== "main") return;
		try {
			if (lifetime.kind === "starting" && lifetime.pi === pi) lifetime = { kind: "stopped" };
			else if (lifetime.kind === "active" && lifetime.monitor.pi === pi) {
				const { monitor, timer } = lifetime;
				lifetime = { kind: "stopped" };
				try {
					monitor.ctx.clearTimer(timer);
				} finally {
					monitor.source.close();
				}
			}
		} catch (error) {
			warn(pi, "shutdown failed", error);
		}
	});
}
