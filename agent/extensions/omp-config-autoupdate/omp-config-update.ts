#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { errorText } from "../_shared/errors.ts";
import { BASE_DIR, type BaseChange, BaseRecord, git, type PlainBase, RepoHistory, type StructuredRecord } from "./base.ts";
import { conflictsText, type ResolveOutcome, resolveConflicts } from "./conflicts.ts";
import { atomicWrite, errnoIs, isAppManaged, lexists } from "./files.ts";
import { installLauncher } from "./launcher.ts";
import {
	type DataMove,
	groupReplacementMigration,
	migrateConfigMapping,
	planRelocations,
	planReplacementMigration,
	REPLACEMENT_RULES_REL,
	type Supersession,
} from "./legacy.ts";
import {
	type ConflictReason,
	canonical,
	type Format,
	type Mapping,
	mergeStructured,
	type PathRules,
	parseStructured,
	pointer,
	related,
	type StructuredBaseSource,
	serialize,
	setAt,
	valueAt,
} from "./merge.ts";
import {
	agentPathOf,
	agentRelOf,
	CONFIG_REL,
	EXCLUDED_REASON,
	type Exclusions,
	fieldExcluded,
	OMOMP_REL,
	PLUGIN_DIR,
	plainRelExcluded,
	ROOT_CHANGELOG_REL,
	targetOf,
} from "./paths.ts";
import { type Op, type PlanContext, skipExcluded } from "./plan.ts";
import { declaredPlugins, pluginCatalog, pluginReadiness, type RequiredPlugin, refreshMovingPlugins, syncPlugins } from "./plugins.ts";
import {
	type ApplyOptions,
	type ApplyReport,
	type Conflict,
	type ConflictScan,
	newReport,
	type PluginChange,
	type PluginRefresh,
} from "./report.ts";
import { exclusionsOf, reportPendingSettings, type SettingsPreflight, settingsPreflight, settleSettings } from "./settings-migration.ts";

export type { ApplyOptions, ApplyReport, Conflict, ConflictScan, PluginChange, PluginRefresh, ResolveOutcome };

export const REPO_URL = "https://github.com/oh-my-omp/omp-config.git";
const PREVIOUS_REPO_URLS: readonly string[] = ["https://github.com/mouriya-s-lab/omp-config.git"];
export const DEFAULT_BRANCH = "release";
export const APPLIED_MARKER = ".omp-config-applied";

export const LOCAL_CONFIG_FIELDS: readonly string[] = [
	"providers.webSearchOrder",
	"modelRoles",
	"defaultThinkingLevel",
	"skills",
	"symbolPreset",
	"theme",
	"colorBlindMode",
	"hideThinkingBlock",
	"statusLine",
	"terminal",
	"tui",
	"display",
	"worktree",
	"compaction.thresholdTokens",
	"compaction.thresholdPercent",
	"compaction.idleThresholdTokens",
	"setupVersion",
	"dev.autoqaConsent",
	"codexResets",
	"claudeResets",
];

export const SEED_CONFIG_FIELDS: readonly string[] = [
	"browser",
	"composer",
	"cycleOrder",
	"task.maxConcurrency",
	"task.agentModelOverrides",
	"retry.fallbackChains",
];

export const MACHINE_LIST_FIELDS: readonly string[] = ["extensions", "disabledProviders"];

const RETIRED_LIST_ENTRIES: Readonly<Record<string, readonly string[]>> = {
	extensions: ["~/.omp/agent/extensions-last/system-prompt-replace.ts"],
};

const UPDATER_REL = "extensions/omp-config-autoupdate/omp-config-update.ts";
const LEGACY_UPDATER_REL = "omp-config-update.ts";

const TODO_PLUGIN: RequiredPlugin = {
	name: "omp-todo-more",
	label: "Todo plugin",
	requiredBy: (spec) => spec === "https://github.com/oh-my-omp/omp-todo-more#release",
	entry: "./index.ts",
	files: ["index.ts"],
};
const TODO_RETIREMENTS: readonly string[] = [
	"extensions/todo-more/index.ts",
	"extensions/todo-more/tool.ts",
	"extensions/todo-more/render.ts",
	"extensions/todo-more/reminders.ts",
	"extensions/todo-more/planning.ts",
	"extensions/_shared/todo-more.ts",
	"extensions/subagent-todo.ts",
	"extensions/subagent-todo/index.ts",
];

const CTX_RETIREMENTS: readonly string[] = [
	"extensions/ctx-tool/index.ts",
	"extensions/ctx-tool/inventory.ts",
	"extensions/ctx-tool/post-compact-hint.ts",
	"extensions/ctx-tasklog/index.ts",
	"extensions/_shared/task-log.ts",
];

const FORK_PLUGIN: RequiredPlugin = {
	name: "omp-subagent-more",
	label: "omp-subagent-more plugin",
	requiredBy: (spec) => spec.split("#", 1)[0] === "https://github.com/oh-my-omp/omp-subagent-more",
	entry: "./extensions/fork-task/index.ts",
	files: ["extensions/fork-task/index.ts", "agents/fork-self.md"],
};
const FORK_RETIREMENTS: readonly string[] = [
	"extensions/fork-task/index.ts",
	"extensions/fork-task/replica.ts",
	"extensions/fork-task/replica-file.ts",
	"extensions/fork-task/source-channel.ts",
	"extensions/fork-task/sweep.ts",
	"extensions/fork-task/topics.ts",
	"extensions/fork-task/workspace.ts",
	"extensions/fork-task.ts",
	"agents/fork-self.md",
];

const LEGACY_RETIREMENTS: readonly string[] = ["thinking-translator.json", "extensions/task-tool-trim/index.ts"];

const LEGACY_RETIRED_DIRS: readonly string[] = ["extensions/task-tool-trim", "extensions/fork-task"];

function retired(ctx: Pick<PlanContext, "todoRequired" | "forkRequired">, leaf: string, ctxRetiring: boolean): boolean {
	return (
		(ctx.todoRequired && TODO_RETIREMENTS.includes(leaf)) ||
		(ctxRetiring && CTX_RETIREMENTS.includes(leaf)) ||
		(ctx.forkRequired && FORK_RETIREMENTS.includes(leaf)) ||
		LEGACY_RETIREMENTS.includes(leaf)
	);
}

const SUPERSEDED: readonly Supersession[] = [
	...[
		"append-system-model",
		"input-polish",
		"isolation-nudge",
		"lang-nag",
		"omp-config-autoupdate",
		"repo-rules",
		"task-completion-judge",
		"task-split-check",
		"tool-policy-nag",
		"turn-judge",
		"user-prompt-inject",
		"watchdog-agent",
		"wt-tool",
	].map((name) => ({ from: `extensions/${name}.ts`, by: `extensions/${name}/index.ts` })),
	{ from: "extensions-last/system-prompt-replace.ts", by: "extensions-last/system-prompt-replace/index.ts" },
	{ from: "extensions/read-topics/index.ts", by: "extensions/tool-topics/index.ts" },
	{ from: LEGACY_UPDATER_REL, by: UPDATER_REL },
];

const DATA_MOVES: readonly DataMove[] = [
	{
		kind: "split-model",
		owner: "host",
		from: ["APPEND_SYSTEM_MODEL.md", "extensions/append-system-model/APPEND_SYSTEM_MODEL.md"],
		toDir: "extensions/append-system-model",
	},
	{ kind: "pattern", owner: "template", pattern: /^PROMPT-INJECT-.+\.md$/i, toDir: "extensions/user-prompt-inject" },
	{ kind: "pattern", owner: "template", pattern: /^TURN-JUDGE-.+\.md$/i, toDir: "extensions/turn-judge" },
	{ kind: "pattern", owner: "host", pattern: /^WATCHDOG-.+\.md$/i, toDir: "extensions/watchdog-agent" },
];

interface StructuredItem {
	readonly rel: string;
	readonly format: Format;
	readonly rules: PathRules;
}

const STRUCTURED: readonly StructuredItem[] = [
	{
		rel: CONFIG_REL,
		format: "yaml",
		rules: { local: LOCAL_CONFIG_FIELDS, seed: SEED_CONFIG_FIELDS, machineLists: MACHINE_LIST_FIELDS, retired: RETIRED_LIST_ENTRIES },
	},
];

const FIELD_EXCLUDE_FILES: readonly string[] = [OMOMP_REL, ...STRUCTURED.map((item) => item.rel)];

function formatOf(rel: string): Format {
	return STRUCTURED.find((item) => item.rel === rel)?.format ?? "yaml";
}

const MACHINE_OWNED_PLAIN = /^agent\/agents\/[^/]+\.md$/;

function managedPlain(rel: string): boolean {
	if (rel.split("/").some((part) => part.startsWith("."))) return false;
	return (
		/^agent\/(SYSTEM_TEMPLATE|APPEND_SYSTEM|APPEND_SYSTEM_LIGHT|PERSONALITY)\.md$/.test(rel) ||
		/^agent\/(config-light\.yml|omp-light\.ts)$/.test(rel) ||
		/^agent\/agents\/.+$/.test(rel) ||
		/^agent\/(extensions|extensions-last)\/[^/]+\/[^/]+\.ts$/.test(rel) ||
		/^agent\/extensions\/_shared\/omomp-shared\/[^/]+\.ts$/.test(rel) ||
		/^agent\/extensions\/append-system-model\/APPEND-SYSTEM-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions-last\/system-prompt-replace\/REPLACE-SYSTEM-[^/]+\.ya?ml$/.test(rel) ||
		/^agent\/extensions\/user-prompt-inject\/PROMPT-INJECT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/turn-judge\/TURN-JUDGE-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-policy-nag\/INTENT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md$/.test(rel) ||
		rel === "agent/extensions/argon-long-output/ARGON_PROMPT.md" ||
		rel === `agent/${PLUGIN_DIR}/package.json` ||
		rel === ROOT_CHANGELOG_REL
	);
}

const RESTART_SCOPED =
	/^agent\/(SYSTEM_TEMPLATE\.md|APPEND_SYSTEM\.md|PERSONALITY\.md|extensions\/.+\.ts|extensions-last\/.+\.ts|extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md)$/;

// Throw, never filter: dropping the write side of a planned move still deletes its source.
function assertNoExcludedOps(ctx: PlanContext, ops: readonly Op[]): void {
	const relOf = (target: string): string | undefined => agentRelOf(ctx.opts.agentDir, target);
	for (const op of ops) {
		const touched: (string | undefined)[] = [op.rel];
		if (op.kind === "move") touched.push(relOf(op.from), relOf(op.target));
		if (op.kind === "split") touched.push(...op.fragments.map((fragment) => relOf(fragment.target)));
		if (op.kind === "migrate-replacements") touched.push(...op.writes.map((write) => write.rel), ...op.deletes.map(relOf));
		for (const rel of touched)
			if (rel !== undefined && plainRelExcluded(rel, ctx.exclusions))
				throw new Error(`planned operation touches excluded item ${rel}; nothing applied`);
	}
}

export type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string; readonly plugins: PluginRefresh; readonly scan: ConflictScan }
	| { readonly kind: "applied"; readonly commit: string; readonly previous: string | undefined; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

function freshMachine(agentDir: string, base: BaseRecord): boolean {
	return !base.exists && !lexists(join(agentDir, UPDATER_REL)) && !lexists(join(agentDir, LEGACY_UPDATER_REL));
}

function digest(content: string | Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(content);
	return hasher.digest("hex").slice(0, 12);
}

function listSourceFiles(source: string): string[] {
	const root = join(source, "agent");
	const entries = readdirSync(root, { recursive: true, withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const abs = join(entry.parentPath, entry.name);
		const rel = `agent/${abs
			.slice(root.length + 1)
			.split("\\")
			.join("/")}`;
		if (managedPlain(rel)) files.push(rel);
	}
	if (existsSync(join(source, ROOT_CHANGELOG_REL))) files.push(ROOT_CHANGELOG_REL);
	return files.sort();
}

type TextMerge = { readonly kind: "clean"; readonly content: Buffer } | { readonly kind: "conflict" };

function mergeText(host: Uint8Array, base: Uint8Array, repo: Uint8Array): TextMerge {
	const dir = mkdtempSync(join(tmpdir(), "omp-config-merge-"));
	try {
		const local = join(dir, "local");
		const ancestor = join(dir, "base");
		const upstream = join(dir, "upstream");
		writeFileSync(local, host);
		writeFileSync(ancestor, base);
		writeFileSync(upstream, repo);
		const result = spawnSync("git", ["merge-file", "-p", local, ancestor, upstream]);
		return result.status === 0 && !result.error ? { kind: "clean", content: result.stdout } : { kind: "conflict" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type PlainSource =
	| { readonly kind: "host" }
	| { readonly kind: "dropped"; readonly content: Buffer }
	| { readonly kind: "projected"; readonly host: Buffer };

interface PlainSides {
	readonly rel: string;
	readonly target: string;
	readonly host: Buffer | undefined;
	readonly repo: Buffer | undefined;
	readonly recorded: PlainBase;
	readonly base: PlainBase;
	readonly accept: BaseChange;
}

function planPlainItem(ctx: PlanContext, rel: string, repo: Buffer | undefined, source: PlainSource = { kind: "host" }): Op[] {
	const target = targetOf(rel, ctx.opts.agentDir);
	if (lexists(target) && isAppManaged(target)) {
		ctx.report.skipped.push({ path: target, reason: "app-managed" });
		return [];
	}
	const recorded = ctx.base.plain(rel);
	const sides: PlainSides = {
		rel,
		target,
		repo,
		recorded,
		host: source.kind === "projected" ? source.host : existsSync(target) ? readFileSync(target) : undefined,
		base: recorded.kind === "none" && source.kind === "dropped" ? { kind: "known", content: source.content } : recorded,
		accept: repo === undefined ? { kind: "plain-drop", rel } : { kind: "plain-known", rel, content: repo },
	};
	return MACHINE_OWNED_PLAIN.test(rel) ? machineOwnedOps(sides) : managedOps(ctx, sides);
}

function machineOwnedOps({ rel, target, host, repo, recorded, base, accept }: PlainSides): Op[] {
	if (host === undefined)
		return repo !== undefined && recorded.kind === "none" ? [{ kind: "write", rel, target, content: repo, base: accept }] : [];
	if (repo !== undefined && host.equals(repo))
		return recorded.kind === "known" && recorded.content.equals(repo) ? [] : [{ kind: "base", rel, change: accept }];
	if (base.kind === "known" && host.equals(base.content))
		return repo === undefined
			? [{ kind: "delete", rel, target, base: accept }]
			: [{ kind: "write", rel, target, content: repo, base: accept }];
	return recorded.kind === "none" ? [{ kind: "base", rel, change: { kind: "plain-unknown", rel } }] : [];
}

function managedOps(ctx: PlanContext, { rel, target, host, repo, recorded, base, accept }: PlainSides): Op[] {
	const { report } = ctx;
	const code = rel.endsWith(".ts");
	const unmodified = (content: Buffer): boolean =>
		base.kind === "known" ? content.equals(base.content) : base.kind === "none" && ctx.history.hasVersion(rel, content);
	const conflict = (reason: ConflictReason): Op[] => {
		report.conflicts.push({ kind: "file", id: `${rel}@${repo === undefined ? "absent" : digest(repo)}`, rel, target, reason });
		if (recorded.kind !== "none") return [];
		const change: BaseChange = base.kind === "known" ? { kind: "plain-known", rel, content: base.content } : { kind: "plain-unknown", rel };
		return [{ kind: "base", rel, change }];
	};
	if (repo === undefined) {
		if (host === undefined) return [{ kind: "base", rel, change: accept }];
		const kept = unmodified(host);
		if (!kept && !code) return conflict(base.kind === "known" ? "dropped-upstream" : "unknown-base");
		if (!kept) report.overwritten.push(target);
		return [{ kind: "delete", rel, target, base: accept }];
	}
	if (host?.equals(repo)) return base.kind === "known" && base.content.equals(repo) ? [] : [{ kind: "base", rel, change: accept }];
	if (host === undefined) {
		if (base.kind === "none" || code) return [{ kind: "write", rel, target, content: repo, base: accept }];
		if (base.kind === "known" && base.content.equals(repo)) return [];
		return conflict(base.kind === "known" ? "deleted-locally" : "unknown-base");
	}
	const kept = unmodified(host);
	if (kept || code) {
		if (!kept) report.overwritten.push(target);
		return [{ kind: "write", rel, target, content: repo, base: accept }];
	}
	if (base.kind !== "known") return conflict("unknown-base");
	if (base.content.equals(repo)) return [];
	const merged = mergeText(host, base.content, repo);
	return merged.kind === "clean" ? [{ kind: "write", rel, target, content: merged.content, base: accept }] : conflict("both-changed");
}

function planPlain(ctx: PlanContext): Op[] {
	const { opts } = ctx;
	const shipped = listSourceFiles(opts.source).filter((rel) => !retired(ctx, agentPathOf(rel), false));
	const ops: Op[] = [];
	for (const rel of shipped) {
		if (skipExcluded(ctx, rel)) continue;
		const migration = ctx.replacementMigration;
		if (rel === REPLACEMENT_RULES_REL && migration.kind === "blocked") continue;
		const projected =
			rel === REPLACEMENT_RULES_REL && migration.kind === "ready" && migration.rules !== undefined
				? Buffer.from(migration.rules)
				: undefined;
		const planned = planPlainItem(
			ctx,
			rel,
			readFileSync(join(opts.source, rel)),
			projected === undefined ? { kind: "host" } : { kind: "projected", host: projected },
		);
		if (projected !== undefined && !planned.some((op) => op.kind === "write")) {
			const base = planned.find((op) => op.kind === "base");
			ops.push({ kind: "write", rel, target: targetOf(rel, opts.agentDir), content: projected, base: base?.change });
		} else ops.push(...planned);
	}
	if (ctx.replacementMigration.kind === "ready" && ctx.replacementMigration.rules !== undefined && !shipped.includes(REPLACEMENT_RULES_REL))
		ops.push({
			kind: "write",
			rel: REPLACEMENT_RULES_REL,
			target: targetOf(REPLACEMENT_RULES_REL, opts.agentDir),
			content: ctx.replacementMigration.rules,
		});
	const known = new Set(shipped);
	for (const rel of ctx.base.plainRels()) {
		if (known.has(rel)) continue;
		if (rel === REPLACEMENT_RULES_REL && ctx.replacementMigration.kind === "blocked") continue;
		known.add(rel);
		if (skipExcluded(ctx, rel)) continue;
		if (!managedPlain(rel) || retired(ctx, agentPathOf(rel), true)) ops.push({ kind: "base", rel, change: { kind: "plain-drop", rel } });
		else ops.push(...planPlainItem(ctx, rel, undefined));
	}
	for (const [rel, content] of droppedBeforeBase(ctx)) {
		if (known.has(rel)) continue;
		known.add(rel);
		if (skipExcluded(ctx, rel)) continue;
		ops.push(...planPlainItem(ctx, rel, undefined, { kind: "dropped", content }));
	}
	try {
		for (const entry of readdirSync(join(opts.agentDir, "agents"), { withFileTypes: true })) {
			const rel = `agent/agents/${entry.name}`;
			if (!entry.isFile() || known.has(rel) || entry.name.startsWith(".") || !MACHINE_OWNED_PLAIN.test(rel) || skipExcluded(ctx, rel))
				continue;
			const target = targetOf(rel, opts.agentDir);
			if (isAppManaged(target) || ctx.base.plain(rel).kind !== "none") continue;
			ops.push({ kind: "base", rel, change: { kind: "plain-unknown", rel } });
		}
	} catch {}
	ops.push(...planUnshippedExtensions(ctx, shipped, known, ops));
	return ops;
}

function planRemovedExtensionDir(
	ctx: PlanContext,
	dirRel: string,
	known: Set<string>,
	deletedRels: ReadonlySet<string>,
): { readonly ops: Op[]; readonly removable: boolean } {
	const { opts } = ctx;
	const target = targetOf(dirRel, opts.agentDir);
	let entries: Dirent[];
	try {
		entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return { ops: [], removable: false };
	}
	const ops: Op[] = [];
	let removable = true;
	for (const child of entries) {
		if (child.name.startsWith(".")) {
			removable = false;
			continue;
		}
		const childRel = `${dirRel}/${child.name}`;
		if (child.isDirectory()) {
			if (skipExcluded(ctx, childRel)) {
				removable = false;
				continue;
			}
			const sub = planRemovedExtensionDir(ctx, childRel, known, deletedRels);
			ops.push(...sub.ops);
			if (!sub.removable) removable = false;
			continue;
		}
		if (child.isSymbolicLink()) {
			removable = false;
			continue;
		}
		if (!child.isFile()) {
			removable = false;
			continue;
		}
		if (retired(ctx, agentPathOf(childRel), true)) {
			if (CTX_RETIREMENTS.includes(agentPathOf(childRel))) removable = false;
			continue;
		}
		if (known.has(childRel)) {
			if (!deletedRels.has(childRel)) removable = false;
			continue;
		}
		known.add(childRel);
		if (skipExcluded(ctx, childRel)) {
			removable = false;
			continue;
		}
		const planned = planPlainItem(ctx, childRel, undefined);
		ops.push(...planned);
		if (!planned.some((op) => op.kind === "delete")) removable = false;
	}
	if (removable) ops.push({ kind: "rmdir", rel: dirRel, target });
	return { ops, removable };
}

function planUnshippedExtensions(ctx: PlanContext, shipped: readonly string[], known: Set<string>, plannedOps: readonly Op[]): Op[] {
	const shippedDirs = new Set<string>();
	for (const rel of shipped) {
		if (!rel.startsWith("agent/extensions/")) continue;
		const name = rel.slice("agent/extensions/".length).split("/", 1)[0];
		if (name) shippedDirs.add(name);
	}
	if (shippedDirs.size === 0) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(join(ctx.opts.agentDir, "extensions"), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
	const deletedRels = new Set(plannedOps.filter((op) => op.kind === "delete").map((op) => op.rel));
	const ops: Op[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || shippedDirs.has(entry.name)) continue;
		const dirRel = `agent/extensions/${entry.name}`;
		if (skipExcluded(ctx, dirRel)) continue;
		ops.push(...planRemovedExtensionDir(ctx, dirRel, known, deletedRels).ops);
	}
	return ops;
}

type StructuredSource = { readonly item: StructuredItem; readonly text: string; readonly repo: Mapping };

function parseSources(opts: ApplyOptions, report: ApplyReport): StructuredSource[] {
	const sources: StructuredSource[] = [];
	for (const item of STRUCTURED) {
		const sourcePath = join(opts.source, item.rel);
		if (!existsSync(sourcePath)) {
			report.notes.push(`${item.rel}: not in source, host copy left alone`);
			continue;
		}
		const text = readFileSync(sourcePath, "utf8");
		try {
			sources.push({ item, text, repo: parseStructured(text, item.format) });
		} catch (error) {
			throw new Error(`${item.rel}: invalid ${item.format} (${errorText(error)}); nothing applied`);
		}
	}
	const lightPath = join(opts.source, "agent/config-light.yml");
	if (existsSync(lightPath)) {
		try {
			parseStructured(readFileSync(lightPath, "utf8"), "yaml");
		} catch (error) {
			throw new Error(`agent/config-light.yml: invalid yaml (${errorText(error)}); nothing applied`);
		}
	}
	return sources;
}

function planStructured(ctx: PlanContext, sources: readonly StructuredSource[]): Op[] {
	const { opts, report } = ctx;
	const ops: Op[] = [];
	for (const { item, text, repo } of sources) {
		if (skipExcluded(ctx, item.rel)) continue;
		const target = targetOf(item.rel, opts.agentDir);
		let host: Mapping | undefined;
		if (existsSync(target)) {
			if (isAppManaged(target)) {
				report.skipped.push({ path: target, reason: "app-managed" });
				continue;
			}
			try {
				host = parseStructured(readFileSync(target, "utf8"), item.format);
			} catch (error) {
				// Never replace an unparsable host copy: that drops the host's own values.
				report.errors.push(`${target}: host copy unparsable (${errorText(error)}); left untouched`);
				continue;
			}
		}
		const canMigrateXdevDocs =
			item.rel === CONFIG_REL &&
			!fieldExcluded(item.rel, ["tools", "xdevDocs"], ctx.exclusions) &&
			!fieldExcluded(item.rel, ["tools", "commandDocs"], ctx.exclusions);
		const migratedHost = host !== undefined && canMigrateXdevDocs ? migrateConfigMapping(host) : undefined;
		if (migratedHost?.migratedXdevDocs) {
			report.notes.push("config.yml: migrated tools.xdevDocs to tools.commandDocs");
		}
		const effectiveHost = migratedHost ? migratedHost.value : host;
		const recorded = ctx.base.structuredOf(item.rel);
		const effectiveRecorded = recorded !== undefined && canMigrateXdevDocs ? migrateConfigMapping(recorded.value).value : recorded?.value;
		const source: StructuredBaseSource =
			recorded !== undefined && effectiveRecorded !== undefined
				? { kind: "recorded", value: effectiveRecorded, unknown: recorded.unknown }
				: effectiveHost === undefined || ctx.freshMachine
					? { kind: "empty" }
					: { kind: "history", versions: ctx.history.structuredVersions(item.rel, item.format) };
		const fields = ctx.exclusions.fields.get(item.rel) ?? [];
		const rules =
			fields.length === 0 ? item.rules : { ...item.rules, local: [...item.rules.local, ...fields.map((field) => field.join("."))] };
		const merged = mergeStructured(effectiveHost, repo, source, rules);
		if (recorded !== undefined) {
			for (const field of fields) {
				setAt(merged.base, field, valueAt(recorded.value, field));
				for (const unknown of recorded.unknown)
					if (related(unknown, field) && !merged.unknown.some((path) => related(path, unknown))) merged.unknown.push(unknown);
			}
		}
		for (const { path, reason } of merged.conflicts) {
			const id = `${item.rel}#${pointer(path)}@${digest(canonical(valueAt(repo, path)))}`;
			report.conflicts.push({ kind: "key", id, rel: item.rel, target, path: [...path], reason });
		}
		const record: StructuredRecord = { value: merged.base, unknown: merged.unknown };
		const change: BaseChange | undefined =
			recorded !== undefined && Bun.deepEquals(recorded, record, true) ? undefined : { kind: "structured", rel: item.rel, record };
		for (const field of fields)
			if (
				valueAt(host, field) !== undefined ||
				valueAt(repo, field) !== undefined ||
				(recorded !== undefined && valueAt(recorded.value, field) !== undefined)
			)
				report.skipped.push({ path: `${target}:${field.join(".")}`, reason: EXCLUDED_REASON });
		if (host !== undefined && Bun.deepEquals(host, merged.host, true)) {
			if (change !== undefined) ops.push({ kind: "base", rel: item.rel, change });
			continue;
		}
		const content = Bun.deepEquals(merged.host, repo, true) ? text : serialize(merged.host, item.format);
		ops.push({ kind: "write", rel: item.rel, target, content, base: change });
	}
	return ops;
}

type RetirementInspection =
	| { readonly kind: "missing" }
	| { readonly kind: "candidate" }
	| { readonly kind: "blocked"; readonly message: string };

function inspectRetirement(agentDir: string, rel: string): RetirementInspection {
	const root = resolve(agentDir);
	const target = join(root, rel);
	try {
		const entry = lstatSync(target);
		if (!entry.isFile() && !entry.isSymbolicLink())
			return { kind: "blocked", message: `${target}: not a regular file or leaf symlink; left untouched` };
		for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
			if (lstatSync(parent).isSymbolicLink())
				return { kind: "blocked", message: `${target}: retirement traverses symlink parent ${parent}; backing object left untouched` };
		}
		if (isAppManaged(target, true))
			return { kind: "blocked", message: `${target}: app-managed retirement conflicts with plugin handover; left untouched` };
		return { kind: "candidate" };
	} catch (error) {
		if (errnoIs(error, "ENOENT", "ENOTDIR")) return { kind: "missing" };
		return { kind: "blocked", message: `${target}: cannot preflight retirement (${errorText(error)})` };
	}
}

function planRetirements(ctx: PlanContext, leaves: readonly string[]): Op[] {
	const { opts, report } = ctx;
	const ops: Op[] = [];
	for (const rel of leaves) {
		if (!lexists(join(opts.agentDir, rel)) || skipExcluded(ctx, `agent/${rel}`)) continue;
		const inspected = inspectRetirement(opts.agentDir, rel);
		switch (inspected.kind) {
			case "missing":
				break;
			case "candidate":
				ops.push({ kind: "delete", rel: `agent/${rel}`, target: join(opts.agentDir, rel) });
				break;
			case "blocked":
				report.errors.push(inspected.message);
				break;
			default: {
				const unreachable: never = inspected;
				throw new Error(String(unreachable));
			}
		}
	}
	return ops;
}

function planRetiredDirs(ctx: PlanContext, dirs: readonly string[], existing: readonly Op[]): Op[] {
	const { opts } = ctx;
	const plannedDirs = new Set(existing.filter((op) => op.kind === "rmdir").map((op) => op.target));
	const ops: Op[] = [];
	for (const dir of dirs) {
		const rel = `agent/${dir}`;
		const target = join(opts.agentDir, dir);
		if (plannedDirs.has(target) || !lexists(target) || skipExcluded(ctx, rel)) continue;
		try {
			if (!lstatSync(target).isDirectory()) continue;
		} catch {
			continue;
		}
		ops.push({ kind: "rmdir", rel, target });
	}
	return ops;
}

function droppedBeforeBase(ctx: PlanContext): Map<string, Buffer> {
	const { opts, report } = ctx;
	const dropped = new Map<string, Buffer>();
	if (opts.previousCommit === undefined) return dropped;
	const diff = git(opts.source, [
		"diff",
		"-z",
		"--no-renames",
		"--name-only",
		"--diff-filter=D",
		opts.previousCommit,
		"HEAD",
		"--",
		"agent",
		ROOT_CHANGELOG_REL,
	]);
	if (!diff.ok) {
		report.notes.push(`deletions before the base skipped: ${diff.err}`);
		return dropped;
	}
	for (const rel of diff.out.split("\0").filter(Boolean)) {
		if (!managedPlain(rel) || retired(ctx, agentPathOf(rel), true)) continue;
		const content = ctx.history.show(opts.previousCommit, rel);
		if (content !== undefined) dropped.set(rel, content);
	}
	return dropped;
}

interface ApplyState extends PlanContext {
	readonly settings: SettingsPreflight;
	readonly ctxRetirements: readonly Op[];
	readonly ops: readonly Op[];
}

type GateOutcome = { readonly kind: "stop" } | { readonly kind: "continue"; readonly ctxRetiring: boolean };

const OP_RANK: Record<Op["kind"], number> = { move: 0, split: 0, "migrate-replacements": 0, write: 1, delete: 2, rmdir: 3, base: 4 };

const byRank = (a: Op, b: Op): number => OP_RANK[a.kind] - OP_RANK[b.kind];

const CUTOVER_NOTE = "Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.";

function planContext(opts: ApplyOptions, report: ApplyReport, base: BaseRecord, history: RepoHistory, exclusions: Exclusions): PlanContext {
	const declared = declaredPlugins(opts.source).required;
	return {
		opts,
		report,
		base,
		history,
		todoRequired: declared.some(TODO_PLUGIN.requiredBy),
		forkRequired: declared.some(FORK_PLUGIN.requiredBy),
		freshMachine: freshMachine(opts.agentDir, base),
		replacementMigration: planReplacementMigration(opts, report, base, history, exclusions),
		exclusions,
	};
}

function planApply(opts: ApplyOptions, report: ApplyReport): ApplyState | null {
	try {
		const base = BaseRecord.load(opts.agentDir);
		const history = new RepoHistory(opts.source, !opts.check);
		const settings = settingsPreflight(opts, base, history);
		const exclusions = exclusionsOf(settings, opts.agentDir, FIELD_EXCLUDE_FILES);
		const sources = parseSources(opts, report);
		const ctx = planContext(opts, report, base, history, exclusions);
		const basePlanned = [
			...planRelocations(ctx, SUPERSEDED, DATA_MOVES),
			...planPlain(ctx),
			...planStructured(ctx, sources),
			...(ctx.todoRequired ? planRetirements(ctx, TODO_RETIREMENTS) : []),
			...(ctx.forkRequired ? planRetirements(ctx, FORK_RETIREMENTS) : []),
			...planRetirements(ctx, LEGACY_RETIREMENTS),
		];
		const planned = [...basePlanned, ...planRetiredDirs(ctx, LEGACY_RETIRED_DIRS, basePlanned)];
		const ctxRetirements = ctx.todoRequired ? planRetirements(ctx, CTX_RETIREMENTS) : [];
		report.notes.push(...history.notes);
		if (opts.check || !opts.plugins) report.notes.push(...reportPendingSettings(opts, settings));
		const ops = groupReplacementMigration(opts, ctx.replacementMigration, planned).toSorted(byRank);
		assertNoExcludedOps(ctx, ops);
		return { ...ctx, settings, ctxRetirements, ops };
	} catch (error) {
		report.errors.push(errorText(error));
		return null;
	}
}

function applyPluginGates(state: ApplyState): GateOutcome {
	const { opts, report } = state;
	const required = [...(state.todoRequired ? [TODO_PLUGIN] : []), ...(state.forkRequired ? [FORK_PLUGIN] : [])];
	const before = required.length > 0 ? pluginCatalog() : undefined;
	const earlier = new Map(required.map((plugin) => [plugin, before === undefined ? undefined : pluginReadiness(before, plugin)]));
	for (const readiness of earlier.values()) if (readiness?.kind === "invalid") report.errors.push(readiness.message);
	if (report.errors.length > 0 && !opts.check) return { kind: "stop" };
	syncPlugins(opts, report, declaredPlugins(opts.source));
	if (!opts.check && report.errors.length > 0) {
		if (report.restartNeeded) report.notes.push(CUTOVER_NOTE);
		return { kind: "stop" };
	}
	if (before === undefined) return { kind: "continue", ctxRetiring: false };
	const after = opts.check ? before : pluginCatalog();
	let ctxRetiring = false;
	for (const plugin of required) {
		const ready = pluginReadiness(after, plugin);
		switch (ready.kind) {
			case "ready":
				report.notes.push(`${plugin.label} prerequisite confirmed by OMP owner catalog.`);
				if (plugin === TODO_PLUGIN) ctxRetiring = existsSync(join(ready.path, "src", "ctx", "index.ts"));
				break;
			case "missing":
				report.errors.push(
					`Required plugin ${plugin.name} is missing; no managed files switched${opts.check ? " (check never installs)" : ""}.`,
				);
				break;
			case "invalid": {
				const previous = earlier.get(plugin);
				if (previous?.kind !== "invalid" || previous.message !== ready.message) report.errors.push(ready.message);
				break;
			}
			default: {
				const unreachable: never = ready;
				throw new Error(String(unreachable));
			}
		}
	}
	if (!opts.check && report.errors.length > 0) {
		if (report.restartNeeded) report.notes.push(CUTOVER_NOTE);
		return { kind: "stop" };
	}
	return { kind: "continue", ctxRetiring };
}

function runApplyOps(state: ApplyState, ctxRetiring: boolean): BaseChange[] {
	const { opts, report } = state;
	const ops = ctxRetiring ? [...state.ops, ...state.ctxRetirements].toSorted(byRank) : state.ops;
	const accepted: BaseChange[] = [];
	for (const op of ops) {
		if (!opts.check && (op.kind === "delete" || op.kind === "rmdir") && report.errors.length > 0) break;
		if (op.kind === "base") {
			accepted.push(op.change);
			continue;
		}
		const leaf = agentPathOf(op.rel);
		const retirement = op.kind === "delete" && retired(state, leaf, ctxRetiring);
		try {
			applyOp(state, op, leaf, retirement, accepted);
		} catch (error) {
			report.errors.push(`${op.target}: ${errorText(error)}`);
			if (retirement) break;
		}
	}
	return accepted;
}

function applyOp(state: ApplyState, op: Exclude<Op, { kind: "base" }>, leaf: string, retirement: boolean, accepted: BaseChange[]): void {
	const { opts, report } = state;
	if (!opts.check && retirement) {
		const current = inspectRetirement(opts.agentDir, leaf);
		if (current.kind === "missing") return;
		if (current.kind === "blocked") throw new Error(current.message);
	}
	switch (op.kind) {
		case "migrate-replacements":
			for (const write of op.writes) {
				if (!opts.check) atomicWrite(write.target, write.content);
				report.written.push(write.target);
			}
			for (const target of op.deletes) {
				if (!opts.check) unlinkSync(target);
				report.deleted.push(target);
			}
			for (const write of op.writes) if (write.base !== undefined) accepted.push(write.base);
			accepted.push(...op.changes);
			break;
		case "move":
			if (!opts.check) {
				mkdirSync(dirname(op.target), { recursive: true });
				renameSync(op.from, op.target);
			}
			report.moved.push({ from: op.from, to: op.target });
			break;
		case "split":
			if (!opts.check) {
				for (const fragment of op.fragments) atomicWrite(fragment.target, fragment.content);
				unlinkSync(op.target);
			}
			for (const fragment of op.fragments) report.moved.push({ from: op.target, to: fragment.target });
			if (op.fragments.length === 0) report.deleted.push(op.target);
			break;
		case "write":
			if (!opts.check) atomicWrite(op.target, op.content);
			report.written.push(op.target);
			if (op.base !== undefined) accepted.push(op.base);
			break;
		case "delete":
			if (!opts.check) unlinkSync(op.target);
			report.deleted.push(op.target);
			if (op.base !== undefined) accepted.push(op.base);
			break;
		case "rmdir":
			if (!opts.check) {
				if (!lexists(op.target) || !lstatSync(op.target).isDirectory() || readdirSync(op.target).length > 0) return;
				rmdirSync(op.target);
			}
			report.deleted.push(op.target);
			break;
		default: {
			const unreachable: never = op;
			throw new Error(`unknown op ${JSON.stringify(unreachable)}`);
		}
	}
	if (!opts.check && RESTART_SCOPED.test(op.rel) && op.rel !== `agent/${UPDATER_REL}`) report.restartNeeded = true;
}

function settleApply(state: ApplyState, accepted: readonly BaseChange[]): void {
	const { opts, report } = state;
	if (!opts.check) {
		try {
			state.base.commit(accepted);
		} catch (error) {
			report.errors.push(`${join(opts.agentDir, BASE_DIR)}: ${errorText(error)}`);
		}
		if (report.errors.length === 0) {
			try {
				settleSettings(opts, report, state.settings, state.exclusions, state.base, state.history);
			} catch (error) {
				report.errors.push(`settings: ${errorText(error)}`);
			}
		}
	}
	installLauncher(opts, report);
	if (report.errors.length > 0 && !opts.check && (state.todoRequired || state.forkRequired || report.restartNeeded))
		report.notes.push(CUTOVER_NOTE);
}

export async function applySnapshot(opts: ApplyOptions): Promise<ApplyReport> {
	const report = newReport();
	const state = planApply(opts, report);
	if (state === null) return report;
	if (report.errors.length > 0 && !opts.check) return report;
	const gate = applyPluginGates(state);
	if (gate.kind === "stop") return report;
	settleApply(state, runApplyOps(state, gate.ctxRetiring));
	return report;
}

export function scanConflicts(source: string, agentDir: string): ConflictScan {
	const opts: ApplyOptions = { source, agentDir, previousCommit: undefined, check: true, plugins: false };
	const report = newReport();
	try {
		const base = BaseRecord.load(agentDir);
		const history = new RepoHistory(source, false);
		const exclusions = exclusionsOf(settingsPreflight({ ...opts, plugins: true }, base, history), agentDir, FIELD_EXCLUDE_FILES);
		const sources = parseSources(opts, report);
		const ctx = planContext(opts, report, base, history, exclusions);
		planPlain(ctx);
		planStructured(ctx, sources);
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	}
	if (report.errors.length > 0) return { kind: "failed", error: report.errors.join("; ") };
	return { kind: "scanned", conflicts: report.conflicts };
}

const LOCK_DIR = join(homedir(), ".omp", "omp-config-update.lock");
const LOCK_OWNER = join(LOCK_DIR, "pid");
const LOCK_ORPHAN_MS = 60 * 1000;

function lockHolderAlive(): boolean {
	let pid: number;
	try {
		pid = Number(readFileSync(LOCK_OWNER, "utf8"));
	} catch {
		return Date.now() - statSync(LOCK_DIR).mtimeMs < LOCK_ORPHAN_MS;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoIs(error, "EPERM");
	}
}

function acquireLock(): boolean {
	mkdirSync(dirname(LOCK_DIR), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(LOCK_DIR);
			writeFileSync(LOCK_OWNER, String(process.pid));
			return true;
		} catch {
			try {
				if (lockHolderAlive()) return false;
				rmSync(LOCK_DIR, { recursive: true, force: true });
			} catch {}
		}
	}
	return false;
}

function releaseLock(): void {
	try {
		if (Number(readFileSync(LOCK_OWNER, "utf8")) !== process.pid) return;
	} catch {
		return;
	}
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

const CLONE_DIR = join(homedir(), ".omp", "omp-config-src");

function refreshClone(branch: string): string | undefined {
	if (!existsSync(CLONE_DIR)) {
		const tmp = `${CLONE_DIR}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		const cloned = spawnSync("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, REPO_URL, tmp], { encoding: "utf8" });
		if (cloned.status !== 0) {
			rmSync(tmp, { recursive: true, force: true });
			return `git clone failed: ${(cloned.stderr || cloned.error?.message || "").trim()}`;
		}
		renameSync(tmp, CLONE_DIR);
		return undefined;
	}
	const origin = git(CLONE_DIR, ["remote", "get-url", "origin"]);
	const originUrl = origin.ok ? origin.out.trim() : "";
	if (PREVIOUS_REPO_URLS.includes(originUrl)) {
		const repointed = git(CLONE_DIR, ["remote", "set-url", "origin", REPO_URL]);
		if (!repointed.ok) throw new Error(`git remote set-url failed: ${repointed.err}`);
	} else if (originUrl !== REPO_URL) {
		throw new Error(`${CLONE_DIR} is not an updater clone of ${REPO_URL}; left untouched`);
	}
	const fetched = git(CLONE_DIR, ["fetch", "--quiet", "--depth", "1", "origin", branch]);
	if (!fetched.ok) return fetched.err;
	const reset = git(CLONE_DIR, ["reset", "--quiet", "--hard", "FETCH_HEAD"]);
	if (!reset.ok) throw new Error(`git reset failed: ${reset.err}`);
	return undefined;
}

export async function runAuto(agentDir: string, branch: string): Promise<AutoResult> {
	if (!acquireLock()) return { kind: "busy" };
	try {
		const fetchError = refreshClone(branch);
		if (fetchError !== undefined) return { kind: "offline", error: fetchError };
		const head = git(CLONE_DIR, ["rev-parse", "HEAD"]);
		if (!head.ok) return { kind: "failed", error: head.err };
		const commit = head.out.trim();
		const markerPath = join(agentDir, APPLIED_MARKER);
		const applied = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
		if (applied === commit)
			return { kind: "up-to-date", commit, plugins: refreshMovingPlugins(CLONE_DIR), scan: scanConflicts(CLONE_DIR, agentDir) };
		const previousCommit = applied && git(CLONE_DIR, ["cat-file", "-e", `${applied}^{commit}`]).ok ? applied : undefined;
		const fetchedUpdater = join(CLONE_DIR, "agent", UPDATER_REL);
		if (!existsSync(fetchedUpdater))
			return { kind: "failed", error: `${branch} at ${commit.slice(0, 7)} has no agent/${UPDATER_REL}; nothing applied` };
		const fetched: { applySnapshot?: typeof applySnapshot } = await import(pathToFileURL(fetchedUpdater).href);
		if (typeof fetched.applySnapshot !== "function")
			return { kind: "failed", error: "fetched omp-config-update.ts exports no applySnapshot" };
		const report = await fetched.applySnapshot({ source: CLONE_DIR, agentDir, previousCommit, check: false, plugins: true });
		if (applied && previousCommit === undefined)
			report.notes.push(`previous commit ${applied} unavailable: files dropped before this machine recorded a base stay`);
		if (report.errors.length === 0) atomicWrite(markerPath, `${commit}\n`);
		return { kind: "applied", commit, previous: applied || undefined, report };
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	} finally {
		releaseLock();
	}
}

function pluginChangeLine(change: PluginChange): string {
	return change.from === null
		? `plugin installed: ${change.name} ${change.to ?? "?"}`
		: `plugin upgraded: ${change.name} ${change.from} -> ${change.to ?? "?"}`;
}

function formatReport(report: ApplyReport, check: boolean): string {
	const lines: string[] = [];
	const verb = check ? "would write" : "wrote";
	for (const path of report.written) lines.push(`${verb}: ${path}`);
	for (const { from, to } of report.moved) lines.push(`${check ? "would move" : "moved"}: ${from} -> ${to}`);
	for (const path of report.deleted) lines.push(`${check ? "would delete" : "deleted"}: ${path}`);
	for (const { path, reason } of report.skipped) lines.push(`skipped (${reason}): ${path}`);
	for (const path of report.overwritten) lines.push(`${check ? "would overwrite" : "overwrote"} customized code: ${path}`);
	for (const conflict of report.conflicts) lines.push(`conflict (${conflict.reason}), local copy kept: ${conflict.id}`);
	for (const change of report.pluginChanges) lines.push(pluginChangeLine(change));
	for (const spec of report.pluginsMissing) lines.push(`plugin missing: ${spec}`);
	for (const note of report.notes) lines.push(`note: ${note}`);
	for (const error of report.errors) lines.push(`error: ${error}`);
	if (report.written.length + report.moved.length + report.deleted.length === 0) lines.push("no file changes");
	if (report.conflicts.length > 0) lines.push("adapt the conflicts: omp-config-update.ts conflicts --source <same source>");
	if (report.restartNeeded && report.errors.length === 0) lines.push("restart OMP: system prompt, extensions or plugins changed");
	return lines.join("\n");
}

function usage(): never {
	process.stderr.write(
		[
			"usage:",
			"  omp-config-update.ts auto [--agent-dir DIR] [--branch NAME] [--json]",
			"  omp-config-update.ts apply --source DIR [--agent-dir DIR] [--check] [--no-plugins] [--json]",
			"  omp-config-update.ts conflicts [--source DIR] [--agent-dir DIR] [--json]",
			"  omp-config-update.ts resolve [--source DIR] [--agent-dir DIR] ID...",
			"(conflicts and resolve default --source to the updater clone)",
			"",
		].join("\n"),
	);
	process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
	const [mode, ...rest] = argv;
	let agentDir = resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent"));
	let branch = DEFAULT_BRANCH;
	let source: string | undefined;
	let check = false;
	let plugins = true;
	let json = false;
	const ids: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		const value = (): string => rest[++i] ?? usage();
		if (arg === "--agent-dir") agentDir = resolve(value());
		else if (arg === "--branch") branch = value();
		else if (arg === "--source") source = resolve(value());
		else if (arg === "--check") check = true;
		else if (arg === "--no-plugins") plugins = false;
		else if (arg === "--json") json = true;
		else if (mode === "resolve" && arg !== undefined && !arg.startsWith("--")) ids.push(arg);
		else usage();
	}
	if (mode === "auto") {
		const result = await runAuto(agentDir, branch);
		if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else if (result.kind === "applied") process.stdout.write(`applied ${result.commit}\n${formatReport(result.report, false)}\n`);
		else if (result.kind === "up-to-date") {
			const { plugins, scan } = result;
			const lines = [
				`up-to-date ${result.commit}`,
				...plugins.changes.map(pluginChangeLine),
				...plugins.notes.map((note) => `note: ${note}`),
				...plugins.errors.map((error) => `error: ${error}`),
				...(scan.kind === "scanned"
					? scan.conflicts.map((conflict) => `conflict (${conflict.reason}), local copy kept: ${conflict.id}`)
					: [`error: conflict scan failed: ${scan.error}`]),
			];
			if (plugins.installed.length + plugins.upgraded.length > 0 && plugins.errors.length === 0) lines.push("restart OMP: plugins changed");
			process.stdout.write(`${lines.join("\n")}\n`);
		} else
			process.stdout.write(
				`${result.kind}${"commit" in result ? ` ${result.commit}` : ""}${"error" in result ? `: ${result.error}` : ""}\n`,
			);
		return result.kind === "failed" ||
			(result.kind === "applied" && result.report.errors.length > 0) ||
			(result.kind === "up-to-date" && result.plugins.errors.length > 0)
			? 1
			: 0;
	}
	if (mode === "apply") {
		if (source === undefined) usage();
		if (!check && !acquireLock()) {
			process.stderr.write(`another update holds ${LOCK_DIR}; retry later\n`);
			return 1;
		}
		try {
			const report = await applySnapshot({ source, agentDir, previousCommit: undefined, check, plugins });
			process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${formatReport(report, check)}\n`);
			return report.errors.length > 0 ? 1 : 0;
		} finally {
			releaseLock();
		}
	}
	if (mode === "conflicts") {
		const from = source ?? CLONE_DIR;
		const scan = scanConflicts(from, agentDir);
		if (json) process.stdout.write(`${JSON.stringify(scan)}\n`);
		else
			process.stdout.write(
				`${scan.kind === "scanned" ? conflictsText(scan.conflicts, from, agentDir, import.meta.path, formatOf) : `error: ${scan.error}`}\n`,
			);
		return scan.kind === "scanned" ? 0 : 1;
	}
	if (mode === "resolve") {
		if (ids.length === 0) usage();
		if (!acquireLock()) {
			process.stderr.write(`another update holds ${LOCK_DIR}; retry later\n`);
			return 1;
		}
		try {
			const from = source ?? CLONE_DIR;
			const outcome = resolveConflicts(scanConflicts(from, agentDir), from, agentDir, ids, formatOf);
			const lines = [
				...outcome.resolved.map((id) => `resolved: ${id}`),
				...outcome.stale.map((id) => `stale (upstream changed since it was listed; list the conflicts again): ${id}`),
				...outcome.unknown.map((id) => `not a current conflict (already resolved or a wrong id): ${id}`),
				...outcome.errors.map((error) => `error: ${error}`),
			];
			process.stdout.write(`${lines.join("\n")}\n`);
			return outcome.stale.length + outcome.unknown.length + outcome.errors.length > 0 ? 1 : 0;
		} catch (error) {
			process.stdout.write(`error: ${errorText(error)}\n`);
			return 1;
		} finally {
			releaseLock();
		}
	}
	usage();
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
