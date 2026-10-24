// ============================================================================
// omp-config-autoupdate — apply the omp-config repo at OMP start, when enabled,
// or on demand.
//
// SWITCH. Off by default. `/omp-config-autoupdate on|off` writes section
// `omp-config-autoupdate` ({"enabled": true|false}) of the agent dir's omomp.*
// file; `/omp-config-autoupdate` or `… status` shows it. A missing or invalid
// section means off. The section is machine-local: the updater does not manage
// it and /sync-omp-config does not carry it. Read at each start, so a change
// applies from the next OMP start.
//
// per-spawn files (APPEND_SYSTEM_MODEL.md, the system-prompt-replace section,
// TURN-JUDGE-*.md, PROMPT-INJECT-*.md, agents/) and live-reloaded config.yml apply at once;
// APPEND_SYSTEM.md, extensions (this one included) and plugins apply on the
// next start, which the notification says.
//
// VISIBILITY. Every automatic run ends in one UI notification (info, or a
// warning for failures) and the footer status `omp-config: …` keeps the last
// outcome for the rest of the session, so "up to date" is as visible as an
// update. Missing bun or script, a busy lock, offline fetch, or an apply error
// never affect the session.
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { defineOmompSection, loadOmompSection, writeOmompSection } from "../_shared/omomp.ts";

const SCRIPT = "omp-config-update.ts";
const REPORT_TYPE = "omp-config-update";

type Switch = { readonly kind: "on" } | { readonly kind: "off" } | { readonly kind: "invalid"; readonly reason: string };

const switchSection = defineOmompSection(import.meta.dir, z.object({ enabled: z.boolean() }).strict());

/** Where the switch lives, for messages. */
const switchLocation = (): string => `${getAgentDir()} (omomp section ${switchSection.id})`;

function readSwitch(): Switch {
	const loaded = loadOmompSection(switchSection, null);
	switch (loaded.kind) {
		case "found":
			return loaded.value.enabled ? { kind: "on" } : { kind: "off" };
		case "none": {
			// A missing file or section is off; a file that exists but is unusable is reported.
			const [problem] = loaded.skipped;
			return problem === undefined ? { kind: "off" } : { kind: "invalid", reason: `${problem.path}: ${problem.reason}` };
		}
		default: {
			const exhaustive: never = loaded;
			return exhaustive;
		}
	}
}

/** Mirrors ApplyReport in omp-config-update.ts. */
const applyReportSchema = z.object({
	written: z.array(z.string()),
	moved: z.array(z.object({ from: z.string(), to: z.string() })),
	deleted: z.array(z.string()),
	skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
	errors: z.array(z.string()),
	notes: z.array(z.string()),
	pluginsInstalled: z.array(z.string()),
	pluginsUpgraded: z.array(z.string()).default(() => []),
	pluginsMissing: z.array(z.string()),
	restartNeeded: z.boolean(),
});

/** Mirrors PluginRefresh in omp-config-update.ts. */
const pluginRefreshSchema = z.object({ installed: z.array(z.string()), upgraded: z.array(z.string()), errors: z.array(z.string()) });

/** Mirrors AutoResult in omp-config-update.ts; JSON drops an undefined `previous`. */
const autoResultSchema = z.union([
	z.object({ kind: z.literal("busy") }),
	z.object({ kind: z.literal("offline"), error: z.string() }),
	z.object({ kind: z.literal("up-to-date"), commit: z.string(), plugins: pluginRefreshSchema }),
	z.object({ kind: z.literal("applied"), commit: z.string(), previous: z.string().optional(), report: applyReportSchema }),
	z.object({ kind: z.literal("failed"), error: z.string() }),
]);
type AutoResult = z.infer<typeof autoResultSchema>;

/** Everything one updater run can end in, including not getting to run it. */
type RunOutcome =
	| { readonly kind: "no-script"; readonly script: string }
	| { readonly kind: "no-bun" }
	| { readonly kind: "no-result"; readonly code: number | null; readonly stderr: string }
	| { readonly kind: "result"; readonly result: AutoResult };

/** One automatic run per process: child sessions share this module and must not re-run it. */
let started = false;

function parseResult(stdout: string): AutoResult | undefined {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		const parsed = autoResultSchema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	} catch {
		// Malformed child JSON is an expected no-result outcome.
		return undefined;
	}
}

type ChildRun = { code: number | null; stdout: string; stderr: string };

function runChild(bun: string, script: string, agentDir: string): Promise<ChildRun> {
	const { promise, resolve } = Promise.withResolvers<ChildRun>();
	const child = spawn(bun, [script, "auto", "--agent-dir", agentDir, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
	child.on("close", (code) => resolve({ code, stdout, stderr }));
	return promise;
}

async function runUpdater(agentDir: string): Promise<RunOutcome> {
	const script = join(import.meta.dir, SCRIPT);
	if (!existsSync(script)) return { kind: "no-script", script };
	const bun = Bun.which("bun");
	if (!bun) return { kind: "no-bun" };
	const run = await runChild(bun, script, agentDir);
	const result = parseResult(run.stdout);
	return result ? { kind: "result", result } : { kind: "no-result", code: run.code, stderr: run.stderr.trim() };
}

const short = (commit: string): string => commit.slice(0, 7);

function section(title: string, items: readonly string[]): string[] {
	return items.length === 0 ? [] : ["", `## ${title} (${items.length})`, ...items.map((item) => `- \`${item}\``)];
}

/** Markdown report of one manual run: every path and message the updater returned. */
function detailedReport(outcome: RunOutcome, agentDir: string): string {
	const head = ["# omp-config update", "", `- **Agent dir:** \`${agentDir}\``];
	switch (outcome.kind) {
		case "no-script":
			return [
				...head,
				`- **Result:** not run: \`${outcome.script}\` is missing. Run \`/update-omp\` once from the omp-config checkout to install the updater.`,
			].join("\n");
		case "no-bun":
			return [...head, "- **Result:** not run: `bun` is not on PATH."].join("\n");
		case "no-result":
			return [
				...head,
				`- **Result:** the updater exited ${outcome.code} without a result.`,
				"",
				"```",
				outcome.stderr || "(no stderr)",
				"```",
			].join("\n");
		case "result":
			break;
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
	const result = outcome.result;
	switch (result.kind) {
		case "busy":
			return [...head, "- **Result:** skipped: another update holds `~/.omp/omp-config-update.lock`. Retry when it finishes."].join("\n");
		case "offline":
			return [
				...head,
				"- **Result:** not updated: fetching GitHub failed, so nothing was compared or applied.",
				"",
				"```",
				result.error,
				"```",
			].join("\n");
		case "failed":
			return [...head, "- **Result:** failed; nothing was recorded as applied.", "", "```", result.error, "```"].join("\n");
		case "up-to-date": {
			const { plugins } = result;
			const changed = plugins.installed.length + plugins.upgraded.length;
			const outcomeLine =
				plugins.errors.length > 0
					? `config up to date; refreshing plugins hit ${plugins.errors.length} error(s), retried next start`
					: changed > 0
						? "config up to date; plugins updated"
						: "up to date; config and plugins unchanged";
			return [
				...head,
				`- **Result:** ${outcomeLine}`,
				`- **Commit:** \`${short(result.commit)}\` (\`${result.commit}\`), nothing applied`,
				`- **Restart needed:** ${changed > 0 ? "yes — plugins changed" : "no"}`,
				...section("Errors", plugins.errors),
				...section("Plugins installed", plugins.installed),
				...section("Plugins upgraded", plugins.upgraded),
			].join("\n");
		}
		case "applied": {
			const { report } = result;
			const changed =
				report.written.length +
				report.moved.length +
				report.deleted.length +
				report.pluginsInstalled.length +
				report.pluginsUpgraded.length;
			const outcomeLine =
				report.errors.length > 0
					? `applied with ${report.errors.length} error(s); the applied commit is not recorded, so the next run retries`
					: changed === 0
						? "applied; this machine already matched, nothing written"
						: "updated";
			const lines = [
				...head,
				`- **Result:** ${outcomeLine}`,
				`- **Commit:** ${result.previous ? `\`${short(result.previous)}\` → ` : "(no previous record) → "}\`${short(result.commit)}\` (\`${result.commit}\`)`,
				`- **Restart needed:** ${report.restartNeeded ? "yes — extensions, APPEND_SYSTEM.md or plugins changed" : "no"}`,
				...section("Errors", report.errors),
				...section("Written", report.written),
				...section(
					"Moved",
					report.moved.map((entry) => `${entry.from}\` → \`${entry.to}`),
				),
				...section("Deleted", report.deleted),
				...section(
					"Skipped",
					report.skipped.map((entry) => `${entry.path}\` — \`${entry.reason}`),
				),
				...section("Plugins installed", report.pluginsInstalled),
				...section("Plugins upgraded", report.pluginsUpgraded),
				...section("Plugins still missing", report.pluginsMissing),
				...section("Notes", report.notes),
			];
			return lines.join("\n");
		}
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

function registerAutoupdateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("omp-config-autoupdate", {
		description:
			"omp-config auto-update: /omp-config-autoupdate [status|on|off|run] (run = update from GitHub now and show the full report)",
		getArgumentCompletions: (prefix) => {
			const matches = ["status", "on", "off", "run"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				const action = args.trim().toLowerCase() || "status";
				if (action === "run") {
					const agentDir = getAgentDir();
					ctx.ui.notify("omp-config: updating from GitHub…", "info");
					const outcome = await runUpdater(agentDir);
					await ctx.waitForIdle();
					pi.sendMessage(
						{ customType: REPORT_TYPE, content: detailedReport(outcome, agentDir), display: true, attribution: "agent" },
						{ triggerTurn: false },
					);
					return;
				}
				if (action === "on" || action === "off") {
					try {
						writeOmompSection(switchSection.id, { enabled: action === "on" });
					} catch (error) {
						pi.logger.warn("omp-config: cannot write auto-update switch", { error: errorText(error) });
						ctx.ui.notify(`omp-config: cannot write ${switchLocation()}: ${errorText(error)}`, "error");
						return;
					}
					ctx.ui.notify(`omp-config: auto-update ${action}; takes effect from the next OMP start (${switchLocation()})`, "info");
					return;
				}
				if (action !== "status") {
					ctx.ui.notify("Usage: /omp-config-autoupdate [status|on|off|run]", "warning");
					return;
				}
				const state = readSwitch();
				switch (state.kind) {
					case "on":
						ctx.ui.notify(`omp-config: auto-update is on (${switchLocation()}); /omp-config-autoupdate run updates now`, "info");
						return;
					case "off":
						ctx.ui.notify(
							`omp-config: auto-update is off (${switchLocation()}); enable with /omp-config-autoupdate on, or update once now with /omp-config-autoupdate run`,
							"info",
						);
						return;
					case "invalid":
						ctx.ui.notify(`omp-config: ${switchLocation()} is invalid (${state.reason}); auto-update is off`, "warning");
						return;
					default: {
						const exhaustive: never = state;
						return exhaustive;
					}
				}
			} catch (error) {
				pi.logger.warn("omp-config: command failed", { error: errorText(error) });
			}
		},
	});
}

/** What the startup run tells the user: a notification and the footer status that stays after it. */
interface StartupMessage {
	readonly level: "info" | "warning";
	readonly text: string;
	readonly status: string;
}

function startupMessage(outcome: RunOutcome): StartupMessage {
	switch (outcome.kind) {
		case "no-script":
			return {
				level: "warning",
				text: `omp-config: ${outcome.script} missing; run /update-omp once to install the updater`,
				status: "omp-config: updater missing",
			};
		case "no-bun":
			return { level: "warning", text: "omp-config: bun is not on PATH; auto-update skipped", status: "omp-config: no bun" };
		case "no-result":
			return {
				level: "warning",
				text: `omp-config: updater exited ${outcome.code} without a result: ${outcome.stderr.slice(0, 500)}`,
				status: "omp-config: update failed",
			};
		case "result":
			break;
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
	const result = outcome.result;
	switch (result.kind) {
		case "busy":
			return { level: "info", text: "omp-config: another update is running; skipped this start", status: "omp-config: skipped (busy)" };
		case "offline":
			return { level: "info", text: `omp-config: GitHub fetch failed, not updated: ${result.error}`, status: "omp-config: offline" };
		case "failed":
			return { level: "warning", text: `omp-config: auto-update failed: ${result.error}`, status: "omp-config: update failed" };
		case "up-to-date": {
			const { plugins } = result;
			if (plugins.errors.length > 0)
				return {
					level: "warning",
					text: `omp-config: config ${short(result.commit)} up to date; plugin refresh hit ${plugins.errors.length} error(s), will retry next start: ${plugins.errors[0]}; /omp-config-autoupdate run shows the full report`,
					status: "omp-config: plugin refresh failed",
				};
			const changed = [...plugins.installed, ...plugins.upgraded];
			if (changed.length === 0)
				return {
					level: "info",
					text: `omp-config: up to date at ${short(result.commit)}; plugins current`,
					status: `omp-config: ${short(result.commit)} ✓`,
				};
			return {
				level: "info",
				text: `omp-config: config ${short(result.commit)} up to date; ${plugins.installed.length} installed and ${plugins.upgraded.length} upgraded plugin(s) (${changed.map((spec) => spec.split("/").at(-1)).join(", ")}); restart OMP to load them`,
				status: "omp-config: plugins updated, restart",
			};
		}
		case "applied": {
			const { report } = result;
			if (report.errors.length > 0)
				return {
					level: "warning",
					text: `omp-config: applied ${short(result.commit)} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}; /omp-config-autoupdate run shows the full report`,
					status: "omp-config: update failed",
				};
			const changed =
				report.written.length +
				report.moved.length +
				report.deleted.length +
				report.pluginsInstalled.length +
				report.pluginsUpgraded.length;
			if (changed === 0)
				return {
					level: "info",
					text: `omp-config: applied ${short(result.commit)}; this machine already matched`,
					status: `omp-config: ${short(result.commit)} ✓`,
				};
			return {
				level: "info",
				text: `omp-config: updated to ${short(result.commit)} (${report.written.length} written, ${report.moved.length} moved, ${report.deleted.length} deleted, ${report.pluginsInstalled.length} installed and ${report.pluginsUpgraded.length} upgraded plugin(s))${report.restartNeeded ? "; restart OMP to load extensions/APPEND_SYSTEM/plugins" : ""}`,
				status: report.restartNeeded
					? `omp-config: ${short(result.commit)} applied, restart`
					: `omp-config: ${short(result.commit)} applied`,
			};
		}
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

const STATUS_KEY = "omp-config";

export default function ompConfigAutoupdate(pi: ExtensionAPI): void {
	registerAutoupdateCommand(pi);

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (level === "warning") pi.logger.warn(text);
		else pi.logger.info(text);
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			if (started || ctx.agent.kind !== "main") return;
			started = true;
			const state = readSwitch();
			if (state.kind === "invalid")
				notify(ctx, `omp-config: ${switchLocation()} is invalid (${state.reason}); auto-update is off`, "warning");
			if (state.kind !== "on") return;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "omp-config: checking…");
			ctx.setTimeout(async () => {
				try {
					const message = startupMessage(await runUpdater(getAgentDir()));
					notify(ctx, message.text, message.level);
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, message.status);
				} catch (error) {
					pi.logger.warn("omp-config: auto-update failed unexpectedly", { error: errorText(error) });
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "omp-config: update failed");
				}
			}, 0);
		} catch (error) {
			pi.logger.warn("omp-config: session_start failed", { error: errorText(error) });
		}
	});
}
