#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_DIR, type BaseChange, BaseRecord, RepoHistory, type StructuredRecord } from "./base.ts";
import { parseLegacyModelFragments } from "./legacy-model-fragments.ts";
import { convertLegacySystemReplacements } from "./legacy-system-replacements.ts";
import {
	type ConflictReason,
	canonical,
	isMapping,
	type Mapping,
	mergeStructured,
	type Path,
	type PathRules,
	pointer,
	related,
	type StructuredBaseSource,
	setAt,
	valueAt,
} from "./merge.ts";
import {
	holdsOwnedSection,
	linkPlugin,
	type Manifest,
	OMOMP_FILES,
	type OmompPlan,
	PLUGIN_DIR,
	PLUGIN_NAME,
	type PluginState,
	parseManifest,
	planOmompMigration,
	pluginState as queryPluginState,
	REPLACEMENT_SECTION,
	type RoleBinding,
	removeYamlSections,
	type SectionMove,
	setPluginSetting,
	splitCheckEdit,
	withoutSections,
} from "./omomp-migration.ts";

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

const TODO_PLUGIN_URL = "https://github.com/oh-my-omp/omp-todo-more#release";
const TODO_PLUGIN_NAME = "omp-todo-more";
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

const FORK_PLUGIN_URL = "https://github.com/oh-my-omp/omp-subagent-more";
const FORK_PLUGIN_NAME = "omp-subagent-more";
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

function requiresForkPlugin(spec: string): boolean {
	return spec.split("#", 1)[0] === FORK_PLUGIN_URL;
}

const SUPERSEDED: readonly { readonly from: string; readonly by: string }[] = [
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

type DataMove =
	| { readonly kind: "split-model"; readonly owner: "host"; readonly from: readonly string[]; readonly toDir: string }
	| { readonly kind: "pattern"; readonly owner: "host" | "template"; readonly pattern: RegExp; readonly toDir: string };

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

type Format = "json" | "yaml";

interface StructuredItem {
	readonly rel: string;
	readonly format: Format;
	readonly rules: PathRules;
}

const OMOMP_REL = "agent/omomp.yml";

const STRUCTURED: readonly StructuredItem[] = [
	{
		rel: "agent/config.yml",
		format: "yaml",
		rules: { local: LOCAL_CONFIG_FIELDS, seed: SEED_CONFIG_FIELDS, machineLists: MACHINE_LIST_FIELDS, retired: RETIRED_LIST_ENTRIES },
	},
];

const MACHINE_OWNED_PLAIN = /^agent\/agents\/[^/]+\.md$/;

const ROOT_CHANGELOG_REL = "CHANGELOG.md";

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

function coversPath(field: Path, path: Path): boolean {
	return field.length <= path.length && field.every((part, index) => part === path[index]);
}

type ExcludeEntry =
	| { readonly kind: "plain"; readonly match: (leaf: string) => boolean }
	| { readonly kind: "field"; readonly item: string; readonly path: Path };

interface Exclusions {
	readonly entries: readonly ExcludeEntry[];
	readonly fields: ReadonlyMap<string, readonly Path[]>;
}

const GLOB_MAGIC = /[*?[\]{}!\\]/;

function parseExclusions(raw: readonly string[], origin: string): Exclusions {
	const normalize = (entry: string): string => {
		const trimmed = entry.trim();
		const parts = (trimmed.startsWith("agent/") ? trimmed.slice("agent/".length) : trimmed).split("/");
		if (isAbsolute(trimmed) || parts.some((part) => part === "" || part === "." || part === ".."))
			throw new Error(`${origin}: invalid exclude entry ${JSON.stringify(entry)}: expected an agent-dir relative path or glob`);
		return parts.join("/");
	};
	const entries: ExcludeEntry[] = [];
	const fields = new Map<string, Path[]>();
	for (const entry of raw) {
		const colon = entry.indexOf(":");
		if (colon >= 0) {
			const item = `agent/${normalize(entry.slice(0, colon))}`;
			const field = entry.slice(colon + 1);
			const segments = field.split(".");
			if (
				(item !== OMOMP_REL && !STRUCTURED.some((structured) => structured.rel === item)) ||
				field === "" ||
				segments.some((segment) => segment === "")
			)
				throw new Error(
					`${origin}: invalid exclude entry ${JSON.stringify(entry)}: use <structured file>:<dotted field path>, the file being config.yml or omomp.yml`,
				);
			entries.push({ kind: "field", item, path: segments });
			(fields.get(item) ?? fields.set(item, []).get(item)!).push(segments);
			continue;
		}
		const pattern = normalize(entry);
		const match = GLOB_MAGIC.test(pattern)
			? (leaf: string): boolean => new Bun.Glob(pattern).match(leaf)
			: (leaf: string): boolean => leaf === pattern || leaf.startsWith(`${pattern}/`);
		entries.push({ kind: "plain", match });
	}
	return { entries, fields };
}

function plainRelExcluded(rel: string, exclusions: Exclusions): boolean {
	const leaf = agentPathOf(rel);
	return exclusions.entries.some((entry) => entry.kind === "plain" && entry.match(leaf));
}

function fieldExcluded(item: string, path: Path, exclusions: Exclusions): boolean {
	return (exclusions.fields.get(item) ?? []).some((field) => coversPath(field, path));
}

function skipExcluded(ctx: PlanContext, rel: string): boolean {
	if (!plainRelExcluded(rel, ctx.exclusions)) return false;
	ctx.report.skipped.push({ path: targetOf(rel, ctx.opts.agentDir), reason: EXCLUDED_REASON });
	return true;
}

const EXCLUDED_REASON = "excluded by the machine (omp-config-autoupdate.exclude)";

/**
 * A violation is a planner bug, so this throws and aborts the
 * apply rather than filtering: filtering a `move` after its write side dropped
 * would still delete the source.
 */
function assertNoExcludedOps(ctx: PlanContext, ops: readonly Op[]): void {
	const root = resolve(ctx.opts.agentDir);
	const relOf = (target: string): string | undefined =>
		target.startsWith(`${root}/`) ? `agent/${target.slice(root.length + 1)}` : undefined;
	for (const op of ops) {
		const touched = [op.rel];
		if (op.kind === "move") touched.push(relOf(op.from) ?? "", relOf(op.target) ?? "");
		if (op.kind === "split") touched.push(...op.fragments.map((fragment) => relOf(fragment.target) ?? ""));
		if (op.kind === "migrate-replacements")
			touched.push(...op.writes.map((write) => write.rel), ...op.deletes.map((target) => relOf(target) ?? ""));
		for (const rel of touched)
			if (rel !== "" && plainRelExcluded(rel, ctx.exclusions))
				throw new Error(`planned operation touches excluded item ${rel}; nothing applied`);
	}
}

export interface ApplyOptions {
	readonly source: string;
	readonly agentDir: string;
	readonly previousCommit: string | undefined;
	readonly check: boolean;
	readonly plugins: boolean;
}

export type Conflict =
	| { readonly kind: "file"; readonly id: string; readonly rel: string; readonly target: string; readonly reason: ConflictReason }
	| {
			readonly kind: "key";
			readonly id: string;
			readonly rel: string;
			readonly target: string;
			readonly path: string[];
			readonly reason: ConflictReason;
	  };

export interface ApplyReport {
	readonly written: string[];
	readonly moved: { from: string; to: string }[];
	readonly deleted: string[];
	readonly skipped: { path: string; reason: string }[];
	readonly errors: string[];
	readonly notes: string[];
	readonly pluginsInstalled: string[];
	readonly pluginsUpgraded: string[];
	readonly pluginsMissing: string[];
	readonly pluginChanges: PluginChange[];
	readonly conflicts: Conflict[];
	readonly overwritten: string[];
	restartNeeded: boolean;
}

export interface PluginChange {
	readonly spec: string;
	readonly name: string;
	readonly from: string | null;
	readonly to: string | null;
}

export interface PluginRefresh {
	readonly installed: string[];
	readonly upgraded: string[];
	readonly errors: string[];
	readonly changes: PluginChange[];
	readonly notes: string[];
}

export type ConflictScan =
	| { readonly kind: "scanned"; readonly conflicts: Conflict[] }
	| { readonly kind: "failed"; readonly error: string };

export type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string; readonly plugins: PluginRefresh; readonly scan: ConflictScan }
	| { readonly kind: "applied"; readonly commit: string; readonly previous: string | undefined; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: readonly string[]): { ok: true; out: string } | { ok: false; err: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.error) return { ok: false, err: result.error.message };
	if (result.status !== 0) return { ok: false, err: (result.stderr || result.stdout).trim() || `git ${args[0]} exited ${result.status}` };
	return { ok: true, out: result.stdout };
}

function parseStructured(text: string, format: Format): Mapping {
	const value: unknown = format === "json" ? JSON.parse(text) : Bun.YAML.parse(text);
	if (!isMapping(value)) throw new Error("root is not a mapping");
	return value;
}

function serialize(value: Mapping, format: Format): string {
	const text = format === "json" ? `${JSON.stringify(value, null, 2)}\n` : Bun.YAML.stringify(value, null, 2).replace(/:[ ]+$/gm, ":");
	const back = parseStructured(text, format);
	if (!Bun.deepEquals(back, value)) throw new Error("serialized form does not round-trip");
	return text.endsWith("\n") ? text : `${text}\n`;
}

function agentPathOf(rel: string): string {
	if (rel === ROOT_CHANGELOG_REL) return `${PLUGIN_DIR}/CHANGELOG.md`;
	if (rel.startsWith("agent/")) return rel.slice("agent/".length);
	throw new Error(`no target for ${rel}`);
}

function targetOf(rel: string, agentDir: string): string {
	return join(agentDir, agentPathOf(rel));
}

const OTTY_MARKER = ["marker:", "_otty"].join(" ");

function isAppManaged(path: string, strict = false): boolean {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (strict && !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		return false;
	}
	return text.split("\n", 1)[0]?.trim() === "// @orca-managed-pi-extension" || text.includes(OTTY_MARKER);
}

function writePath(target: string): string {
	let link = false;
	try {
		link = lstatSync(target).isSymbolicLink();
	} catch {}
	if (!link) return target;
	try {
		return realpathSync(target);
	} catch {
		return resolve(dirname(target), readlinkSync(target));
	}
}

function atomicWrite(target: string, content: string | Uint8Array, mode?: number): void {
	const path = writePath(target);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.omp-config-update-${process.pid}.tmp`);
	try {
		writeFileSync(tmp, content);
		const keepMode = mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : undefined);
		if (keepMode !== undefined) chmodSync(tmp, keepMode);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

type Op =
	| {
			readonly kind: "write";
			readonly rel: string;
			readonly target: string;
			readonly content: string | Uint8Array;
			readonly base?: BaseChange;
	  }
	| { readonly kind: "move"; readonly rel: string; readonly from: string; readonly target: string }
	| {
			readonly kind: "split";
			readonly rel: string;
			readonly target: string;
			readonly fragments: readonly { readonly target: string; readonly content: string }[];
	  }
	| { readonly kind: "delete"; readonly rel: string; readonly target: string; readonly base?: BaseChange }
	| {
			readonly kind: "migrate-replacements";
			readonly rel: string;
			readonly target: string;
			readonly writes: readonly Extract<Op, { kind: "write" }>[];
			readonly deletes: readonly string[];
			readonly changes: readonly BaseChange[];
	  }
	| { readonly kind: "base"; readonly rel: string; readonly change: BaseChange };

interface PlanContext {
	readonly opts: ApplyOptions;
	readonly report: ApplyReport;
	readonly base: BaseRecord;
	readonly history: RepoHistory;
	readonly todoRequired: boolean;
	readonly forkRequired: boolean;
	readonly freshMachine: boolean;
	readonly replacementMigration: ReplacementMigration;
	readonly exclusions: Exclusions;
}

const REPLACEMENT_RULES_REL = "agent/extensions-last/system-prompt-replace/REPLACE-SYSTEM-default.yml";
const LEGACY_REPLACEMENT_RELS = [
	"agent/extensions-last/system-prompt-replace/system-prompt-replace.json",
	"agent/system-prompt-replace.json",
] as const;

type ReplacementMigration =
	| { readonly kind: "none" }
	| { readonly kind: "blocked" }
	| {
			readonly kind: "ready";
			readonly rules: string | undefined;
			readonly omomp: string | undefined;
			readonly legacy: readonly string[];
			readonly omompBase: BaseChange | undefined;
	  };

function unmodifiedReplacementSection(
	base: BaseRecord,
	history: RepoHistory,
	item: Pick<StructuredItem, "rel" | "format">,
	path: Path,
	value: unknown,
): boolean {
	const recorded = base.structuredOf(item.rel);
	if (recorded !== undefined)
		return !recorded.unknown.some((unknown) => related(unknown, path)) && Bun.deepEquals(value, valueAt(recorded.value, path), true);
	return structuredHistory(history, item).some((version) => Bun.deepEquals(value, valueAt(version, path), true));
}

function planReplacementMigration(
	opts: ApplyOptions,
	report: ApplyReport,
	base: BaseRecord,
	history: RepoHistory,
	exclusions: Exclusions,
): ReplacementMigration {
	const files = OMOMP_FILES.filter((rel) => lexists(join(opts.agentDir, rel)));
	const legacy = LEGACY_REPLACEMENT_RELS.filter((rel) => lexists(targetOf(rel, opts.agentDir)));
	const blocked = (reason: string): ReplacementMigration => {
		report.notes.push(`system-prompt-replace migration left in place: ${reason}; move the section to REPLACE-SYSTEM-*.yml by hand`);
		return { kind: "blocked" };
	};
	let root: Mapping | undefined;
	let text: string | undefined;
	let containsSection = false;
	for (const rel of files) {
		try {
			const content = readFileSync(join(opts.agentDir, rel), "utf8");
			const parsed: unknown = rel.endsWith(".json")
				? JSON.parse(content)
				: rel.endsWith(".toml")
					? Bun.TOML.parse(content)
					: Bun.YAML.parse(content);
			if (!isMapping(parsed)) throw new Error("root is not a mapping");
			containsSection ||= Object.hasOwn(parsed, "system-prompt-replace");
			if (rel === "omomp.yml") {
				text = content;
				root = parsed;
			}
		} catch (error) {
			return blocked(`${join(opts.agentDir, rel)}: ${errorText(error)}`);
		}
	}
	if (containsSection && (files.length > 1 || files[0] !== "omomp.yml"))
		return blocked(`unsupported or ambiguous omomp files: ${files.map((rel) => join(opts.agentDir, rel)).join(", ")}`);
	const hasSection = root !== undefined && Object.hasOwn(root, "system-prompt-replace");
	if (!hasSection && legacy.length === 0) return { kind: "none" };
	const migrationExcluded =
		plainRelExcluded(REPLACEMENT_RULES_REL, exclusions) ||
		plainRelExcluded(OMOMP_REL, exclusions) ||
		fieldExcluded(OMOMP_REL, [REPLACEMENT_SECTION], exclusions) ||
		legacy.some((rel) => plainRelExcluded(rel, exclusions));
	if (migrationExcluded) {
		for (const rel of [REPLACEMENT_RULES_REL, OMOMP_REL, ...legacy])
			if (plainRelExcluded(rel, exclusions)) report.skipped.push({ path: targetOf(rel, opts.agentDir), reason: EXCLUDED_REASON });
		if (fieldExcluded(OMOMP_REL, [REPLACEMENT_SECTION], exclusions))
			report.skipped.push({ path: `${targetOf(OMOMP_REL, opts.agentDir)}:${REPLACEMENT_SECTION}`, reason: EXCLUDED_REASON });
		return { kind: "none" };
	}
	const destination = targetOf(REPLACEMENT_RULES_REL, opts.agentDir);
	if (lexists(destination)) return blocked(`${destination} already exists`);
	if (files.some((rel) => isAppManaged(join(opts.agentDir, rel)))) return blocked(`${targetOf(OMOMP_REL, opts.agentDir)} is app-managed`);
	const managedLegacy = legacy.find((rel) => isAppManaged(targetOf(rel, opts.agentDir)));
	if (managedLegacy !== undefined) return blocked(`${targetOf(managedLegacy, opts.agentDir)} is app-managed`);
	if (hasSection && legacy.length > 0)
		return blocked(`the section and legacy JSON coexist: ${[OMOMP_REL, ...legacy].map((rel) => targetOf(rel, opts.agentDir)).join(", ")}`);
	let value: unknown = root?.["system-prompt-replace"];
	if (!hasSection) {
		if (legacy.length !== 1) return blocked(`multiple legacy JSON files: ${legacy.join(", ")}`);
		try {
			value = JSON.parse(readFileSync(targetOf(legacy[0]!, opts.agentDir), "utf8"));
		} catch (error) {
			return blocked(`${legacy[0]}: ${errorText(error)}`);
		}
	}
	const item = hasSection ? { rel: OMOMP_REL, format: "yaml" as const } : { rel: legacy[0]!, format: "json" as const };
	const path = hasSection ? ["system-prompt-replace"] : [];
	let rules: string | undefined;
	if (!unmodifiedReplacementSection(base, history, item, path, value)) {
		const converted = convertLegacySystemReplacements(value);
		if (converted.kind === "invalid") return blocked(converted.reason);
		rules = converted.text;
	}
	let omomp: string | undefined;
	if (hasSection && root !== undefined && text !== undefined) {
		const removed = removeYamlSections(text, root, [REPLACEMENT_SECTION]);
		if (removed.kind === "invalid") return blocked(removed.reason);
		omomp = removed.text;
	}
	const recorded = base.structuredOf(OMOMP_REL);
	const omompBase: BaseChange | undefined =
		recorded === undefined || valueAt(recorded.value, [REPLACEMENT_SECTION]) === undefined
			? undefined
			: {
					kind: "structured",
					rel: OMOMP_REL,
					record: {
						value: Object.fromEntries(Object.entries(recorded.value).filter(([key]) => key !== REPLACEMENT_SECTION)),
						unknown: recorded.unknown.filter((path) => path[0] !== REPLACEMENT_SECTION),
					},
				};
	return { kind: "ready", rules, omomp, legacy, omompBase };
}

function groupReplacementMigration(opts: ApplyOptions, migration: ReplacementMigration, planned: readonly Op[]): Op[] {
	if (migration.kind !== "ready") return [...planned];
	const writes: Extract<Op, { kind: "write" }>[] = [];
	const changes: BaseChange[] = [];
	const rest: Op[] = [];
	for (const op of planned) {
		if (op.rel === REPLACEMENT_RULES_REL && op.kind === "write") writes.push(op);
		else if (op.rel === REPLACEMENT_RULES_REL && op.kind === "base") changes.push(op.change);
		else rest.push(op);
	}
	if (migration.omomp !== undefined)
		writes.push({ kind: "write", rel: OMOMP_REL, target: targetOf(OMOMP_REL, opts.agentDir), content: migration.omomp });
	if (migration.omompBase !== undefined) changes.push(migration.omompBase);
	return [
		{
			kind: "migrate-replacements",
			rel: REPLACEMENT_RULES_REL,
			target: targetOf(REPLACEMENT_RULES_REL, opts.agentDir),
			writes,
			deletes: migration.legacy.map((rel) => targetOf(rel, opts.agentDir)),
			changes,
		},
		...rest,
	];
}

function freshMachine(agentDir: string, base: BaseRecord): boolean {
	return !base.exists && !lexists(join(agentDir, UPDATER_REL)) && !lexists(join(agentDir, LEGACY_UPDATER_REL));
}

function newReport(): ApplyReport {
	return {
		written: [],
		moved: [],
		deleted: [],
		skipped: [],
		errors: [],
		notes: [],
		pluginsInstalled: [],
		pluginsUpgraded: [],
		pluginsMissing: [],
		pluginChanges: [],
		conflicts: [],
		overwritten: [],
		restartNeeded: false,
	};
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

function planPlainItem(ctx: PlanContext, rel: string, repo: Buffer | undefined, dropped?: Buffer, projectedHost?: Buffer): Op[] {
	const { opts, report } = ctx;
	const target = targetOf(rel, opts.agentDir);
	if (lexists(target) && isAppManaged(target)) {
		report.skipped.push({ path: target, reason: "app-managed" });
		return [];
	}
	const host = projectedHost ?? (existsSync(target) ? readFileSync(target) : undefined);
	const recorded = ctx.base.plain(rel);
	const base = recorded.kind === "none" && dropped !== undefined ? { kind: "known" as const, content: dropped } : recorded;
	const code = rel.endsWith(".ts");
	const accept: BaseChange = repo === undefined ? { kind: "plain-drop", rel } : { kind: "plain-known", rel, content: repo };
	const conflict = (reason: ConflictReason): Op[] => {
		report.conflicts.push({ kind: "file", id: `${rel}@${repo === undefined ? "absent" : digest(repo)}`, rel, target, reason });
		if (recorded.kind !== "none") return [];
		const change: BaseChange = dropped !== undefined ? { kind: "plain-known", rel, content: dropped } : { kind: "plain-unknown", rel };
		return [{ kind: "base", rel, change }];
	};
	if (MACHINE_OWNED_PLAIN.test(rel)) {
		if (host === undefined)
			return repo !== undefined && recorded.kind === "none" ? [{ kind: "write", rel, target, content: repo, base: accept }] : [];
		const unmodified = base.kind === "known" && host.equals(base.content);
		if (repo !== undefined && host.equals(repo))
			return recorded.kind === "known" && recorded.content.equals(repo) ? [] : [{ kind: "base", rel, change: accept }];
		if (unmodified)
			return repo === undefined
				? [{ kind: "delete", rel, target, base: accept }]
				: [{ kind: "write", rel, target, content: repo, base: accept }];
		return recorded.kind === "none" ? [{ kind: "base", rel, change: { kind: "plain-unknown", rel } }] : [];
	}
	if (repo === undefined) {
		if (host === undefined) return [{ kind: "base", rel, change: accept }];
		const unmodified = base.kind === "known" && host.equals(base.content);
		if (!unmodified && !code) return conflict(base.kind === "known" ? "dropped-upstream" : "unknown-base");
		if (!unmodified) report.overwritten.push(target);
		return [{ kind: "delete", rel, target, base: accept }];
	}
	if (host?.equals(repo)) return base.kind === "known" && base.content.equals(repo) ? [] : [{ kind: "base", rel, change: accept }];
	if (host === undefined) {
		if (base.kind === "none" || code) return [{ kind: "write", rel, target, content: repo, base: accept }];
		if (base.kind === "known" && base.content.equals(repo)) return [];
		return conflict(base.kind === "known" ? "deleted-locally" : "unknown-base");
	}
	const unmodified = base.kind === "known" ? host.equals(base.content) : base.kind === "none" && ctx.history.hasVersion(rel, host);
	if (unmodified || code) {
		if (!unmodified) report.overwritten.push(target);
		return [{ kind: "write", rel, target, content: repo, base: accept }];
	}
	if (base.kind !== "known") return conflict("unknown-base");
	if (base.content.equals(repo)) return [];
	const merged = mergeText(host, base.content, repo);
	return merged.kind === "clean" ? [{ kind: "write", rel, target, content: merged.content, base: accept }] : conflict("both-changed");
}

function retiring(ctx: PlanContext, rel: string): boolean {
	const leaf = agentPathOf(rel);
	return (
		(ctx.todoRequired && TODO_RETIREMENTS.includes(leaf)) ||
		CTX_RETIREMENTS.includes(leaf) ||
		(ctx.forkRequired && FORK_RETIREMENTS.includes(leaf))
	);
}

function planPlain(ctx: PlanContext): Op[] {
	const { opts } = ctx;
	const shipped = listSourceFiles(opts.source).filter((rel) => {
		const leaf = agentPathOf(rel);
		return !((ctx.todoRequired && TODO_RETIREMENTS.includes(leaf)) || (ctx.forkRequired && FORK_RETIREMENTS.includes(leaf)));
	});
	const ops: Op[] = [];
	for (const rel of shipped) {
		if (skipExcluded(ctx, rel)) continue;
		const migration = ctx.replacementMigration;
		if (rel === REPLACEMENT_RULES_REL && migration.kind === "blocked") continue;
		const projected =
			rel === REPLACEMENT_RULES_REL && migration.kind === "ready" && migration.rules !== undefined
				? Buffer.from(migration.rules)
				: undefined;
		const planned = planPlainItem(ctx, rel, readFileSync(join(opts.source, rel)), undefined, projected);
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
		if (!managedPlain(rel) || retiring(ctx, rel)) ops.push({ kind: "base", rel, change: { kind: "plain-drop", rel } });
		else ops.push(...planPlainItem(ctx, rel, undefined));
	}
	for (const [rel, content] of droppedBeforeBase(ctx))
		if (!known.has(rel) && !skipExcluded(ctx, rel)) ops.push(...planPlainItem(ctx, rel, undefined, content));
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

function structuredHistory(history: RepoHistory, item: Pick<StructuredItem, "rel" | "format">): Mapping[] {
	const versions: Mapping[] = [];
	history.eachVersion(item.rel, (text) => {
		try {
			versions.push(parseStructured(text, item.format));
		} catch {}
	});
	return versions;
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
				// Replacing it would drop the host's own values; leave it and retry next start.
				report.errors.push(`${target}: host copy unparsable (${errorText(error)}); left untouched`);
				continue;
			}
		}
		const recorded = ctx.base.structuredOf(item.rel);
		const source: StructuredBaseSource =
			recorded !== undefined
				? { kind: "recorded", value: recorded.value, unknown: recorded.unknown }
				: host === undefined || ctx.freshMachine
					? { kind: "empty" }
					: { kind: "history", versions: structuredHistory(ctx.history, item) };
		const fields = ctx.exclusions.fields.get(item.rel) ?? [];
		const rules =
			fields.length === 0 ? item.rules : { ...item.rules, local: [...item.rules.local, ...fields.map((field) => field.join("."))] };
		const merged = mergeStructured(host, repo, source, rules);
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

function lexists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
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
		if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
			return { kind: "missing" };
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

function previouslyShipped(opts: ApplyOptions, rel: string): boolean {
	return opts.previousCommit !== undefined && git(opts.source, ["cat-file", "-e", `${opts.previousCommit}:${rel}`]).ok;
}

function planLegacyModelSplits(ctx: PlanContext, from: readonly string[], toDir: string): Op[] {
	const { opts, report } = ctx;
	const candidates: { rel: string; target: string; fragments: { target: string; content: string }[] }[] = [];
	for (const rel of from) {
		const source = join(opts.agentDir, rel);
		if (!lexists(source)) continue;
		if (skipExcluded(ctx, `agent/${rel}`)) continue;
		if (isAppManaged(source)) {
			report.skipped.push({ path: source, reason: "app-managed" });
			continue;
		}
		if (lstatSync(source).isSymbolicLink()) {
			report.notes.push(
				`${source} is a symlink and was not moved; split it into ${join(opts.agentDir, toDir)}/APPEND-SYSTEM-model-NN.md yourself`,
			);
			continue;
		}
		const parsed = parseLegacyModelFragments(readFileSync(source, "utf8"));
		if (parsed.kind === "invalid") {
			report.notes.push(`${source} left in place: cannot split APPEND_SYSTEM_MODEL.md: ${parsed.reason}`);
			continue;
		}
		candidates.push({
			rel: `agent/${rel}`,
			target: source,
			fragments: parsed.fragments.map((content, index) => ({
				target: join(opts.agentDir, toDir, `APPEND-SYSTEM-model-${String(index + 1).padStart(2, "0")}.md`),
				content,
			})),
		});
	}
	const ops: Op[] = [];
	for (const candidate of candidates) {
		const collision = candidate.fragments.find(({ target }) => lexists(target));
		if (collision) {
			report.notes.push(`${candidate.target} left in place: ${collision.target} already exists`);
			continue;
		}
		const overlap = candidates.find(
			(other) =>
				other !== candidate && other.fragments.some(({ target }) => candidate.fragments.some((fragment) => fragment.target === target)),
		);
		if (overlap) {
			report.notes.push(`${candidate.target} left in place: numbered fragment targets overlap with ${overlap.target}`);
			continue;
		}
		const shipped = candidate.fragments.find((_, index) =>
			lexists(join(opts.source, "agent", toDir, `APPEND-SYSTEM-model-${String(index + 1).padStart(2, "0")}.md`)),
		);
		if (shipped) {
			report.notes.push(`${candidate.target} left in place: ${shipped.target} is a managed source file`);
			continue;
		}
		if (
			candidate.fragments.some((fragment) => plainRelExcluded(`agent/${fragment.target.slice(opts.agentDir.length + 1)}`, ctx.exclusions))
		) {
			report.skipped.push({ path: candidate.target, reason: EXCLUDED_REASON });
			continue;
		}
		ops.push({ kind: "split", ...candidate });
	}
	return ops;
}

function planRelocations(ctx: PlanContext): Op[] {
	const { opts, report } = ctx;
	const ops: Op[] = [];
	for (const { from, by } of SUPERSEDED) {
		const target = join(opts.agentDir, from);
		if (!lexists(target) || !existsSync(join(opts.source, "agent", by)) || skipExcluded(ctx, `agent/${from}`)) continue;
		if (isAppManaged(target)) {
			report.errors.push(`${target} is app-managed and would load beside ${join(opts.agentDir, by)}; remove one of them`);
			continue;
		}
		ops.push({ kind: "delete", rel: `agent/${from}`, target });
	}
	const moves: { from: string; to: string; owner: "host" | "template" }[] = [];
	for (const entry of DATA_MOVES) {
		switch (entry.kind) {
			case "split-model":
				ops.push(...planLegacyModelSplits(ctx, entry.from, entry.toDir));
				break;
			case "pattern": {
				let names: string[];
				try {
					names = readdirSync(opts.agentDir);
				} catch {
					continue;
				}
				for (const name of names.sort()) {
					if (entry.pattern.test(name)) moves.push({ from: name, to: `${entry.toDir}/${name}`, owner: entry.owner });
				}
				break;
			}
			default: {
				const unreachable: never = entry;
				throw new Error(`unknown data move ${JSON.stringify(unreachable)}`);
			}
		}
	}
	for (const { from, to, owner } of moves) {
		const source = join(opts.agentDir, from);
		const target = join(opts.agentDir, to);
		if (!lexists(source)) continue;
		if (skipExcluded(ctx, `agent/${from}`) || skipExcluded(ctx, `agent/${to}`)) continue;
		if (isAppManaged(source)) {
			report.skipped.push({ path: source, reason: "app-managed" });
			continue;
		}
		const repoOwned = owner === "template" && (existsSync(join(opts.source, "agent", to)) || previouslyShipped(opts, `agent/${from}`));
		if (repoOwned && !shippedTemplateCopy(ctx, from, to, readFileSync(source))) {
			report.notes.push(`${source} left in place: it differs from every shipped version; port its changes into ${target}, then delete it`);
		} else if (repoOwned) {
			ops.push({ kind: "delete", rel: `agent/${from}`, target: source });
		} else if (lstatSync(source).isSymbolicLink()) {
			report.notes.push(`${source} is a symlink and was not moved; point it at ${target} yourself`);
		} else if (lexists(target)) {
			report.notes.push(`${source} left in place: ${target} already exists`);
		} else {
			ops.push({ kind: "move", rel: `agent/${to}`, from: source, target });
		}
	}
	return ops;
}

function shippedTemplateCopy(ctx: PlanContext, from: string, to: string, content: Buffer): boolean {
	return [`agent/${from}`, `agent/${to}`].some((rel) => {
		const recorded = ctx.base.plain(rel);
		if (recorded.kind === "known" && recorded.content.equals(content)) return true;
		const current = join(ctx.opts.source, rel);
		if (existsSync(current) && readFileSync(current).equals(content)) return true;
		return ctx.history.hasVersion(rel, content);
	});
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
		if (!managedPlain(rel) || retiring(ctx, rel)) continue;
		const content = ctx.history.show(opts.previousCommit, rel);
		if (content !== undefined) dropped.set(rel, content);
	}
	return dropped;
}

function installLauncher(opts: ApplyOptions, report: ApplyReport): void {
	const sourcePath = join(opts.source, "agent/omp-light.ts");
	if (!existsSync(sourcePath)) return;
	const found = Bun.which("omp");
	if (!found) {
		report.errors.push("omp-light not installed: omp is not on PATH");
		return;
	}
	const binDir = dirname(resolve(found));
	const script = readFileSync(sourcePath);
	const expected =
		process.platform === "win32"
			? installWindowsLauncher(opts, report, binDir, sourcePath, script)
			: installPosixLauncher(opts, report, binDir, script);
	const resolved = Bun.which("omp-light");
	if (!opts.check && resolved && resolve(resolved).toLowerCase() !== expected.toLowerCase()) {
		report.notes.push(`omp-light on PATH resolves to ${resolved}, not ${expected} (PATH shadowing)`);
	}
}

function installPosixLauncher(opts: ApplyOptions, report: ApplyReport, binDir: string, script: Buffer): string {
	const path = join(binDir, "omp-light");
	const same = existsSync(path) && Buffer.from(readFileSync(path)).equals(script) && (statSync(path).mode & 0o777) === 0o755;
	if (same) return path;
	if (opts.check) {
		report.written.push(path);
		return path;
	}
	try {
		atomicWrite(path, script, 0o755);
		report.written.push(path);
	} catch (error) {
		report.errors.push(`${path}: ${errorText(error)}`);
	}
	return path;
}

function installWindowsLauncher(opts: ApplyOptions, report: ApplyReport, binDir: string, sourcePath: string, script: Buffer): string {
	const source = join(binDir, "omp-light.ts");
	const executable = join(binDir, "omp-light.exe");
	const legacy = join(binDir, "omp-light.cmd");
	const current = existsSync(executable) && existsSync(source) && Buffer.from(readFileSync(source)).equals(script);
	if (opts.check) {
		if (!current) report.written.push(executable);
		if (existsSync(legacy)) report.deleted.push(legacy);
		return executable;
	}
	if (!current) {
		const bun = Bun.which("bun");
		if (!bun) {
			report.errors.push("omp-light not installed: bun is not on PATH to compile omp-light.exe");
			return executable;
		}
		try {
			const built = Bun.spawnSync([bun, "build", "--compile", sourcePath, "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
			if (built.exitCode !== 0) {
				report.errors.push(`${executable}: bun build --compile exited ${built.exitCode}: ${built.stderr.toString().trim()}`);
				return executable;
			}
			atomicWrite(source, script, undefined);
			report.written.push(executable);
		} catch (error) {
			report.errors.push(`${executable}: ${errorText(error)}`);
			return executable;
		}
	}
	if (existsSync(legacy)) {
		try {
			unlinkSync(legacy);
			report.deleted.push(legacy);
		} catch (error) {
			report.errors.push(`${legacy}: ${errorText(error)}`);
		}
	}
	return executable;
}

interface DeclaredPlugins {
	readonly required: string[];
	readonly optional: string[];
}

function declaredPlugins(source: string): DeclaredPlugins {
	const required: string[] = [];
	const optional: string[] = [];
	const path = join(source, "install-plugins.sh");
	if (!existsSync(path)) return { required, optional };
	let inside = false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (/^\s*plugins=\(/.test(line)) {
			inside = true;
			continue;
		}
		if (!inside) continue;
		if (/^\s*\)/.test(line)) break;
		const entry = /^\s*'([^']+)'/.exec(line);
		if (entry) {
			required.push(entry[1]!);
			continue;
		}
		const commented = /^\s*#\s*'?([^'\s]+)'?\s*$/.exec(line);
		if (commented) optional.push(commented[1]!);
	}
	return { required, optional };
}

const PLUGIN_CHANNEL = "release";

function movesOnItsOwn(spec: string): boolean {
	if (!spec.includes("://")) return false;
	const hash = spec.indexOf("#");
	return hash === -1 || spec.slice(hash + 1) === PLUGIN_CHANNEL;
}

const PLUGINS_HOME = join(homedir(), ".omp", "plugins");

interface GithubSource {
	readonly repo: string;
	readonly ref: string | undefined;
}

function githubSource(value: string): GithubSource | undefined {
	const hash = value.indexOf("#");
	const source = hash === -1 ? value : value.slice(0, hash);
	const match = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(source);
	if (match === null) return undefined;
	const ref = hash === -1 ? "" : value.slice(hash + 1);
	return { repo: `${match[1]}/${match[2]}`.toLowerCase(), ref: ref === "" ? undefined : ref };
}

const NPM_SPEC = /^((?:@[^/@:#\s]+\/)?[^/@:#\s]+)(?:@([^/:#\s]+))?$/;
const NPM_RANGE = /^[^/:#]+$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const LOCAL_DEPENDENCY = /^(?:file|link|workspace|portal):/i;

type DeclaredPlugin =
	| { readonly kind: "github"; readonly spec: string; readonly name: string; readonly source: GithubSource }
	| { readonly kind: "npm"; readonly spec: string; readonly name: string; readonly range: string | undefined }
	| { readonly kind: "unrecognized"; readonly spec: string };

function parseDeclaredPlugin(spec: string): DeclaredPlugin {
	const source = githubSource(spec);
	if (source !== undefined) return { kind: "github", spec, name: source.repo.slice(source.repo.indexOf("/") + 1), source };
	const npm = NPM_SPEC.exec(spec);
	if (npm !== null) return { kind: "npm", spec, name: npm[1]!, range: npm[2] };
	return { kind: "unrecognized", spec };
}

interface LockEntry {
	readonly version: string | null;
	readonly disabled: boolean;
	readonly features: readonly string[] | null;
}

interface PluginRecords {
	readonly dependencies: ReadonlyMap<string, string>;
	readonly lock: ReadonlyMap<string, LockEntry>;
}

function readMapping(path: string): Mapping {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isMapping(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function pluginRecords(): PluginRecords {
	const pkg = readMapping(join(PLUGINS_HOME, "package.json"));
	const dependencies = new Map<string, string>();
	for (const [name, value] of Object.entries(isMapping(pkg.dependencies) ? pkg.dependencies : {}))
		if (typeof value === "string") dependencies.set(name, value);
	const runtime = readMapping(join(PLUGINS_HOME, "omp-plugins.lock.json"));
	const lock = new Map<string, LockEntry>();
	for (const [name, entry] of Object.entries(isMapping(runtime.plugins) ? runtime.plugins : {}))
		if (isMapping(entry))
			lock.set(name, {
				version: typeof entry.version === "string" ? entry.version : null,
				disabled: entry.enabled === false,
				features: isStringArray(entry.enabledFeatures) ? entry.enabledFeatures : null,
			});
	return { dependencies, lock };
}

interface InstalledRecord {
	readonly name: string;
	readonly dependency: string | undefined;
	readonly lock: LockEntry | undefined;
}

function installedRecord(plugin: Exclude<DeclaredPlugin, { kind: "unrecognized" }>, records: PluginRecords): InstalledRecord {
	if (plugin.kind === "github")
		for (const [name, dependency] of records.dependencies)
			if (githubSource(dependency)?.repo === plugin.source.repo) return { name, dependency, lock: records.lock.get(name) };
	return { name: plugin.name, dependency: records.dependencies.get(plugin.name), lock: records.lock.get(plugin.name) };
}

const packagePath = (name: string): string => join(PLUGINS_HOME, "node_modules", name);

function linkTarget(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
	} catch {
		return undefined;
	}
}

function locallyLinked(record: InstalledRecord): boolean {
	if (record.dependency !== undefined && LOCAL_DEPENDENCY.test(record.dependency)) return true;
	if (record.dependency === undefined && record.lock !== undefined) return true;
	return linkTarget(packagePath(record.name)) !== undefined;
}

interface OverlaidLink {
	readonly name: string;
	readonly target: string;
	readonly lock: LockEntry | undefined;
}

function overlaidLinks(records: PluginRecords): OverlaidLink[] {
	return [...records.dependencies.keys()].flatMap((name) => {
		const target = linkTarget(packagePath(name));
		return target === undefined ? [] : [{ name, target, lock: records.lock.get(name) }];
	});
}

function restoreLinks(omp: string, links: readonly OverlaidLink[]): string[] {
	const errors: string[] = [];
	for (const link of links) {
		if (linkTarget(packagePath(link.name)) === link.target) continue;
		const commands: string[][] = [["plugin", "link", link.target]];
		if (link.lock?.disabled === true) commands.push(["plugin", "disable", link.name]);
		const features = link.lock?.features;
		if (features !== undefined && features !== null)
			commands.push(["plugin", "features", link.name, "--set", features.length > 0 ? features.join(",") : ","]);
		for (const args of commands) {
			const error = runOmp(omp, args);
			if (error === undefined) continue;
			errors.push(error);
			break;
		}
	}
	return errors;
}

type PluginStep =
	| { readonly kind: "unrecognized"; readonly spec: string }
	| { readonly kind: "linked"; readonly spec: string }
	| { readonly kind: "missing"; readonly spec: string }
	| { readonly kind: "pinned"; readonly spec: string }
	| { readonly kind: "upgrade"; readonly spec: string; readonly name: string; readonly from: string | null }
	| { readonly kind: "reinstall"; readonly spec: string; readonly from: string | null; readonly disabled: boolean };

function sameSpecStep(plugin: Exclude<DeclaredPlugin, { kind: "unrecognized" }>, dependency: string): "upgrade" | "pinned" | "reinstall" {
	switch (plugin.kind) {
		case "github": {
			const recorded = githubSource(dependency);
			return recorded?.repo === plugin.source.repo && recorded.ref === plugin.source.ref ? "upgrade" : "reinstall";
		}
		case "npm":
			if (!NPM_RANGE.test(dependency)) return "reinstall";
			if (plugin.range === undefined) return "upgrade";
			return EXACT_VERSION.test(plugin.range) && dependency === plugin.range ? "pinned" : "reinstall";
		default: {
			const unreachable: never = plugin;
			throw new Error(String(unreachable));
		}
	}
}

function planPlugin(spec: string, records: PluginRecords): PluginStep {
	const plugin = parseDeclaredPlugin(spec);
	if (plugin.kind === "unrecognized") return { kind: "unrecognized", spec };
	const record = installedRecord(plugin, records);
	if (locallyLinked(record)) return { kind: "linked", spec };
	if (record.dependency === undefined) return { kind: "missing", spec };
	const from = record.lock?.version ?? null;
	const step = sameSpecStep(plugin, record.dependency);
	switch (step) {
		case "upgrade":
			return { kind: "upgrade", spec, name: record.name, from };
		case "pinned":
			return { kind: "pinned", spec };
		case "reinstall":
			return { kind: "reinstall", spec, from, disabled: record.lock?.disabled === true };
		default: {
			const unreachable: never = step;
			throw new Error(String(unreachable));
		}
	}
}

function planPlugins(plugins: DeclaredPlugins): PluginStep[] {
	const records = pluginRecords();
	return [
		...plugins.required.map((spec) => planPlugin(spec, records)),
		...plugins.optional.map((spec) => planPlugin(spec, records)).filter((step) => step.kind !== "missing"),
	];
}

const unrecognizedNotes = (steps: readonly PluginStep[]): string[] =>
	steps.flatMap((step) => (step.kind === "unrecognized" ? [`plugin spec not recognized, left unhandled: ${step.spec}`] : []));

type PluginReadiness = { readonly kind: "ready" } | { readonly kind: "missing" } | { readonly kind: "invalid"; readonly message: string };

type TodoPluginReadiness =
	| { readonly kind: "ready"; readonly ctx: boolean }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string };

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

type PluginCatalog = { readonly kind: "ok"; readonly entries: readonly unknown[] } | { readonly kind: "invalid"; readonly message: string };

function pluginCatalog(): PluginCatalog {
	const omp = Bun.which("omp");
	if (omp === null) return { kind: "invalid", message: "Plugin readiness unavailable: omp is not on PATH" };
	const result = spawnSync(omp, ["plugin", "list", "--json"], { encoding: "utf8" });
	if (result.error || result.status !== 0)
		return {
			kind: "invalid",
			message: `Plugin readiness query failed: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
		};
	try {
		const value: unknown = JSON.parse(result.stdout);
		if (!isMapping(value) || !Array.isArray(value.npm)) return { kind: "invalid", message: "Plugin readiness: invalid npm catalog" };
		return { kind: "ok", entries: value.npm };
	} catch (error) {
		return { kind: "invalid", message: `Plugin readiness cannot be confirmed (${errorText(error)})` };
	}
}

type NpmPluginEntry =
	| { readonly kind: "found"; readonly plugin: Mapping }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string };

function npmPluginEntry(catalog: PluginCatalog, name: string, label: string): NpmPluginEntry {
	if (catalog.kind === "invalid") return catalog;
	let plugin: Mapping | undefined;
	for (const entry of catalog.entries) {
		if (!isMapping(entry) || entry.name !== name) continue;
		if (plugin !== undefined) return { kind: "invalid", message: `${label} readiness: ambiguous npm entries` };
		plugin = entry;
	}
	if (plugin === undefined) return { kind: "missing" };
	if (plugin.enabled !== true) return { kind: "invalid", message: `${label} is disabled or has invalid enablement; nothing switched` };
	return { kind: "found", plugin };
}

function todoPluginReadiness(catalog: PluginCatalog): TodoPluginReadiness {
	const entry = npmPluginEntry(catalog, TODO_PLUGIN_NAME, "Todo plugin");
	if (entry.kind !== "found") return entry;
	const plugin = entry.plugin;
	try {
		if (!isMapping(plugin.manifest) || !isStringArray(plugin.manifest.extensions) || !plugin.manifest.extensions.includes("./index.ts")) {
			return { kind: "invalid", message: "Todo plugin does not declare ./index.ts; nothing switched" };
		}
		if (typeof plugin.path !== "string" || !isAbsolute(plugin.path) || !statSync(join(plugin.path, "index.ts")).isFile()) {
			return { kind: "invalid", message: "Todo plugin entry is missing or invalid; nothing switched" };
		}
		return { kind: "ready", ctx: existsSync(join(plugin.path, "src", "ctx", "index.ts")) };
	} catch (error) {
		return { kind: "invalid", message: `Todo plugin readiness cannot be confirmed (${errorText(error)}); nothing switched` };
	}
}

function forkPluginReadiness(catalog: PluginCatalog): PluginReadiness {
	const entry = npmPluginEntry(catalog, FORK_PLUGIN_NAME, `${FORK_PLUGIN_NAME} plugin`);
	if (entry.kind !== "found") return entry;
	const plugin = entry.plugin;
	if (
		!isMapping(plugin.manifest) ||
		!isStringArray(plugin.manifest.extensions) ||
		!plugin.manifest.extensions.includes("./extensions/fork-task/index.ts")
	) {
		return { kind: "invalid", message: `${FORK_PLUGIN_NAME} plugin does not declare ./extensions/fork-task/index.ts; nothing switched` };
	}
	const path = plugin.path;
	if (typeof path !== "string" || !isAbsolute(path)) {
		return { kind: "invalid", message: `${FORK_PLUGIN_NAME} plugin entry is missing or invalid; nothing switched` };
	}
	const missing = ["extensions/fork-task/index.ts", "agents/fork-self.md"].filter((rel) => !existsSync(join(path, rel)));
	if (missing.length > 0) {
		return { kind: "invalid", message: `${FORK_PLUGIN_NAME} plugin is missing ${missing.join(", ")}; nothing switched` };
	}
	return { kind: "ready" };
}

function pluginResolutionState(): string {
	return ["bun.lock", "omp-plugins.lock.json"]
		.map((name) => {
			try {
				return readFileSync(join(PLUGINS_HOME, name), "utf8");
			} catch {
				return "";
			}
		})
		.join("\0");
}

function installedName(spec: string): string {
	const plugin = parseDeclaredPlugin(spec);
	return plugin.kind === "unrecognized" ? spec : installedRecord(plugin, pluginRecords()).name;
}

const lockedVersion = (name: string): string | null => pluginRecords().lock.get(name)?.version ?? null;

function runOmp(omp: string, args: readonly string[]): string | undefined {
	const result = spawnSync(omp, args, { encoding: "utf8" });
	if (result.status === 0) return undefined;
	return `omp ${args.join(" ")}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`;
}

/**
 * Never `omp install` an installed plugin whose declared spec is unchanged: install resets the
 * user's `enabled` and `enabledFeatures`, while `omp plugin upgrade <name>` keeps both and still
 * moves `#release` and bare npm names forward. Never install or upgrade a locally linked plugin:
 * both replace the link. A changed spec needs `omp install <spec>` (upgrade re-resolves the
 * recorded spec), then `omp plugin disable <name>` if it was disabled, or the disable is lost.
 * A spec pinned to the recorded exact npm version and an unrecognized spec must run no command:
 * upgrade passes the pin, and an unrecognized spec never matches its record, so it would be
 * reinstalled on every apply. Every bun install the host runs, for any plugin, replaces a package
 * linked over its installed dependency with that dependency: do not drop the restore of those links,
 * and restore `enabled` and `enabledFeatures` after `omp plugin link`, which resets both.
 */
function refreshPlugins(omp: string, steps: readonly PluginStep[]): Omit<PluginRefresh, "notes"> {
	const links = overlaidLinks(pluginRecords());
	const installed: string[] = [];
	const upgraded: string[] = [];
	const errors: string[] = [];
	const changes: PluginChange[] = [];
	for (const step of steps) {
		switch (step.kind) {
			case "unrecognized":
			case "linked":
			case "pinned":
				break;
			case "missing": {
				const error = runOmp(omp, ["install", step.spec]);
				if (error !== undefined) {
					errors.push(error);
					break;
				}
				const name = installedName(step.spec);
				installed.push(step.spec);
				changes.push({ spec: step.spec, name, from: null, to: lockedVersion(name) });
				break;
			}
			case "upgrade": {
				const state = pluginResolutionState();
				const error = runOmp(omp, ["plugin", "upgrade", step.name]);
				if (error !== undefined) {
					errors.push(error);
					break;
				}
				if (pluginResolutionState() === state) break;
				upgraded.push(step.spec);
				changes.push({ spec: step.spec, name: step.name, from: step.from, to: lockedVersion(step.name) });
				break;
			}
			case "reinstall": {
				const state = pluginResolutionState();
				const error = runOmp(omp, ["install", step.spec]);
				if (error !== undefined) {
					errors.push(error);
					break;
				}
				const name = installedName(step.spec);
				const restore = step.disabled ? runOmp(omp, ["plugin", "disable", name]) : undefined;
				if (restore !== undefined) errors.push(restore);
				if (pluginResolutionState() === state) break;
				upgraded.push(step.spec);
				changes.push({ spec: step.spec, name, from: step.from, to: lockedVersion(name) });
				break;
			}
			default: {
				const unreachable: never = step;
				throw new Error(String(unreachable));
			}
		}
	}
	errors.push(...restoreLinks(omp, links));
	return { installed, upgraded, errors, changes };
}

function syncPlugins(opts: ApplyOptions, report: ApplyReport, plugins: DeclaredPlugins): void {
	const steps = planPlugins(plugins);
	const missing = steps.flatMap((step) => (step.kind === "missing" ? [step.spec] : []));
	if (opts.check || !opts.plugins) {
		report.pluginsMissing.push(...missing);
		if (opts.check && opts.plugins && steps.length > 0)
			report.notes.push(
				...unrecognizedNotes(steps),
				"plugins: apply installs missing plugins, runs omp plugin upgrade on installed ones whose spec is unchanged, reinstalls changed specs keeping a disable, and leaves linked ones alone; check runs none",
			);
		return;
	}
	report.notes.push(...unrecognizedNotes(steps));
	const omp = Bun.which("omp");
	if (!omp) {
		report.pluginsMissing.push(...missing);
		report.errors.push("plugins not installed: omp is not on PATH");
		return;
	}
	const refresh = refreshPlugins(omp, steps);
	report.pluginsInstalled.push(...refresh.installed);
	report.pluginsUpgraded.push(...refresh.upgraded);
	report.pluginChanges.push(...refresh.changes);
	report.pluginsMissing.push(...missing.filter((spec) => !refresh.installed.includes(spec)));
	report.errors.push(...refresh.errors);
	if (refresh.changes.length > 0) report.restartNeeded = true;
}

function refreshMovingPlugins(source: string): PluginRefresh {
	const steps = planPlugins(declaredPlugins(source));
	const notes = unrecognizedNotes(steps);
	const moving = steps.filter((step) => step.kind !== "unrecognized" && movesOnItsOwn(step.spec));
	if (moving.length === 0) return { installed: [], upgraded: [], errors: [], changes: [], notes };
	const omp = Bun.which("omp");
	if (!omp) return { installed: [], upgraded: [], errors: ["plugins not refreshed: omp is not on PATH"], changes: [], notes };
	return { ...refreshPlugins(omp, moving), notes };
}

interface SettingsPreflight {
	readonly omp: string | null;
	readonly plugin: PluginState;
	readonly manifest: Manifest | undefined;
	readonly plan: OmompPlan;
}

function pluginDirOf(agentDir: string): string {
	return join(agentDir, PLUGIN_DIR);
}

function readManifest(source: string): Manifest | undefined {
	const path = join(source, "agent", PLUGIN_DIR, "package.json");
	return existsSync(path) ? parseManifest(readFileSync(path, "utf8"), path) : undefined;
}

function shippedSection(base: BaseRecord, history: RepoHistory): (section: string, value: unknown) => boolean {
	return (section, value) => unmodifiedReplacementSection(base, history, { rel: OMOMP_REL, format: "yaml" }, [section], value);
}

function settingsPreflight(opts: ApplyOptions, base: BaseRecord, history: RepoHistory): SettingsPreflight {
	const manifest = readManifest(opts.source);
	const omp = opts.plugins ? Bun.which("omp") : null;
	const plugin: PluginState = omp === null ? { kind: "unregistered" } : queryPluginState(omp, pluginDirOf(opts.agentDir));
	if (plugin.kind === "failed") throw new Error(`plugin ${PLUGIN_NAME}: ${plugin.error}; nothing applied`);
	const plan = planOmompMigration({
		agentDir: opts.agentDir,
		manifest: manifest ?? new Map(),
		shipped: shippedSection(base, history),
		appManaged: (path) => isAppManaged(path),
	});
	return { omp, plugin, manifest, plan };
}

function exclusionsOf(preflight: SettingsPreflight, agentDir: string): Exclusions {
	const stored =
		preflight.plugin.kind === "unregistered" || preflight.plugin.kind === "failed" ? undefined : preflight.plugin.settings[EXCLUDE_KEY];
	if (stored !== undefined) {
		if (typeof stored !== "string") throw new Error(`plugin setting ${EXCLUDE_KEY} is not a string; nothing applied`);
		return parseExclusions(
			stored.split(/\s+/).filter((entry) => entry !== ""),
			`plugin setting ${EXCLUDE_KEY}`,
		);
	}
	const pending = preflight.plan.kind === "none" ? undefined : preflight.plan.pendingExclude;
	return parseExclusions(pending ?? [], `${join(agentDir, "omomp.yml")}: omp-config-autoupdate.exclude`);
}

const EXCLUDE_KEY = "omp-config-autoupdate.exclude";

function describeMove(move: SectionMove): string {
	const parts = [
		...[...move.settings].map(([key, value]) => `${key}=${JSON.stringify(value)}`),
		...move.files.map((file) => file.rel.slice("agent/".length)),
		...move.splitAgents.map((name) => `splitCheck: true in ${name}`),
		...move.bindings.map((binding) => `modelRoles.${binding.role}=${binding.value} unless assigned`),
	];
	if (parts.length > 0) return `${move.section}: ${parts.join(", ")}`;
	return `${move.section} (${move.notes.length > 0 ? move.notes.join("; ") : "nothing to keep"})`;
}

const CONFIG_REL = "agent/config.yml";

function machineRoles(agentDir: string): Mapping {
	const target = targetOf(CONFIG_REL, agentDir);
	if (!existsSync(target)) return {};
	const roles = valueAt(parseStructured(readFileSync(target, "utf8"), "yaml"), ["modelRoles"]);
	if (roles === undefined) return {};
	if (!isMapping(roles)) throw new Error(`${target}: modelRoles is not a mapping`);
	return roles;
}

function reportPendingSettings(opts: ApplyOptions, preflight: SettingsPreflight): string[] {
	const notes: string[] = [];
	if (preflight.manifest === undefined) return notes;
	if (opts.plugins && preflight.plugin.kind === "unregistered")
		notes.push(`plugin ${PLUGIN_NAME}: apply links ${pluginDirOf(opts.agentDir)}`);
	const plan = preflight.plan;
	switch (plan.kind) {
		case "none":
			return notes;
		case "blocked":
			return [...notes, `omomp sections left in place: ${plan.reason}`];
		case "ready": {
			const why = opts.plugins ? "apply moves" : "left in place without plugin steps (--no-plugins); a plugin apply moves";
			if (plan.moves.length > 0) notes.push(`omomp sections ${why} into plugin ${PLUGIN_NAME}: ${plan.moves.map(describeMove).join("; ")}`);
			for (const { section, reason } of plan.kept) notes.push(`omomp section ${section} left in place: ${reason}`);
			return notes;
		}
		default: {
			const unreachable: never = plan;
			return unreachable;
		}
	}
}

function ensurePlugin(opts: ApplyOptions, report: ApplyReport, omp: string, before: PluginState): Mapping | null {
	const dir = pluginDirOf(opts.agentDir);
	switch (before.kind) {
		case "registered":
			return before.settings;
		case "elsewhere":
			report.notes.push(`plugin ${PLUGIN_NAME} is registered from ${before.path}; left as it is (not ${dir})`);
			return before.settings;
		case "failed":
			report.errors.push(`plugin ${PLUGIN_NAME}: ${before.error}`);
			return null;
		case "unregistered": {
			if (!existsSync(join(dir, "package.json"))) {
				report.notes.push(`plugin ${PLUGIN_NAME} not linked: ${join(dir, "package.json")} is missing`);
				return null;
			}
			const error = linkPlugin(omp, dir);
			if (error !== undefined) {
				report.errors.push(`plugin ${PLUGIN_NAME} not linked: ${error}`);
				return null;
			}
			report.notes.push(`plugin ${PLUGIN_NAME} linked from ${dir}`);
			const after = queryPluginState(omp, dir);
			if (after.kind === "registered" || after.kind === "elsewhere") return after.settings;
			report.errors.push(`plugin ${PLUGIN_NAME}: not listed after linking ${dir}`);
			return null;
		}
		default: {
			const unreachable: never = before;
			return unreachable;
		}
	}
}

type MoveOutcome =
	| { readonly kind: "moved"; readonly bindings: readonly RoleBinding[] }
	| { readonly kind: "kept"; readonly reason: string }
	| { readonly kind: "skipped" };

function moveSection(
	opts: ApplyOptions,
	report: ApplyReport,
	omp: string,
	stored: Mapping,
	exclusions: Exclusions,
	move: SectionMove,
): MoveOutcome {
	const writes: { rel: string; content: string }[] = [];
	for (const file of move.files) {
		if (plainRelExcluded(file.rel, exclusions)) {
			report.skipped.push({ path: targetOf(file.rel, opts.agentDir), reason: EXCLUDED_REASON });
			return { kind: "skipped" };
		}
		const target = targetOf(file.rel, opts.agentDir);
		if (existsSync(target) && readFileSync(target, "utf8") !== file.content) return { kind: "kept", reason: `${target} already exists` };
		writes.push(file);
	}
	for (const name of move.splitAgents) {
		const edit = splitCheckEdit(opts.agentDir, name);
		switch (edit.kind) {
			case "edit":
				if (plainRelExcluded(edit.rel, exclusions)) {
					report.skipped.push({ path: targetOf(edit.rel, opts.agentDir), reason: EXCLUDED_REASON });
					return { kind: "skipped" };
				}
				writes.push(edit);
				break;
			case "present":
				break;
			case "declined":
				report.notes.push(`${targetOf(edit.rel, opts.agentDir)} sets splitCheck itself; left as it is`);
				break;
			case "missing":
				report.notes.push(`task-split-check.agents names ${name}, which no agents/*.md defines; add splitCheck: true to its definition`);
				break;
			default: {
				const unreachable: never = edit;
				return unreachable;
			}
		}
	}
	const bindings: RoleBinding[] = [];
	if (move.bindings.length > 0) {
		const config = targetOf(CONFIG_REL, opts.agentDir);
		if (
			plainRelExcluded(CONFIG_REL, exclusions) ||
			move.bindings.some((binding) => fieldExcluded(CONFIG_REL, ["modelRoles", binding.role], exclusions))
		) {
			report.skipped.push({ path: `${config}:modelRoles`, reason: EXCLUDED_REASON });
			return { kind: "skipped" };
		}
		if (isAppManaged(config)) return { kind: "kept", reason: `${config} is app-managed` };
		const roles = machineRoles(opts.agentDir);
		for (const binding of move.bindings) {
			const current = roles[binding.role];
			if (current === undefined) bindings.push(binding);
			else
				report.notes.push(
					`modelRoles.${binding.role} already assigned (${JSON.stringify(current)}); ${move.section}.fallbackRole ${binding.value} not applied`,
				);
		}
	}
	for (const [key, value] of move.settings) {
		if (Object.hasOwn(stored, key)) {
			if (stored[key] !== value)
				report.notes.push(
					`plugin setting ${key} already set (${JSON.stringify(stored[key])}); omomp value ${JSON.stringify(value)} not applied`,
				);
			continue;
		}
		const error = setPluginSetting(omp, key, value);
		if (error !== undefined) return { kind: "kept", reason: error };
	}
	for (const write of writes) {
		const target = targetOf(write.rel, opts.agentDir);
		atomicWrite(target, write.content);
		report.written.push(target);
	}
	if (bindings.length > 0) {
		const target = targetOf(CONFIG_REL, opts.agentDir);
		const config: Mapping = existsSync(target) ? parseStructured(readFileSync(target, "utf8"), "yaml") : {};
		for (const binding of bindings) setAt(config, ["modelRoles", binding.role], binding.value);
		atomicWrite(target, serialize(config, "yaml"));
		if (!report.written.includes(target)) report.written.push(target);
		for (const binding of bindings) report.notes.push(`${move.section}.fallbackRole became modelRoles.${binding.role}: ${binding.value}`);
	}
	report.notes.push(...move.notes);
	return { kind: "moved", bindings };
}

function settleSettings(
	opts: ApplyOptions,
	report: ApplyReport,
	preflight: SettingsPreflight,
	exclusions: Exclusions,
	base: BaseRecord,
	history: RepoHistory,
): void {
	const { omp, manifest } = preflight;
	if (omp === null || manifest === undefined) return;
	let stored = ensurePlugin(opts, report, omp, preflight.plugin);
	if (stored === null) return;
	if (plainRelExcluded(OMOMP_REL, exclusions)) {
		if (preflight.plan.kind !== "none") report.skipped.push({ path: targetOf(OMOMP_REL, opts.agentDir), reason: EXCLUDED_REASON });
		return;
	}
	const plan = planOmompMigration({
		agentDir: opts.agentDir,
		manifest,
		shipped: shippedSection(base, history),
		appManaged: (path) => isAppManaged(path),
	});
	if (plan.kind === "none") return;
	if (plan.kind === "blocked") {
		report.notes.push(`omomp sections left in place: ${plan.reason}`);
		return;
	}
	for (const { section, reason } of plan.kept) report.notes.push(`omomp section ${section} left in place: ${reason}`);
	const moved: { readonly move: SectionMove; readonly bindings: readonly RoleBinding[] }[] = [];
	for (const move of plan.moves) {
		if (fieldExcluded(OMOMP_REL, [move.section], exclusions)) {
			report.skipped.push({ path: `${targetOf(OMOMP_REL, opts.agentDir)}:${move.section}`, reason: EXCLUDED_REASON });
			continue;
		}
		let outcome: MoveOutcome;
		try {
			outcome = moveSection(opts, report, omp, stored, exclusions, move);
		} catch (error) {
			outcome = { kind: "kept", reason: errorText(error) };
		}
		if (outcome.kind === "kept") report.notes.push(`omomp section ${move.section} left in place: ${outcome.reason}`);
		if (outcome.kind === "moved") moved.push({ move, bindings: outcome.bindings });
	}
	if (moved.length === 0) return;
	const after = queryPluginState(omp, pluginDirOf(opts.agentDir));
	if (after.kind === "failed" || after.kind === "unregistered") {
		report.notes.push(
			`omomp sections left in place: plugin settings could not be read back (${after.kind === "failed" ? after.error : "unregistered"})`,
		);
		return;
	}
	stored = after.settings;
	let roles: Mapping;
	try {
		roles = machineRoles(opts.agentDir);
	} catch (error) {
		report.notes.push(`omomp sections left in place: modelRoles could not be read back (${errorText(error)})`);
		return;
	}
	const confirmed = moved
		.filter(({ move, bindings }) => {
			const missing = [
				...[...move.settings.keys()].filter((key) => !Object.hasOwn(stored ?? {}, key)),
				...bindings
					.filter((binding) => roles[binding.role] !== binding.value)
					.map((binding) => `modelRoles.${binding.role} as ${JSON.stringify(binding.value)}`),
			];
			if (missing.length > 0) report.notes.push(`omomp section ${move.section} left in place: not stored: ${missing.join(", ")}`);
			return missing.length === 0;
		})
		.map(({ move }) => move);
	for (const move of confirmed)
		if (move.from.kind === "legacy") {
			const target = targetOf(move.from.rel, opts.agentDir);
			unlinkSync(target);
			report.deleted.push(target);
		}
	const sections = confirmed.filter((move) => move.from.kind === "omomp").map((move) => move.section);
	const file = plan.file;
	if (file === undefined || sections.length === 0) return;
	const rewritten = withoutSections(file, sections);
	if (rewritten.kind === "invalid") {
		report.notes.push(`omomp sections ${sections.join(", ")} moved but left in ${file.path}: ${rewritten.reason}; delete them by hand`);
		return;
	}
	if (rewritten.empty) {
		unlinkSync(file.path);
		report.deleted.push(file.path);
	} else {
		atomicWrite(file.path, rewritten.text);
		report.written.push(file.path);
	}
	const rest = Object.fromEntries(Object.entries(file.root).filter(([key]) => !sections.includes(key)));
	if (!holdsOwnedSection(rest) && base.structuredOf(OMOMP_REL) !== undefined) base.commit([{ kind: "structured-drop", rel: OMOMP_REL }]);
}

interface ApplyState extends PlanContext {
	readonly settings: SettingsPreflight;
	readonly ctxRetirements: readonly Op[];
	readonly ops: readonly Op[];
	ctxReady: boolean;
}

function planApply(opts: ApplyOptions, report: ApplyReport): ApplyState | null {
	try {
		const base = BaseRecord.load(opts.agentDir);
		const history = new RepoHistory(opts.source, !opts.check);
		const settings = settingsPreflight(opts, base, history);
		const exclusions = exclusionsOf(settings, opts.agentDir);
		const sources = parseSources(opts, report);
		const declared = declaredPlugins(opts.source).required;
		const todoRequired = declared.includes(TODO_PLUGIN_URL);
		const forkRequired = declared.some(requiresForkPlugin);
		const replacementMigration = planReplacementMigration(opts, report, base, history, exclusions);
		const ctx: PlanContext = {
			opts,
			report,
			base,
			history,
			todoRequired,
			forkRequired,
			freshMachine: freshMachine(opts.agentDir, base),
			replacementMigration,
			exclusions,
		};
		const planned = [
			...planRelocations(ctx),
			...planPlain(ctx),
			...planStructured(ctx, sources),
			...(todoRequired ? planRetirements(ctx, TODO_RETIREMENTS) : []),
			...(forkRequired ? planRetirements(ctx, FORK_RETIREMENTS) : []),
		];
		const ctxRetirements = todoRequired ? planRetirements(ctx, CTX_RETIREMENTS) : [];
		report.notes.push(...history.notes);
		if (opts.check || !opts.plugins) report.notes.push(...reportPendingSettings(opts, settings));
		const rank: Record<Op["kind"], number> = { move: 0, split: 0, "migrate-replacements": 0, write: 1, delete: 2, base: 3 };
		const ops = groupReplacementMigration(opts, replacementMigration, planned).toSorted((a, b) => rank[a.kind] - rank[b.kind]);
		assertNoExcludedOps(ctx, ops);
		return { ...ctx, settings, ctxRetirements, ops, ctxReady: false };
	} catch (error) {
		report.errors.push(errorText(error));
		return null;
	}
}

function applyPluginGates(state: ApplyState): "stop" | undefined {
	const { opts, report } = state;
	const before = state.todoRequired || state.forkRequired ? pluginCatalog() : undefined;
	const todoBefore = state.todoRequired && before !== undefined ? todoPluginReadiness(before) : undefined;
	const forkBefore = state.forkRequired && before !== undefined ? forkPluginReadiness(before) : undefined;
	for (const readiness of [todoBefore, forkBefore]) {
		if (readiness?.kind === "invalid") report.errors.push(readiness.message);
	}
	if (report.errors.length > 0 && !opts.check) return "stop";
	syncPlugins(opts, report, declaredPlugins(opts.source));
	if (!opts.check && report.errors.length > 0) {
		cutoverNote(state);
		return "stop";
	}
	const after = state.todoRequired || state.forkRequired ? (opts.check ? before : pluginCatalog()) : undefined;
	if (after === undefined) return undefined;
	if (state.todoRequired) {
		const ready = todoPluginReadiness(after);
		switch (ready.kind) {
			case "ready":
				report.notes.push("Todo plugin prerequisite confirmed by OMP owner catalog.");
				state.ctxReady = ready.ctx;
				break;
			case "missing":
				report.errors.push(
					`Required plugin ${TODO_PLUGIN_NAME} is missing; no managed files switched${opts.check ? " (check never installs)" : ""}.`,
				);
				break;
			case "invalid": {
				const previous = todoBefore?.kind === "invalid" ? todoBefore.message : undefined;
				if (ready.message !== previous) report.errors.push(ready.message);
				break;
			}
			default: {
				const unreachable: never = ready;
				throw new Error(String(unreachable));
			}
		}
	}
	if (state.forkRequired) {
		const ready = forkPluginReadiness(after);
		switch (ready.kind) {
			case "ready":
				report.notes.push(`${FORK_PLUGIN_NAME} plugin prerequisite confirmed by OMP owner catalog.`);
				break;
			case "missing":
				report.errors.push(
					`Required plugin ${FORK_PLUGIN_NAME} is missing; no managed files switched${opts.check ? " (check never installs)" : ""}.`,
				);
				break;
			case "invalid": {
				const previous = forkBefore?.kind === "invalid" ? forkBefore.message : undefined;
				if (ready.message !== previous) report.errors.push(ready.message);
				break;
			}
			default: {
				const unreachable: never = ready;
				throw new Error(String(unreachable));
			}
		}
	}
	if (!opts.check && (state.todoRequired || state.forkRequired) && report.errors.length > 0) {
		cutoverNote(state);
		return "stop";
	}
	return undefined;
}

function cutoverNote(state: ApplyState): void {
	if (state.report.restartNeeded) state.report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
}

function runApplyOps(state: ApplyState): BaseChange[] {
	const { opts, report } = state;
	const ops = state.ctxReady ? [...state.ops, ...state.ctxRetirements] : state.ops;
	const accepted: BaseChange[] = [];
	for (const op of ops) {
		if (!opts.check && op.kind === "delete" && report.errors.length > 0) break;
		if (op.kind === "base") {
			accepted.push(op.change);
			continue;
		}
		const leaf = agentPathOf(op.rel);
		const retirement =
			op.kind === "delete" &&
			((state.todoRequired && TODO_RETIREMENTS.includes(leaf)) ||
				(state.ctxReady && CTX_RETIREMENTS.includes(leaf)) ||
				(state.forkRequired && FORK_RETIREMENTS.includes(leaf)));
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
		report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
}

export async function applySnapshot(opts: ApplyOptions): Promise<ApplyReport> {
	const report = newReport();
	const state = planApply(opts, report);
	if (state === null) return report;
	if (report.errors.length > 0 && !opts.check) return report;
	if (applyPluginGates(state) === "stop") return report;
	const accepted = runApplyOps(state);
	settleApply(state, accepted);
	return report;
}

export function scanConflicts(source: string, agentDir: string): ConflictScan {
	const opts: ApplyOptions = { source, agentDir, previousCommit: undefined, check: true, plugins: false };
	const report = newReport();
	try {
		const base = BaseRecord.load(agentDir);
		const history = new RepoHistory(source, false);
		const exclusions = exclusionsOf(settingsPreflight({ ...opts, plugins: true }, base, history), agentDir);
		const sources = parseSources(opts, report);
		const required = declaredPlugins(source).required;
		const ctx: PlanContext = {
			opts,
			report,
			base,
			history,
			todoRequired: required.includes(TODO_PLUGIN_URL),
			forkRequired: required.some(requiresForkPlugin),
			freshMachine: freshMachine(agentDir, base),
			replacementMigration: planReplacementMigration(opts, report, base, history, exclusions),
			exclusions,
		};
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
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
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

function fenced(value: unknown): string {
	return value === undefined ? "  (absent)" : `  \`\`\`json\n${JSON.stringify(value, null, 2).replace(/^/gm, "  ")}\n  \`\`\``;
}

function conflictDetail(conflict: Conflict, source: string, base: BaseRecord): string[] {
	const incoming = join(source, conflict.rel);
	switch (conflict.kind) {
		case "file": {
			const recorded = base.plain(conflict.rel);
			const basePath = recorded.kind === "known" ? base.plainPath(conflict.rel) : `(${recorded.kind}: compare local and incoming directly)`;
			const lines = [
				`## ${conflict.id}`,
				`- reason: ${conflict.reason}`,
				`- local: ${existsSync(conflict.target) ? conflict.target : `(deleted locally) ${conflict.target}`}`,
				`- base: ${basePath}`,
				`- incoming: ${existsSync(incoming) ? incoming : "(removed upstream)"}`,
			];
			if (recorded.kind === "known" && existsSync(conflict.target) && existsSync(incoming))
				lines.push(`- merge proposal with conflict markers: git merge-file -p "${conflict.target}" "${basePath}" "${incoming}"`);
			return lines;
		}
		case "key": {
			const format = STRUCTURED.find((item) => item.rel === conflict.rel)?.format ?? "yaml";
			const local = existsSync(conflict.target) ? parseStructured(readFileSync(conflict.target, "utf8"), format) : undefined;
			const repo = parseStructured(readFileSync(incoming, "utf8"), format);
			const record = base.structuredOf(conflict.rel);
			const baseLine =
				conflict.reason === "unknown-base" || record === undefined
					? "- base: (unknown: compare local and incoming directly)"
					: `- base:\n${fenced(valueAt(record.value, conflict.path))}`;
			return [
				`## ${conflict.id}`,
				`- reason: ${conflict.reason}`,
				`- file: ${conflict.target}`,
				`- key: ${conflict.path.map((key) => JSON.stringify(key)).join(" › ")}`,
				`- local:\n${fenced(valueAt(local, conflict.path))}`,
				baseLine,
				`- incoming (${incoming}):\n${fenced(valueAt(repo, conflict.path))}`,
			];
		}
		default: {
			const unreachable: never = conflict;
			throw new Error(String(unreachable));
		}
	}
}

function conflictsText(conflicts: readonly Conflict[], source: string, agentDir: string): string {
	if (conflicts.length === 0) return `omp-config: no conflicts between local customizations and ${source}.`;
	const resolveCommand = `bun "${import.meta.path}" resolve --source "${source}" --agent-dir "${agentDir}" <id>…`;
	const base = BaseRecord.load(agentDir);
	return [
		`# omp-config: local customizations that conflict with upstream (${conflicts.length})`,
		"",
		`Upstream source: ${source}. Agent dir: ${agentDir}. Each local copy was kept as it is.`,
		"",
		"Adapt them with the user, one at a time:",
		"1. Read the local copy, the base and the incoming version listed for the conflict. Base → incoming is what upstream changed; base → local is what this machine changed. With an unknown base, compare local and incoming directly.",
		"2. Explain both changes in one sentence each. Then use `ask`: keep local, take incoming, or a merged version you propose and show. Recommend the merge when both changes can coexist.",
		"3. Apply the choice to the local file with `edit`. In config.yml change only the conflicting key and keep comments and other keys. Keeping local needs no edit.",
		`4. Record the adapted conflicts: ${resolveCommand}`,
		"   A refused (stale) id means upstream moved meanwhile: list the conflicts again and adapt the new version.",
		"5. Report what each conflict became. Extension code, system prompt files and tool topics load on the next OMP start; config.yml reloads live.",
		"",
		...conflicts.flatMap((conflict) => [...conflictDetail(conflict, source, base), ""]),
	].join("\n");
}

export interface ResolveOutcome {
	readonly resolved: string[];
	readonly stale: string[];
	readonly unknown: string[];
	readonly errors: string[];
}

function resolveConflicts(source: string, agentDir: string, ids: readonly string[]): ResolveOutcome {
	const outcome: ResolveOutcome = { resolved: [], stale: [], unknown: [], errors: [] };
	const scan = scanConflicts(source, agentDir);
	if (scan.kind === "failed") {
		outcome.errors.push(scan.error);
		return outcome;
	}
	const base = BaseRecord.load(agentDir);
	const changes: BaseChange[] = [];
	const records = new Map<string, { value: Mapping; unknown: Path[] }>();
	for (const id of ids) {
		const conflict = scan.conflicts.find((candidate) => candidate.id === id);
		if (conflict === undefined) {
			const stem = id.slice(0, id.lastIndexOf("@"));
			(scan.conflicts.some((candidate) => candidate.id.slice(0, candidate.id.lastIndexOf("@")) === stem)
				? outcome.stale
				: outcome.unknown
			).push(id);
			continue;
		}
		const incoming = join(source, conflict.rel);
		switch (conflict.kind) {
			case "file":
				changes.push(
					existsSync(incoming)
						? { kind: "plain-known", rel: conflict.rel, content: readFileSync(incoming) }
						: { kind: "plain-drop", rel: conflict.rel },
				);
				break;
			case "key": {
				const recorded = base.structuredOf(conflict.rel);
				const record =
					records.get(conflict.rel) ?? (recorded && { value: structuredClone(recorded.value), unknown: [...recorded.unknown] });
				if (record === undefined) {
					outcome.errors.push(`${id}: no base recorded for ${conflict.rel} yet; run apply first`);
					continue;
				}
				const format = STRUCTURED.find((item) => item.rel === conflict.rel)?.format ?? "yaml";
				setAt(record.value, conflict.path, valueAt(parseStructured(readFileSync(incoming, "utf8"), format), conflict.path));
				record.unknown = record.unknown.filter((path) => !related(path, conflict.path));
				records.set(conflict.rel, record);
				break;
			}
			default: {
				const unreachable: never = conflict;
				throw new Error(String(unreachable));
			}
		}
		outcome.resolved.push(id);
	}
	for (const [rel, record] of records) changes.push({ kind: "structured", rel, record });
	base.commit(changes);
	return outcome;
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
		else process.stdout.write(`${scan.kind === "scanned" ? conflictsText(scan.conflicts, from, agentDir) : `error: ${scan.error}`}\n`);
		return scan.kind === "scanned" ? 0 : 1;
	}
	if (mode === "resolve") {
		if (ids.length === 0) usage();
		if (!acquireLock()) {
			process.stderr.write(`another update holds ${LOCK_DIR}; retry later\n`);
			return 1;
		}
		try {
			const outcome = resolveConflicts(source ?? CLONE_DIR, agentDir, ids);
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
