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
// next start, which the update widget says.
//
// VISIBILITY. Only a run that changed something shows anything: a widget above
// the editor lists each update with its old and new version (omp-config by
// commit, plugins by version) and disappears after 5 s. Up to date, a busy
// lock and an offline fetch only log; failures warn. None of them affect the
// session.
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

/** Mirrors PluginChange in omp-config-update.ts. */
const pluginChangeSchema = z.object({ spec: z.string(), name: z.string(), from: z.string().nullable(), to: z.string().nullable() });
type PluginChange = z.infer<typeof pluginChangeSchema>;

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
	pluginChanges: z.array(pluginChangeSchema).default(() => []),
	restartNeeded: z.boolean(),
});

/** Mirrors PluginRefresh in omp-config-update.ts. */
const pluginRefreshSchema = z.object({
	installed: z.array(z.string()),
	upgraded: z.array(z.string()),
	errors: z.array(z.string()),
	changes: z.array(pluginChangeSchema).default(() => []),
});

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

/** "0.1.10 → 0.1.12", "new 0.1.9", or "0.1.12 (new commit)" when omp install moved the commit but not the version. */
function pluginVersionChange(change: PluginChange): string {
	const to = change.to ?? "?";
	if (change.from === null) return `new ${to}`;
	return change.from === change.to ? `${to} (new commit)` : `${change.from} → ${to}`;
}

const pluginLines = (changes: readonly PluginChange[]): string[] =>
	changes.map((change) => `${change.name} ${pluginVersionChange(change)}`);

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
				...section("Plugins", pluginLines(plugins.changes)),
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
				...section("Plugins", pluginLines(report.pluginChanges)),
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

/** One updated item: what it is and how its version moved. */
interface UpdateRow {
	readonly name: string;
	readonly change: string;
}

/** What a startup run shows: nothing (only a log line), the updates, or a failure. */
type StartupOutcome =
	| { readonly kind: "quiet"; readonly log: string }
	| { readonly kind: "updated"; readonly rows: readonly UpdateRow[]; readonly restart: boolean }
	| { readonly kind: "failed"; readonly text: string };

const pluginRows = (changes: readonly PluginChange[]): UpdateRow[] =>
	changes.map((change) => ({ name: change.name, change: pluginVersionChange(change) }));

function startupOutcome(outcome: RunOutcome): StartupOutcome {
	switch (outcome.kind) {
		case "no-script":
			return { kind: "failed", text: `omp-config: ${outcome.script} missing; run /update-omp once to install the updater` };
		case "no-bun":
			return { kind: "failed", text: "omp-config: bun is not on PATH; auto-update skipped" };
		case "no-result":
			return { kind: "failed", text: `omp-config: updater exited ${outcome.code} without a result: ${outcome.stderr.slice(0, 500)}` };
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
			return { kind: "quiet", log: "omp-config: another update is running; skipped" };
		case "offline":
			return { kind: "quiet", log: `omp-config: fetch failed, not updated: ${result.error}` };
		case "failed":
			return { kind: "failed", text: `omp-config: auto-update failed: ${result.error}` };
		case "up-to-date": {
			const { plugins } = result;
			if (plugins.errors.length > 0)
				return {
					kind: "failed",
					text: `omp-config: plugin refresh hit ${plugins.errors.length} error(s), will retry next start: ${plugins.errors[0]}; /omp-config-autoupdate run shows the full report`,
				};
			if (plugins.changes.length === 0) return { kind: "quiet", log: `omp-config: up to date at ${short(result.commit)}, plugins current` };
			return { kind: "updated", rows: pluginRows(plugins.changes), restart: true };
		}
		case "applied": {
			const { report } = result;
			if (report.errors.length > 0)
				return {
					kind: "failed",
					text: `omp-config: applied ${short(result.commit)} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}; /omp-config-autoupdate run shows the full report`,
				};
			const files = report.written.length + report.moved.length + report.deleted.length;
			const rows: UpdateRow[] = [
				...(files === 0
					? []
					: [
							{
								name: "omp-config",
								change: `${result.previous ? short(result.previous) : "new"} → ${short(result.commit)} (${files} file${files === 1 ? "" : "s"})`,
							},
						]),
				...pluginRows(report.pluginChanges),
			];
			if (rows.length === 0) return { kind: "quiet", log: `omp-config: ${short(result.commit)} applied, host already matched` };
			return { kind: "updated", rows, restart: report.restartNeeded };
		}
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

const WIDGET_KEY = "omp-config-update";
const WIDGET_MS = 5_000;

/** Show the updates above the editor for WIDGET_MS: a header, then one aligned "name  old → new" row each. */
function showUpdates(ctx: ExtensionContext, rows: readonly UpdateRow[], restart: boolean): void {
	const { theme } = ctx.ui;
	const width = Math.max(...rows.map((row) => row.name.length));
	ctx.ui.setWidget(WIDGET_KEY, [
		`${theme.fg("accent", "omp-config updated")}${restart ? theme.fg("muted", " · restart OMP to load") : ""}`,
		...rows.map((row) => `  ${row.name.padEnd(width)}  ${row.change}`),
	]);
	ctx.setTimeout(() => ctx.ui.setWidget(WIDGET_KEY, undefined), WIDGET_MS);
}

export default function ompConfigAutoupdate(pi: ExtensionAPI): void {
	registerAutoupdateCommand(pi);

	const warn = (ctx: ExtensionContext, text: string): void => {
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
		pi.logger.warn(text);
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			if (started || ctx.agent.kind !== "main") return;
			started = true;
			const state = readSwitch();
			if (state.kind === "invalid") warn(ctx, `omp-config: ${switchLocation()} is invalid (${state.reason}); auto-update is off`);
			if (state.kind !== "on") return;
			ctx.setTimeout(async () => {
				try {
					const outcome = startupOutcome(await runUpdater(getAgentDir()));
					switch (outcome.kind) {
						case "quiet":
							pi.logger.info(outcome.log);
							return;
						case "failed":
							warn(ctx, outcome.text);
							return;
						case "updated":
							pi.logger.info(
								`omp-config: updated ${outcome.rows.map((row) => `${row.name} ${row.change}`).join("; ")}${outcome.restart ? "; restart to load" : ""}`,
							);
							if (ctx.hasUI) showUpdates(ctx, outcome.rows, outcome.restart);
							return;
						default: {
							const exhaustive: never = outcome;
							return exhaustive;
						}
					}
				} catch (error) {
					pi.logger.warn("omp-config: auto-update failed unexpectedly", { error: errorText(error) });
				}
			}, 0);
		} catch (error) {
			pi.logger.warn("omp-config: session_start failed", { error: errorText(error) });
		}
	});
}
