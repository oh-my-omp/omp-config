// ============================================================================
// omp-config-autoupdate — apply the omp-config repo at OMP start, when enabled,
// or on demand.
//
// SWITCH. Off by default. `/omp-config-autoupdate on|off` writes section
// `omp-config-autoupdate` ({"enabled": true|false, "conflicts"?: "notify" |
// "agent"}) of the agent dir's omomp.* file; `/omp-config-autoupdate` or
// `… status` shows it. A missing or invalid section means off. The section is
// machine-local: the updater does not manage it and /sync-omp-config does not
// carry it. Read at each start, so a change applies from the next OMP start.
//
// CONFLICTS. The updater keeps a local customization that conflicts with an
// upstream change and reports it (see CUSTOMIZATIONS in omp-config-update.ts).
// `conflicts: notify` (the default) only notifies at start and points at
// `/omp-config-autoupdate adapt`. `conflicts: agent` also starts the
// adaptation in the main session by itself, but only right after a run that
// applied a new commit, with a UI, and before the session has a user message;
// otherwise it notifies. `/omp-config-autoupdate adapt` sends the adaptation
// prompt on demand: the agent runs the updater's `conflicts` listing and
// adapts each one with the user. `/omp-config-autoupdate conflicts
// notify|agent` sets the preference.
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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineOmompSection, loadOmompSection, writeOmompSection } from "../_shared/omomp.ts";

const SCRIPT = "omp-config-update.ts";
const REPORT_TYPE = "omp-config-update";

type ConflictMode = "notify" | "agent";

type Switch =
	| { readonly kind: "on"; readonly conflicts: ConflictMode }
	| { readonly kind: "off"; readonly conflicts: ConflictMode }
	| { readonly kind: "invalid"; readonly reason: string };

const switchSchema = z.object({ enabled: z.boolean(), conflicts: z.enum(["notify", "agent"]).optional() }).strict();
type SwitchValue = z.infer<typeof switchSchema>;
const switchSection = defineOmompSection(import.meta.dir, switchSchema);

/** Where the switch lives, for messages. */
const switchLocation = (): string => `${getAgentDir()} (omomp section ${switchSection.id})`;

function readSwitch(): Switch {
	const loaded = loadOmompSection(switchSection, null);
	switch (loaded.kind) {
		case "found": {
			const conflicts = loaded.value.conflicts ?? "notify";
			return loaded.value.enabled ? { kind: "on", conflicts } : { kind: "off", conflicts };
		}
		case "none": {
			// A missing file or section is off; a file that exists but is unusable is reported.
			const [problem] = loaded.skipped;
			return problem === undefined
				? { kind: "off", conflicts: "notify" }
				: { kind: "invalid", reason: `${problem.path}: ${problem.reason}` };
		}
		default: {
			const exhaustive: never = loaded;
			return exhaustive;
		}
	}
}

/** Change one field of the switch, keeping the other; an invalid section is replaced. */
function writeSwitch(patch: Partial<SwitchValue>): void {
	const loaded = loadOmompSection(switchSection, null);
	const current: SwitchValue = loaded.kind === "found" ? loaded.value : { enabled: false };
	writeOmompSection(switchSection.id, { ...current, ...patch });
}

/** Mirrors PluginChange in omp-config-update.ts. */
const pluginChangeSchema = z.object({ spec: z.string(), name: z.string(), from: z.string().nullable(), to: z.string().nullable() });
type PluginChange = z.infer<typeof pluginChangeSchema>;

/** Mirrors Conflict in omp-config-update.ts. */
const conflictSchema = z.union([
	z.object({ kind: z.literal("file"), id: z.string(), rel: z.string(), target: z.string(), reason: z.string() }),
	z.object({ kind: z.literal("key"), id: z.string(), rel: z.string(), target: z.string(), path: z.array(z.string()), reason: z.string() }),
]);
type Conflict = z.infer<typeof conflictSchema>;

/** Mirrors ConflictScan in omp-config-update.ts. */
const conflictScanSchema = z.union([
	z.object({ kind: z.literal("scanned"), conflicts: z.array(conflictSchema) }),
	z.object({ kind: z.literal("failed"), error: z.string() }),
]);

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
	conflicts: z.array(conflictSchema).default(() => []),
	overwritten: z.array(z.string()).default(() => []),
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
	z.object({
		kind: z.literal("up-to-date"),
		commit: z.string(),
		plugins: pluginRefreshSchema,
		scan: conflictScanSchema.default(() => ({ kind: "scanned" as const, conflicts: [] })),
	}),
	z.object({ kind: z.literal("applied"), commit: z.string(), previous: z.string().optional(), report: applyReportSchema }),
	z.object({ kind: z.literal("failed"), error: z.string() }),
]);
type AutoResult = z.infer<typeof autoResultSchema>;

/** Everything one updater run can end in, including not getting to run it. */
type RunOutcome<T> =
	| { readonly kind: "no-script"; readonly script: string }
	| { readonly kind: "no-bun" }
	| { readonly kind: "no-result"; readonly code: number | null; readonly stderr: string }
	| { readonly kind: "result"; readonly result: T };

/** One automatic run per process: child sessions share this module and must not re-run it. */
let started = false;

/** Anything with zod's `safeParse`: the schema of one updater command's JSON. */
type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

function parseResult<T>(stdout: string, schema: Parser<T>): T | undefined {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		const parsed = schema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	} catch {
		// Malformed child JSON is an expected no-result outcome.
		return undefined;
	}
}

type ChildRun = { code: number | null; stdout: string; stderr: string };

function runChild(bun: string, args: readonly string[]): Promise<ChildRun> {
	const { promise, resolve } = Promise.withResolvers<ChildRun>();
	const child = spawn(bun, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
	child.on("close", (code) => resolve({ code, stdout, stderr }));
	return promise;
}

/** Run one updater command with `--json` against `agentDir` and parse its last line. */
async function runUpdater<T>(command: "auto" | "conflicts", agentDir: string, schema: Parser<T>): Promise<RunOutcome<T>> {
	const script = join(import.meta.dir, SCRIPT);
	if (!existsSync(script)) return { kind: "no-script", script };
	const bun = Bun.which("bun");
	if (!bun) return { kind: "no-bun" };
	const run = await runChild(bun, [script, command, "--agent-dir", agentDir, "--json"]);
	const result = parseResult(run.stdout, schema);
	return result !== undefined ? { kind: "result", result } : { kind: "no-result", code: run.code, stderr: run.stderr.trim() };
}

const short = (commit: string): string => commit.slice(0, 7);

function section(title: string, items: readonly string[]): string[] {
	return items.length === 0 ? [] : ["", `## ${title} (${items.length})`, ...items.map((item) => `- \`${item}\``)];
}

/** "0.1.10 → 0.1.12", "new 0.1.9", or "0.1.12 (new commit)" when omp install moved the commit but not the version. */
function pluginVersionChange(change: PluginChange): string {
	const to = change.to ?? "?";
	if (change.from === null) return tr(`new ${to}`, `新增 ${to}`);
	return change.from === change.to ? tr(`${to} (new commit)`, `${to}（新提交）`) : `${change.from} → ${to}`;
}

const pluginLines = (changes: readonly PluginChange[]): string[] =>
	changes.map((change) => `${change.name} ${pluginVersionChange(change)}`);

/** The conflicts section of a report, with how to adapt them. */
function conflictSection(conflicts: readonly Conflict[]): string[] {
	if (conflicts.length === 0) return [];
	return [
		...section(
			tr("Conflicts — local copy kept", "冲突 — 已保留本机内容"),
			conflicts.map((conflict) => `${conflict.id}\` — \`${conflict.reason}`),
		),
		"",
		tr("Run `/omp-config-autoupdate adapt` to adapt them.", "运行 `/omp-config-autoupdate adapt` 适配这些冲突。"),
	];
}

/** Markdown report of one manual run: every path and message the updater returned. */
function detailedReport(outcome: RunOutcome<AutoResult>, agentDir: string): string {
	const head = [tr("# omp-config update", "# omp-config 更新"), "", `- **${tr("Agent dir", "Agent 目录")}:** \`${agentDir}\``];
	switch (outcome.kind) {
		case "no-script":
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${tr(
					`not run: \`${outcome.script}\` is missing. Run \`/update-omp\` once from the omp-config checkout to install the updater.`,
					`未运行：找不到 \`${outcome.script}\`。请在 omp-config 检出目录中运行一次 \`/update-omp\` 以安装更新器。`,
				)}`,
			].join("\n");
		case "no-bun":
			return [...head, `- **${tr("Result", "结果")}:** ${tr("not run: `bun` is not on PATH.", "未运行：PATH 中找不到 `bun`。")}`].join(
				"\n",
			);
		case "no-result":
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${tr(
					`the updater exited ${outcome.code} without a result.`,
					`更新器退出码为 ${outcome.code}，未返回结果。`,
				)}`,
				"",
				"```",
				outcome.stderr || tr("(no stderr)", "（无标准错误输出）"),
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
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${tr(
					"skipped: another update holds `~/.omp/omp-config-update.lock`. Retry when it finishes.",
					"已跳过：另一个更新正在持有 `~/.omp/omp-config-update.lock`。请在其完成后重试。",
				)}`,
			].join("\n");
		case "offline":
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${tr(
					"not updated: fetching GitHub failed, so nothing was compared or applied.",
					"未更新：获取 GitHub 失败，因此未进行比较或应用。",
				)}`,
				"",
				"```",
				result.error,
				"```",
			].join("\n");
		case "failed":
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${tr("failed; nothing was recorded as applied.", "失败；未记录应用结果。")}`,
				"",
				"```",
				result.error,
				"```",
			].join("\n");
		case "up-to-date": {
			const { plugins } = result;
			const changed = plugins.installed.length + plugins.upgraded.length;
			const outcomeLine =
				plugins.errors.length > 0
					? tr(
							`config up to date; refreshing plugins hit ${plugins.errors.length} error(s), retried next start`,
							`配置已是最新；刷新插件时遇到 ${plugins.errors.length} 个错误，下次启动将重试`,
						)
					: changed > 0
						? tr("config up to date; plugins updated", "配置已是最新；插件已更新")
						: tr("up to date; config and plugins unchanged", "已是最新；配置和插件均未改变");
			return [
				...head,
				`- **${tr("Result", "结果")}:** ${outcomeLine}`,
				`- **${tr("Commit", "提交")}:** \`${short(result.commit)}\` (\`${result.commit}\`)${tr(", nothing applied", "，未应用任何更改")}`,
				`- **${tr("Restart needed", "需要重启")}:** ${changed > 0 ? tr("yes — plugins changed", "是 — 插件发生变化") : tr("no", "否")}`,
				...section(tr("Errors", "错误"), [...plugins.errors, ...(result.scan.kind === "failed" ? [result.scan.error] : [])]),
				...section(tr("Plugins", "插件"), pluginLines(plugins.changes)),
				...conflictSection(result.scan.kind === "scanned" ? result.scan.conflicts : []),
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
					? tr(
							`applied with ${report.errors.length} error(s); the applied commit is not recorded, so the next run retries`,
							`已应用，但出现 ${report.errors.length} 个错误；未记录已应用的提交，因此下次运行将重试`,
						)
					: changed === 0
						? tr("applied; this machine already matched, nothing written", "已应用；此机器已经匹配，未写入任何内容")
						: tr("updated", "已更新");
			const lines = [
				...head,
				`- **${tr("Result", "结果")}:** ${outcomeLine}`,
				`- **${tr("Commit", "提交")}:** ${result.previous ? `\`${short(result.previous)}\` → ` : tr("(no previous record) → ", "（无先前记录）→ ")}\`${short(result.commit)}\` (\`${result.commit}\`)`,
				`- **${tr("Restart needed", "需要重启")}:** ${report.restartNeeded ? tr("yes — extensions, APPEND_SYSTEM.md or plugins changed", "是 — 扩展、APPEND_SYSTEM.md 或插件发生变化") : tr("no", "否")}`,
				...section(tr("Errors", "错误"), report.errors),
				...section(tr("Written", "已写入"), report.written),
				...section(
					tr("Moved", "已移动"),
					report.moved.map((entry) => `${entry.from}\` → \`${entry.to}`),
				),
				...section(tr("Deleted", "已删除"), report.deleted),
				...section(
					tr("Skipped", "已跳过"),
					report.skipped.map((entry) => `${entry.path}\` — \`${entry.reason}`),
				),
				...section(tr("Customized code overwritten", "被覆盖的本机代码修改"), report.overwritten),
				...section(tr("Plugins", "插件"), pluginLines(report.pluginChanges)),
				...section(tr("Plugins still missing", "仍缺少的插件"), report.pluginsMissing),
				...section(tr("Notes", "备注"), report.notes),
				...conflictSection(report.conflicts),
			];
			return lines.join("\n");
		}
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

/** Why an updater command produced no result, for a notification. */
function notRun(outcome: Exclude<RunOutcome<unknown>, { readonly kind: "result" }>): { readonly en: string; readonly zh: string } {
	switch (outcome.kind) {
		case "no-script":
			return {
				en: `omp-config: ${outcome.script} missing; run /update-omp once to install the updater`,
				zh: `omp-config：缺少 ${outcome.script}；请运行一次 /update-omp 以安装更新器`,
			};
		case "no-bun":
			return { en: "omp-config: bun is not on PATH; updater not run", zh: "omp-config：PATH 中找不到 bun；未运行更新器" };
		case "no-result":
			return {
				en: `omp-config: updater exited ${outcome.code} without a result: ${outcome.stderr.slice(0, 500)}`,
				zh: `omp-config：更新器退出码为 ${outcome.code}，未返回结果：${outcome.stderr.slice(0, 500)}`,
			};
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}

/** The message that starts adapting conflicts in the main session: the updater's listing carries the procedure. */
function adaptPrompt(agentDir: string, count: number): string {
	return [
		`omp-config kept ${count} local customization(s) in ${agentDir} that conflict with upstream changes.`,
		`Run \`bun "${join(import.meta.dir, SCRIPT)}" conflicts --agent-dir "${agentDir}"\` and follow the procedure it prints to adapt them with the user.`,
	].join("\n");
}

/** `/omp-config-autoupdate adapt`: list the conflicts and, when there are any, start adapting them. */
async function adaptNow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const agentDir = getAgentDir();
	const outcome = await runUpdater("conflicts", agentDir, conflictScanSchema);
	if (outcome.kind !== "result") {
		const failure = notRun(outcome);
		ctx.ui.notify(tr(failure.en, failure.zh), "warning");
		return;
	}
	const scan = outcome.result;
	switch (scan.kind) {
		case "failed":
			ctx.ui.notify(tr(`omp-config: conflict scan failed: ${scan.error}`, `omp-config：冲突扫描失败：${scan.error}`), "warning");
			return;
		case "scanned":
			if (scan.conflicts.length === 0) {
				ctx.ui.notify(tr("omp-config: no conflicts to adapt", "omp-config：没有需要适配的冲突"), "info");
				return;
			}
			await ctx.waitForIdle();
			pi.sendUserMessage(adaptPrompt(agentDir, scan.conflicts.length), { attribution: "agent" });
			return;
		default: {
			const exhaustive: never = scan;
			return exhaustive;
		}
	}
}

/** `/omp-config-autoupdate on|off|conflicts …`: write one switch field, then say when it applies. */
function setSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, patch: Partial<SwitchValue>, en: string, zh: string): void {
	try {
		writeSwitch(patch);
	} catch (error) {
		pi.logger.warn("omp-config: cannot write auto-update switch", { error: errorText(error) });
		ctx.ui.notify(
			tr(
				`omp-config: cannot write ${switchLocation()}: ${errorText(error)}`,
				`omp-config：无法写入 ${switchLocation()}：${errorText(error)}`,
			),
			"error",
		);
		return;
	}
	ctx.ui.notify(tr(`${en} (${switchLocation()})`, `${zh}（${switchLocation()}）`), "info");
}

function showStatus(ctx: ExtensionCommandContext): void {
	const state = readSwitch();
	switch (state.kind) {
		case "on":
		case "off": {
			const mode =
				state.conflicts === "agent"
					? tr("conflicts start the adaptation agent", "冲突时自动启动适配 agent")
					: tr("conflicts are only notified", "冲突时只通知");
			ctx.ui.notify(
				state.kind === "on"
					? tr(
							`omp-config: auto-update is on, ${mode} (${switchLocation()}); /omp-config-autoupdate run updates now`,
							`omp-config：自动更新已开启，${mode}（${switchLocation()}）；运行 /omp-config-autoupdate run 立即更新`,
						)
					: tr(
							`omp-config: auto-update is off, ${mode} (${switchLocation()}); enable with /omp-config-autoupdate on, or update once now with /omp-config-autoupdate run`,
							`omp-config：自动更新已关闭，${mode}（${switchLocation()}）；请使用 /omp-config-autoupdate on 启用，或使用 /omp-config-autoupdate run 立即更新`,
						),
				"info",
			);
			return;
		}
		case "invalid":
			ctx.ui.notify(
				tr(
					`omp-config: ${switchLocation()} is invalid (${state.reason}); auto-update is off`,
					`omp-config：${switchLocation()} 无效（${state.reason}）；自动更新已关闭`,
				),
				"warning",
			);
			return;
		default: {
			const exhaustive: never = state;
			throw new Error(`unknown switch state ${String(exhaustive)}`);
		}
	}
}

const COMMAND_ACTIONS: readonly { readonly value: string; readonly en: string; readonly zh: string }[] = [
	{ value: "status", en: "status", zh: "状态" },
	{ value: "on", en: "on", zh: "开启" },
	{ value: "off", en: "off", zh: "关闭" },
	{ value: "run", en: "run", zh: "运行" },
	{ value: "adapt", en: "adapt conflicts", zh: "适配冲突" },
	{ value: "conflicts notify", en: "conflicts: notify only", zh: "冲突：只通知" },
	{ value: "conflicts agent", en: "conflicts: start the agent", zh: "冲突：自动启动 agent" },
];

function registerAutoupdateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("omp-config-autoupdate", {
		description: tr(
			"omp-config auto-update: /omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|agent] (run = update from GitHub now; adapt = adapt conflicting customizations)",
			"omp-config 自动更新：/omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|agent]（run = 立即从 GitHub 更新；adapt = 适配与上游冲突的本机定制）",
		),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const matches = COMMAND_ACTIONS.filter((action) => action.value.startsWith(typed)).map((action) => ({
				value: action.value,
				label: tr(action.en, action.zh),
			}));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				const action = args.trim().toLowerCase().replace(/\s+/g, " ") || "status";
				switch (action) {
					case "run": {
						const agentDir = getAgentDir();
						ctx.ui.notify(tr("omp-config: updating from GitHub…", "omp-config：正在从 GitHub 更新…"), "info");
						const outcome = await runUpdater("auto", agentDir, autoResultSchema);
						await ctx.waitForIdle();
						pi.sendMessage(
							{ customType: REPORT_TYPE, content: detailedReport(outcome, agentDir), display: true, attribution: "agent" },
							{ triggerTurn: false },
						);
						return;
					}
					case "adapt":
						await adaptNow(pi, ctx);
						return;
					case "on":
					case "off":
						setSwitch(
							pi,
							ctx,
							{ enabled: action === "on" },
							`omp-config: auto-update ${action}; takes effect from the next OMP start`,
							`omp-config：自动更新已${action === "on" ? "开启" : "关闭"}；将从下次 OMP 启动时生效`,
						);
						return;
					case "conflicts notify":
					case "conflicts agent": {
						const mode: ConflictMode = action === "conflicts agent" ? "agent" : "notify";
						setSwitch(
							pi,
							ctx,
							{ conflicts: mode },
							`omp-config: conflicts ${mode === "agent" ? "start the adaptation agent" : "are only notified"} from the next OMP start`,
							`omp-config：从下次 OMP 启动起，冲突时${mode === "agent" ? "自动启动适配 agent" : "只通知"}`,
						);
						return;
					}
					case "status":
						showStatus(ctx);
						return;
					default:
						ctx.ui.notify(
							tr(
								"Usage: /omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|conflicts agent]",
								"用法：/omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|conflicts agent]",
							),
							"warning",
						);
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
	readonly logChange: string;
}

/** What a startup run shows: nothing (only a log line), the updates, or a failure. */
type StartupOutcome =
	| { readonly kind: "quiet"; readonly log: string }
	| { readonly kind: "updated"; readonly rows: readonly UpdateRow[]; readonly restart: boolean }
	| { readonly kind: "failed"; readonly en: string; readonly zh: string };

function pluginVersionChangeEnglish(change: PluginChange): string {
	const to = change.to ?? "?";
	if (change.from === null) return `new ${to}`;
	return change.from === change.to ? `${to} (new commit)` : `${change.from} → ${to}`;
}

const pluginRows = (changes: readonly PluginChange[]): UpdateRow[] =>
	changes.map((change) => ({
		name: change.name,
		change: pluginVersionChange(change),
		logChange: pluginVersionChangeEnglish(change),
	}));

function startupOutcome(outcome: RunOutcome<AutoResult>): StartupOutcome {
	if (outcome.kind !== "result") return { kind: "failed", ...notRun(outcome) };
	const result = outcome.result;
	switch (result.kind) {
		case "busy":
			return { kind: "quiet", log: "omp-config: another update is running; skipped" };
		case "offline":
			return { kind: "quiet", log: `omp-config: fetch failed, not updated: ${result.error}` };
		case "failed":
			return {
				kind: "failed",
				en: `omp-config: auto-update failed: ${result.error}`,
				zh: `omp-config：自动更新失败：${result.error}`,
			};
		case "up-to-date": {
			const { plugins } = result;
			if (plugins.errors.length > 0)
				return {
					kind: "failed",
					en: `omp-config: plugin refresh hit ${plugins.errors.length} error(s), will retry next start: ${plugins.errors[0]}; /omp-config-autoupdate run shows the full report`,
					zh: `omp-config：刷新插件时遇到 ${plugins.errors.length} 个错误，将在下次启动时重试：${plugins.errors[0]}；运行 /omp-config-autoupdate run 可查看完整报告`,
				};
			if (plugins.changes.length === 0) return { kind: "quiet", log: `omp-config: up to date at ${short(result.commit)}, plugins current` };
			return { kind: "updated", rows: pluginRows(plugins.changes), restart: true };
		}
		case "applied": {
			const { report } = result;
			if (report.errors.length > 0)
				return {
					kind: "failed",
					en: `omp-config: applied ${short(result.commit)} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}; /omp-config-autoupdate run shows the full report`,
					zh: `omp-config：已应用 ${short(result.commit)}，但出现 ${report.errors.length} 个错误，将在下次启动时重试：${report.errors[0]}；运行 /omp-config-autoupdate run 可查看完整报告`,
				};
			const files = report.written.length + report.moved.length + report.deleted.length;
			const rows: UpdateRow[] = [];
			if (files > 0) {
				const previous = result.previous ? short(result.previous) : "new";
				rows.push({
					name: "omp-config",
					change: tr(
						`${previous} → ${short(result.commit)} (${files} file${files === 1 ? "" : "s"})`,
						`${result.previous ? short(result.previous) : "新建"} → ${short(result.commit)}（${files} 个文件）`,
					),
					logChange: `${previous} → ${short(result.commit)} (${files} file${files === 1 ? "" : "s"})`,
				});
			}
			rows.push(...pluginRows(report.pluginChanges));
			if (rows.length === 0) return { kind: "quiet", log: `omp-config: ${short(result.commit)} applied, host already matched` };
			return { kind: "updated", rows, restart: report.restartNeeded };
		}
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

/** The conflicts a startup run reports: freshly found by an apply, re-scanned at an unchanged commit, or none. */
type ConflictState =
	| { readonly kind: "none" }
	| { readonly kind: "pending"; readonly conflicts: readonly Conflict[]; readonly fresh: boolean }
	| { readonly kind: "scan-failed"; readonly error: string };

function conflictState(outcome: RunOutcome<AutoResult>): ConflictState {
	if (outcome.kind !== "result") return { kind: "none" };
	const result = outcome.result;
	switch (result.kind) {
		case "applied":
			return result.report.conflicts.length > 0 ? { kind: "pending", conflicts: result.report.conflicts, fresh: true } : { kind: "none" };
		case "up-to-date":
			if (result.scan.kind === "failed") return { kind: "scan-failed", error: result.scan.error };
			return result.scan.conflicts.length > 0 ? { kind: "pending", conflicts: result.scan.conflicts, fresh: false } : { kind: "none" };
		case "busy":
		case "offline":
		case "failed":
			return { kind: "none" };
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

/** The session already has a user message on its branch: an adaptation turn would barge into the user's work. */
function hasUserMessage(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user");
}

/**
 * Start the adaptation (mode `agent`, a run that just applied, an idle UI
 * session without a user message yet), or notify that conflicts are pending.
 */
function handleConflicts(pi: ExtensionAPI, ctx: ExtensionContext, state: ConflictState, mode: ConflictMode): void {
	switch (state.kind) {
		case "none":
			return;
		case "scan-failed":
			pi.logger.warn(`omp-config: conflict scan failed: ${state.error}`);
			return;
		case "pending": {
			const count = state.conflicts.length;
			pi.logger.info(`omp-config: conflicts pending: ${state.conflicts.map((conflict) => conflict.id).join(", ")}`);
			if (mode === "agent" && state.fresh && ctx.hasUI && ctx.isIdle() && !ctx.hasPendingMessages() && !hasUserMessage(ctx)) {
				pi.sendUserMessage(adaptPrompt(getAgentDir(), count), { attribution: "agent" });
				return;
			}
			if (ctx.hasUI)
				ctx.ui.notify(
					tr(
						`omp-config: ${count} local customization(s) conflict with upstream and were kept; /omp-config-autoupdate adapt adapts them`,
						`omp-config：${count} 项本机定制与上游更新冲突，已保留本机内容；运行 /omp-config-autoupdate adapt 进行适配`,
					),
					"warning",
				);
			return;
		}
		default: {
			const exhaustive: never = state;
			throw new Error(`unknown conflict state ${String(exhaustive)}`);
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
		`${theme.fg("accent", tr("omp-config updated", "omp-config 已更新"))}${restart ? theme.fg("muted", tr(" · restart OMP to load", " · 重启 OMP 以加载")) : ""}`,
		...rows.map((row) => `  ${row.name.padEnd(width)}  ${row.change}`),
	]);
	ctx.setTimeout(() => ctx.ui.setWidget(WIDGET_KEY, undefined), WIDGET_MS);
}

export default function ompConfigAutoupdate(pi: ExtensionAPI): void {
	registerAutoupdateCommand(pi);

	const warn = (ctx: ExtensionContext, en: string, zh: string): void => {
		if (ctx.hasUI) ctx.ui.notify(tr(en, zh), "warning");
		pi.logger.warn(en);
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			if (started || ctx.agent.kind !== "main") return;
			started = true;
			const state = readSwitch();
			if (state.kind === "invalid")
				warn(
					ctx,
					`omp-config: ${switchLocation()} is invalid (${state.reason}); auto-update is off`,
					`omp-config：${switchLocation()} 无效（${state.reason}）；自动更新已关闭`,
				);
			if (state.kind !== "on") return;
			ctx.setTimeout(async () => {
				try {
					const run = await runUpdater("auto", getAgentDir(), autoResultSchema);
					const outcome = startupOutcome(run);
					switch (outcome.kind) {
						case "quiet":
							pi.logger.info(outcome.log);
							break;
						case "failed":
							warn(ctx, outcome.en, outcome.zh);
							break;
						case "updated":
							pi.logger.info(
								`omp-config: updated ${outcome.rows.map((row) => `${row.name} ${row.logChange}`).join("; ")}${outcome.restart ? "; restart to load" : ""}`,
							);
							if (ctx.hasUI) showUpdates(ctx, outcome.rows, outcome.restart);
							break;
						default: {
							const exhaustive: never = outcome;
							return exhaustive;
						}
					}
					handleConflicts(pi, ctx, conflictState(run), state.conflicts);
				} catch (error) {
					pi.logger.warn("omp-config: auto-update failed unexpectedly", { error: errorText(error) });
				}
			}, 0);
		} catch (error) {
			pi.logger.warn("omp-config: session_start failed", { error: errorText(error) });
		}
	});
}
