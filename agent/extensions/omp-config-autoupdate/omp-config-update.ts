#!/usr/bin/env bun

// ============================================================================
// omp-config-update — apply the omp-config repo snapshot to an OMP agent dir.
// Lives in extensions/omp-config-autoupdate/ beside the extension that spawns
// it; it is a standalone Bun script, not an extension module (not index.ts).
//
// ENTRY POINTS.
//   auto      Run by the omp-config-autoupdate extension at OMP start when the
//             machine's switch is on (`/omp-config-autoupdate on`; off by
//             default). Refreshes the updater-owned clone (~/.omp/omp-config-src)
//             from origin, and applies only when the fetch succeeds and its
//             commit differs from the commit last applied to this agent dir
//             (`<agent dir>/.omp-config-applied`). A failed fetch (offline)
//             applies nothing: the clone is a copy of origin as of the last
//             fetch, never a stand-in for it. A clone of a previous repo
//             location (PREVIOUS_REPO_URLS) is repointed to REPO_URL first;
//             any other origin is left untouched and reported.
//             The apply code is imported from the freshly fetched clone, so a
//             commit that changes apply rules is applied by its own rules.
//             An unchanged commit still refreshes the plugins whose GitHub
//             source moves on its own (see PLUGINS) and re-scans conflicts.
//   apply     Run by /update-omp against a working checkout (`--source`).
//             `--check` reports without writing.
//   conflicts Lists the current conflicts against `--source` (default: the
//             updater clone) with the adaptation procedure; read-only.
//   resolve   Records listed conflicts as adapted: their base becomes the
//             source's current value. Stale ids (the source moved) are refused.
//
// OWNERSHIP. The repo ships the managed items listed in `managedPlain` and
// `STRUCTURED`. Every structured path has one owner rule:
//   - LOCAL_* paths are the machine's: never written, seeded or removed;
//   - SEED_* paths are written only while the host lacks them (a first
//     install gets the repo default), then belong to the machine;
//   - MACHINE_LIST_FIELDS keep the host's own entries ahead of the repo's;
//   - every other repo path is managed (see CUSTOMIZATIONS).
// Agent definitions (MACHINE_OWNED_PLAIN, agents/*.md) are machine-level user
// settings: the repo's copy is a default seeded while the rel has no record.
// After that an unmodified copy still follows the repo (upstream edits and
// drops apply, which is how repo-side renames propagate), a machine-modified
// copy always wins without merge or conflict, and a rel absent with a
// recorded base — removed or renamed by the machine — is never re-created.
// /sync-omp-config never pulls them into the repo.
// Shipped APPEND-SYSTEM-*.md, PROMPT-INJECT-*.md, TURN-JUDGE-*.md and
// REPLACE-SYSTEM-*.yml/.yaml rule files are managed templates; additional host
// files stay machine-owned. Edits to APPEND-SYSTEM and REPLACE-SYSTEM files
// take effect on the next prompt or tool call, TURN-JUDGE files on the next
// turn, and PROMPT-INJECT files in the next subagent started.
// Untouched by every rule: keys and files the repo never had, app-managed
// files (`// @orca-managed-pi-extension` first line, or the Otty marker
// anywhere; see OTTY_MARKER), runtime state. A symlinked target is written
// through to its resolved file. The machine's own `omp-config-autoupdate.exclude`
// setting (see EXCLUSIONS) overrides every rule below for the items it names.
//
// EXCLUSIONS. The machine lists items the updater never writes, creates or
// deletes in the plugin setting `omp-config-autoupdate.exclude` of `omp-config`
// (whitespace-separated; the machine's, the repo never ships a value), read
// through `omp plugin config list`; until the SETTINGS step moved it, the list
// still in the omomp section counts. Entries are agent-dir relative plain
// paths or globs (`agents/task-high.md`, `extensions/foo/**`; a literal name
// covers its subtree, so `config.yml` excludes the whole file), for config.yml
// `config.yml:<dotted path>` (`config.yml:task.agentModelOverrides`), and
// `omomp.yml:<section>`, which keeps that section out of the SETTINGS move. An
// invalid option — two omomp copies of the section, a malformed entry — stops
// the whole apply like every other preflight error. Excluded items keep their
// host copy and their recorded base and are reported under `skipped`;
// excluding the updater itself is only ever visible through that report.
// Excluded structured paths merge like `local` ones (machine-owned),
// relocation and retirement ops that touch an excluded path are dropped as
// whole operations, and a final invariant check aborts the apply if any
// planned op still touches one.
//
// SETTINGS. The extensions' settings are OMP plugin settings of the local
// plugin `omp-config`, whose manifest is the managed
// `extensions/_shared/package.json`. After every file operation succeeded,
// apply links that directory (`omp plugin link`) unless OMP already lists the
// plugin (registered elsewhere: left alone with a note). Then the omp-config
// sections of the machine's omomp file (and of the standalone JSON files that
// held them before it) move out (omomp-migration.ts): a value becomes a plugin
// setting only when the machine has not set that key and it differs from the
// manifest default; list data goes where it now lives (task-split-check
// agents → `splitCheck: true` in agents/*.md, model-compaction rules →
// `extensions/model-compaction/COMPACTION-rule-NN.md`, tool-topic-injection
// rules → dropped only when equal to what the repo shipped, since the TOPIC
// files carry them); `judge.fallbackRole` is dropped and every other
// `fallbackRole` becomes `modelRoles.<role>: "@<fallbackRole>"` in config.yml
// for each role it backed that the machine left unassigned. The `omp plugin`
// CLI runs from `/`, so a project's plugin-overrides.json never hides the
// machine's values. A section leaves the file only after OMP lists each of its
// values and config.yml holds each binding; sections of other owners (omp-unified-exec) stay, and the file is
// deleted once nothing is left in it. Invalid, ambiguous or blocked sections
// stay with a note; nothing here stops the apply. `--check` and
// `--no-plugins` never ask OMP to change anything and only report the move.
//
// CUSTOMIZATIONS. A managed item other than machine-owned agent definitions
// (MACHINE_OWNED_PLAIN, see OWNERSHIP) is merged three-way: host H, base B
// (the repo content this machine last accepted, recorded under BASE_DIR; see
// base.ts) and repo R. H==R or H==B takes R; R==B keeps H; text files
// changed on both sides go through `git merge-file`, and a clean merge is
// written. Anything
// else is a conflict: H and B stay as they are, so the next run finds the
// conflict again until H converges to R or `resolve` moves B to R.
// Structured files merge per path (merge.ts). Code (`*.ts`, the updater
// included) stays repo-wins: R is written and a customized H is listed in
// `overwritten`. An item without a base takes it from the repo's history: a
// host copy equal to any committed version is unmodified; one equal to none
// gets an unknown base and conflicts until resolved. A machine the updater
// never ran on (no base record and no installed updater, see freshMachine)
// has received no repo content: its structured files, written by OMP's own
// first-run setup or by the user, are merged against an empty base, so every
// managed key the host lacks is written and a host value that differs from
// the repo is a conflict. Conflicts are not errors. `conflicts` prints them
// with the adaptation procedure; `resolve` accepts them after the host copy
// was adapted.
//
// DELETIONS. An item the base has and the source dropped is deleted when the
// host copy is unmodified (code: always), else it conflicts; a machine-owned
// agent definition that was modified is kept instead (see OWNERSHIP). Items
// dropped
// before this machine had a base use `git diff previousCommit HEAD` when the
// caller passes the previous commit. The finite TODO_RETIREMENTS are
// different: when the source declares the independent Todo plugin, both modes
// retire those exact leaves after the OMP owner confirms plugin readiness,
// even on first apply or without history. CTX_RETIREMENTS (the ctx leaves the
// Todo plugin now ships) are inspected in the same preflight, but deleted only
// when the ready plugin carries src/ctx; until then the old leaves stay.
//
// RELOCATIONS. Both modes, planned like every other op. Earlier layouts kept
// extensions flat (extensions/<name>.ts) and their files at the agent root.
//   - A file SUPERSEDED by one the source ships is deleted: a flat module
//     would load beside its directory version (two modules, one extension
//     id), the agent-root updater is replaced by the copy in
//     extensions/omp-config-autoupdate/, and read-topics/index.ts would
//     contest tool://read with the tool-topics extension that now owns it.
//     An app-managed one is reported as an error instead.
//     Every legacy source below that is app-managed stays in place and is
//     skipped or blocks its migration; it is never imported or deleted.
//   - The omp-config sections of the omomp file and their old standalone JSON
//     files move into plugin settings; see SETTINGS.
//   - The former system-prompt-replace section (or its standalone JSON) is
//     removed when it matches this machine's accepted structured base, or a
//     committed repo version if no base exists. The shipped REPLACE-SYSTEM
//     default then installs as a normal managed template. Only customized host
//     rules are converted into the destination's normal managed-template merge.
//     Successful migration removes only that omomp.yml section and legacy JSON.
//     Occupied destinations, invalid custom data, ambiguous layouts and other
//     omomp formats stay in place with a note; the default template is not
//     installed while such a migration is blocked.
//   - DATA_MOVES split the host's old APPEND_SYSTEM_MODEL.md (at the agent
//     root or beside append-system-model) into APPEND-SYSTEM-model-NN.md files
//     in block order, with target: * preserving main/subagent scope. Every
//     block and destination is checked before writing; malformed inputs or
//     occupied destinations leave the old file in place with a note.
//     Other data moves carry agent-root data into its extension directory:
//     host files move only to free paths; a repo template (shipped now or by
//     the previous commit) is deleted as the source writes or dropped it when
//     it equals a version the repo shipped or this machine accepted at its old
//     or new path; a customized one stays in place with a note to port it.
//     Symlinks are never moved, only noted.
//   - Retired config.yml list entries (RETIRED_LIST_ENTRIES) are dropped.
//
// SAFETY. Parse and plan all source/host inputs and retirement ownership before
// plugin installation or file writes. Preflight errors stop the whole apply.
// Install and upgrade plugins, then freshly query OMP for the required Todo entry;
// failed readiness leaves all managed file operations unapplied. `--check`
// only reports candidates, conflicts and prerequisites: it writes no file, no
// base and fetches no history. Writes use a temp file and rename.
// Order after readiness: moves, plain files, structured files, deletions, then
// the base of every item whose host operation succeeded.
// Any move/write error prevents the deletion phase entirely.
// Automatic markers are written last after an error-free apply; manual apply
// never records a working-tree HEAD but does record the base, so a later
// commit that differs from the working tree updates unmodified items again.
// Partial cutover errors require a rerun before restart. A lock dir
// (~/.omp/omp-config-update.lock) keeps concurrent OMP starts, /update-omp and
// `resolve` from refreshing, applying or recording at once; the loser skips.
// The lock records its holder's pid: a dead holder's lock is taken over, and a
// process only releases a lock it holds.
//
// PLUGINS. Every required entry of install-plugins.sh (an uncommented quoted
// line) runs through `omp install` before managed file operations: missing
// ones are installed, installed ones are re-resolved (npm to the latest
// version, GitHub URLs to the default branch's head). A plugin counts as
// changed when ~/.omp/plugins/bun.lock or omp-plugins.lock.json changes; a
// change sets restartNeeded. A failed install or upgrade is an error and stops
// the apply before file operations. Packages are never enabled or disabled here.
// When `auto` finds the config commit unchanged it still refreshes plugins
// whose source moves on its own: every unpinned (no `#ref`) GitHub URL among
// the required entries and the installed optional ones (a comment line holding
// only a source). An installed plugin matches a declared GitHub URL by its
// owner/repo in any form omp records (`github:`, https or git URL). The same
// `omp install` re-resolves each one, so the plugin
// manager, not this script, decides whether the default branch moved; npm
// entries and pinned URLs wait for the next config commit. The result rides on
// `up-to-date`; a failed install is reported there and never touches the marker.
// Todo handover requires a fresh enabled npm catalog entry, its declared root
// entry and the actual file. No plugin internals or Tern catalog are imported here.
// Nothing is uninstalled; /update-omp handles uninstall candidates.
// ============================================================================

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
/** Origins of updater clones made before the repo moved to oh-my-omp; repointed to REPO_URL on the next fetch. */
const PREVIOUS_REPO_URLS: readonly string[] = ["https://github.com/mouriya-s-lab/omp-config.git"];
export const DEFAULT_BRANCH = "main";
export const APPLIED_MARKER = ".omp-config-applied";

/**
 * config.yml paths owned by each machine, OMP or the user's own consent:
 * never written from the repo, never seeded, never removed.
 * /sync-omp-config never copies them into the repo.
 */
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

/**
 * config.yml paths whose repo value is a starting default: written while the
 * host lacks them, then the machine's. /sync-omp-config never copies them.
 */
export const SEED_CONFIG_FIELDS: readonly string[] = [
	"browser",
	"composer",
	"cycleOrder",
	"task.maxConcurrency",
	"task.agentModelOverrides",
	"retry.fallbackChains",
];

/**
 * config.yml lists shared by repo and machine: entries the repo lists (or its
 * base listed) are the repo's subsequence, merged three-way as one value;
 * other entries belong to the machine and stay ahead of the repo's.
 * /sync-omp-config never writes machine entries into the repo.
 */
export const MACHINE_LIST_FIELDS: readonly string[] = ["extensions", "disabledProviders"];

/**
 * Entries earlier repo versions put in a MACHINE_LIST_FIELDS list and later
 * replaced. A machine without a base cannot tell them from its own entries,
 * so they are named explicitly and dropped on every apply.
 */
const RETIRED_LIST_ENTRIES: Readonly<Record<string, readonly string[]>> = {
	extensions: ["~/.omp/agent/extensions-last/system-prompt-replace.ts"],
};

/** Where this script lives, relative to the agent dir (and to `agent/` in the repo). */
const UPDATER_REL = "extensions/omp-config-autoupdate/omp-config-update.ts";
/** Where layouts before the extension directory kept this script. */
const LEGACY_UPDATER_REL = "omp-config-update.ts";

const TODO_PLUGIN_URL = "https://github.com/oh-my-omp/omp-todo-more";
const TODO_PLUGIN_NAME = "omp-todo-more";
/** Exact legacy leaves; directories, interior links and neighboring host files are not retirement targets. */
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

/** ctx leaves the Todo plugin now ships under src/ctx; retired only once the ready plugin carries them. */
const CTX_RETIREMENTS: readonly string[] = [
	"extensions/ctx-tool/index.ts",
	"extensions/ctx-tool/inventory.ts",
	"extensions/ctx-tool/post-compact-hint.ts",
	"extensions/ctx-tasklog/index.ts",
	"extensions/_shared/task-log.ts",
];

/** Files of earlier layouts (agent-dir relative) and the file that replaced each. */
const SUPERSEDED: readonly { readonly from: string; readonly by: string }[] = [
	...[
		"append-system-model",
		"doc-polish",
		"fork-task",
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

/**
 * Data from earlier layouts (agent-dir relative). `host` files are the
 * machine's; `template` files are the repo's
 * when the source ships the new path or the previous commit shipped the old
 * one, and the machine's otherwise. A `pattern` matches names at the agent root.
 */
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

/** The machine's omomp file: no longer managed; its omp-config sections move out (see SETTINGS). */
const OMOMP_REL = "agent/omomp.yml";

/** Structured files. */
const STRUCTURED: readonly StructuredItem[] = [
	{
		rel: "agent/config.yml",
		format: "yaml",
		rules: { local: LOCAL_CONFIG_FIELDS, seed: SEED_CONFIG_FIELDS, machineLists: MACHINE_LIST_FIELDS, retired: RETIRED_LIST_ENTRIES },
	},
];

/**
 * Agent definitions the repo ships as defaults: seeded while the rel has no
 * base record, then the machine's (see OWNERSHIP). agents/*.txt are not agent
 * definitions — non-agent notes stay managed.
 */
const MACHINE_OWNED_PLAIN = /^agent\/agents\/[^/]+\.md$/;

/**
 * Repo files copied verbatim. `rel` uses `/` separators. Inside an extension
 * directory only modules and shipped templates are the repo's; any other file
 * there (settings, switches, the machine's own templates) is the host's.
 * MACHINE_OWNED_PLAIN paths match too: shipped files still plan through
 * `planPlainItem`, which keeps the machine's copy once a base is recorded.
 */
function managedPlain(rel: string): boolean {
	if (rel.split("/").some((part) => part.startsWith("."))) return false;
	return (
		/^agent\/(SYSTEM_TEMPLATE|APPEND_SYSTEM|APPEND_SYSTEM_LIGHT|PERSONALITY)\.md$/.test(rel) ||
		/^agent\/(config-light\.yml|omp-light\.ts)$/.test(rel) ||
		/^agent\/agents\/.+$/.test(rel) ||
		/^agent\/(extensions|extensions-last)\/[^/]+\/[^/]+\.ts$/.test(rel) ||
		/^agent\/extensions\/append-system-model\/APPEND-SYSTEM-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions-last\/system-prompt-replace\/REPLACE-SYSTEM-[^/]+\.ya?ml$/.test(rel) ||
		/^agent\/extensions\/user-prompt-inject\/PROMPT-INJECT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/turn-judge\/TURN-JUDGE-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-policy-nag\/INTENT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md$/.test(rel) ||
		rel === "agent/extensions/argon-long-output/ARGON_PROMPT.md" ||
		rel === `agent/${PLUGIN_DIR}/package.json`
	);
}

/** Extension code and the tool-topics files it loads at start take effect on the next start; the updater script itself runs fresh each time. */
const RESTART_SCOPED =
	/^agent\/(SYSTEM_TEMPLATE\.md|APPEND_SYSTEM\.md|PERSONALITY\.md|extensions\/.+\.ts|extensions-last\/.+\.ts|extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md)$/;

// --- exclusions ---------------------------------------------------------------

/**
 * The machine's own `omp-config-autoupdate.exclude` setting (plugin settings
 * of `omp-config`, whitespace-separated; until the omomp migration moved it,
 * the list still in the omomp section): items the updater never writes,
 * creates or deletes. Plain entries are agent-dir relative paths or globs
 * (`agents/task-high.md`, `extensions/foo/**`, and a literal directory or file
 * name covers everything under it, so `config.yml` excludes the whole
 * structured file too); `<file>:<dotted.path>` excludes a field path inside a
 * structured file (`config.yml:task.agentModelOverrides`), and
 * `omomp.yml:<section>` keeps that omomp section out of the migration. The
 * setting is the machine's: the repo never writes it and /sync-omp-config never
 * carries it. Excluded items keep their host copy and their recorded base
 * untouched and are reported under `skipped`; the updater itself is only ever
 * excluded visibly, through the same report.
 */

/** `field` names `path` or one of its ancestors; same contract as the `local` rule in merge.ts. */
function coversPath(field: Path, path: Path): boolean {
	return field.length <= path.length && field.every((part, index) => part === path[index]);
}

type ExcludeEntry =
	| { readonly kind: "plain"; readonly match: (leaf: string) => boolean }
	| { readonly kind: "field"; readonly item: string; readonly path: Path };

interface Exclusions {
	readonly entries: readonly ExcludeEntry[];
	/** Structured rel (`agent/config.yml`) → excluded field paths. */
	readonly fields: ReadonlyMap<string, readonly Path[]>;
}

/** Glob characters Bun.Glob treats as magic; a pattern without any matches literally and covers its subtree. */
const GLOB_MAGIC = /[*?[\]{}!\\]/;

/**
 * Validated exclude entries; `origin` names where they came from in errors.
 * Entries normalize `agent/` prefixes and reject absolute paths, `..` and
 * empty segments; `file:path` entries require a managed structured file or
 * the omomp file. Anything invalid throws: an ambiguous option applies nothing.
 */
function parseExclusions(raw: readonly string[], origin: string): Exclusions {
	/** One exclude operand as an agent-dir relative path: `agent/` dropped, root, `..` and empty segments refused. */
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

/** `rel` (`agent/…`) is excluded by a plain entry: a literal pattern covers itself and its whole subtree. */
function plainRelExcluded(rel: string, exclusions: Exclusions): boolean {
	const leaf = rel.slice("agent/".length);
	return exclusions.entries.some((entry) => entry.kind === "plain" && entry.match(leaf));
}

/** `path` inside the structured file `item` lies at or under an excluded field. */
function fieldExcluded(item: string, path: Path, exclusions: Exclusions): boolean {
	return (exclusions.fields.get(item) ?? []).some((field) => coversPath(field, path));
}

/** Report `rel` as excluded and return true; call sites drop the operation. */
function skipExcluded(ctx: PlanContext, rel: string): boolean {
	if (!plainRelExcluded(rel, ctx.exclusions)) return false;
	ctx.report.skipped.push({ path: targetOf(rel, ctx.opts.agentDir), reason: EXCLUDED_REASON });
	return true;
}

const EXCLUDED_REASON = "excluded by the machine (omp-config-autoupdate.exclude)";

/**
 * Invariant over the finished plan: no op may write, create, move or delete an
 * excluded path. A violation is a planner bug, so this throws and aborts the
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

// --- report -----------------------------------------------------------------

export interface ApplyOptions {
	readonly source: string;
	readonly agentDir: string;
	/** Commit last applied to agentDir; lets items dropped before this machine had a base be deleted. */
	readonly previousCommit: string | undefined;
	readonly check: boolean;
	readonly plugins: boolean;
}

/**
 * One managed item (file) or structured path (key) where host and repo both
 * moved away from the base, or the base is unknown. `id` names it for
 * `resolve` and changes when the repo value changes, so a stale id is refused.
 */
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
	/** RELOCATIONS: host files moved or split into their new paths. */
	readonly moved: { from: string; to: string }[];
	readonly deleted: string[];
	readonly skipped: { path: string; reason: string }[];
	readonly errors: string[];
	readonly notes: string[];
	readonly pluginsInstalled: string[];
	readonly pluginsUpgraded: string[];
	readonly pluginsMissing: string[];
	/** Versions behind pluginsInstalled/pluginsUpgraded, for display; added later, so readers default it to []. */
	readonly pluginChanges: PluginChange[];
	/** Customizations kept against an upstream change; added later, so readers default it to []. */
	readonly conflicts: Conflict[];
	/** Customized code files the repo replaced (code is repo-wins); added later, so readers default it to []. */
	readonly overwritten: string[];
	restartNeeded: boolean;
}

/** One plugin `omp install` installed or moved: versions from omp-plugins.lock.json, `from` null when newly installed. */
export interface PluginChange {
	readonly spec: string;
	readonly name: string;
	readonly from: string | null;
	readonly to: string | null;
}

/** Outcome of one `omp install` pass over a list of plugin specs. */
export interface PluginRefresh {
	readonly installed: string[];
	readonly upgraded: string[];
	readonly errors: string[];
	readonly changes: PluginChange[];
}

/** A read-only conflict scan: what is pending, or why it could not be told. */
export type ConflictScan =
	| { readonly kind: "scanned"; readonly conflicts: Conflict[] }
	| { readonly kind: "failed"; readonly error: string };

export type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string; readonly plugins: PluginRefresh; readonly scan: ConflictScan }
	| { readonly kind: "applied"; readonly commit: string; readonly previous: string | undefined; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

// --- small helpers ----------------------------------------------------------

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
	// Bun.YAML.stringify leaves "key: " before nested blocks; drop that space. The
	// round-trip check below rejects the result if this ever changes a value.
	const text = format === "json" ? `${JSON.stringify(value, null, 2)}\n` : Bun.YAML.stringify(value, null, 2).replace(/:[ ]+$/gm, ":");
	const back = parseStructured(text, format);
	if (!Bun.deepEquals(back, value)) throw new Error("serialized form does not round-trip");
	return text.endsWith("\n") ? text : `${text}\n`;
}

function targetOf(rel: string, agentDir: string): string {
	if (rel.startsWith("agent/")) return join(agentDir, rel.slice("agent/".length));
	throw new Error(`no target for ${rel}`);
}

/**
 * Otty's "marker" + ": _otty" tag, assembled so the literal never appears in
 * this file: the check matches anywhere, and this file is itself managed.
 */
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

/**
 * Resolve a symlinked target to the file it points at, so the link survives.
 * A dangling link resolves through readlink, so writing recreates its target.
 */
function writePath(target: string): string {
	let link = false;
	try {
		link = lstatSync(target).isSymbolicLink();
	} catch {
		// Missing target: write it in place.
	}
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

// --- plan -------------------------------------------------------------------

/** A host operation; `base` is recorded once it succeeded. A `base` op only records. */
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
	/** No repo content ever reached this agent dir; see freshMachine. */
	readonly freshMachine: boolean;
	readonly replacementMigration: ReplacementMigration;
	/** The machine's `omp-config-autoupdate.exclude` entries; read before planning (see the exclusions block). */
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
			/** The omomp base record without the moved section, so a later copy of it is never mistaken for accepted repo content. */
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
	// The migration is one operation (destination write, section removal,
	// legacy deletion); an excluded path or the removed field leaves all of it
	// in place, reported like any other excluded item.
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

/** One destination write, followed by section/legacy cleanup, with bases accepted only after all succeed. */
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
	// planPlain always emits the final destination write before the structured cleanup.
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

/**
 * The updater never ran on this agent dir: no base record and no updater at
 * its current or legacy path. Every apply, auto run or plain copy of `agent/`
 * installs the updater, so without both traces the structured files present
 * come from OMP's first-run setup or the user, never from the repo.
 */
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

/** Short content digest for conflict ids: it changes whenever the repo side changes. */
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
	return files.sort();
}

type TextMerge = { readonly kind: "clean"; readonly content: Buffer } | { readonly kind: "conflict" };

/** `git merge-file` of host and repo against the base; overlapping or binary changes conflict. */
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

/**
 * One managed plain file (see CUSTOMIZATIONS). `repo` undefined: the source
 * dropped it. `dropped`: its content at the previous commit, standing in for a
 * base this machine never recorded.
 */
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
		// Record what the conflict was found against, so it is found again on the next run.
		if (recorded.kind !== "none") return [];
		const change: BaseChange = dropped !== undefined ? { kind: "plain-known", rel, content: dropped } : { kind: "plain-unknown", rel };
		return [{ kind: "base", rel, change }];
	};
	// Machine-owned agent definitions (see OWNERSHIP): seeded while the rel has
	// no record; an unmodified copy follows the repo, a machine-modified copy
	// always wins without merge or conflict, and a recorded rel the machine
	// removed or renamed is never re-created.
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
		// First sight of a rel the machine (or an earlier apply) left behind:
		// record its presence so a later local removal stays removed.
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

/** Todo/ctx leaves have their own retirement planner (see DELETIONS). */
function retiring(ctx: PlanContext, rel: string): boolean {
	const leaf = rel.slice("agent/".length);
	return (ctx.todoRequired && TODO_RETIREMENTS.includes(leaf)) || CTX_RETIREMENTS.includes(leaf);
}

function planPlain(ctx: PlanContext): Op[] {
	const { opts } = ctx;
	const shipped = listSourceFiles(opts.source).filter(
		(rel) => !(ctx.todoRequired && TODO_RETIREMENTS.includes(rel.slice("agent/".length))),
	);
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
	// A working snapshot can omit the shipped template; conversion still preserves host rules.
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
		// A rel no longer managed stays the host's, and retired leaves have their own planner: only the record goes.
		if (!managedPlain(rel) || retiring(ctx, rel)) ops.push({ kind: "base", rel, change: { kind: "plain-drop", rel } });
		else ops.push(...planPlainItem(ctx, rel, undefined));
	}
	for (const [rel, content] of droppedBeforeBase(ctx))
		if (!known.has(rel) && !skipExcluded(ctx, rel)) ops.push(...planPlainItem(ctx, rel, undefined, content));
	// Machine-authored agent definitions the repo never shipped: record their
	// presence too, so removing one stays removed if the repo ever ships the name.
	try {
		for (const entry of readdirSync(join(opts.agentDir, "agents"), { withFileTypes: true })) {
			const rel = `agent/agents/${entry.name}`;
			if (!entry.isFile() || known.has(rel) || entry.name.startsWith(".") || !MACHINE_OWNED_PLAIN.test(rel) || skipExcluded(ctx, rel))
				continue;
			const target = targetOf(rel, opts.agentDir);
			if (isAppManaged(target) || ctx.base.plain(rel).kind !== "none") continue;
			ops.push({ kind: "base", rel, change: { kind: "plain-unknown", rel } });
		}
	} catch {
		// No agents directory (or unreadable): nothing to record.
	}
	return ops;
}

type StructuredSource = { readonly item: StructuredItem; readonly text: string; readonly repo: Mapping };

/** Parse every structured source before anything is written: one invalid source aborts the whole apply. */
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

/** Every committed version of a structured file that still parses: the history a missing base is matched against. */
function structuredHistory(history: RepoHistory, item: Pick<StructuredItem, "rel" | "format">): Mapping[] {
	const versions: Mapping[] = [];
	for (const text of history.versions(item.rel)) {
		try {
			versions.push(parseStructured(text, item.format));
		} catch {
			// A version that never parsed was never applied: it cannot be a base.
		}
	}
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
		// An excluded field merges like a `local` one (machine-owned, never
		// written); its recorded base and unknown marks are restored afterward so
		// removing the entry later resumes from the old base, not a new conflict.
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
		// Keep the repo's own formatting whenever the result is exactly the repo file.
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

/** Reused immediately before unlink: a long owner installation cannot authorize a changed filesystem object. */
function inspectTodoRetirement(agentDir: string, rel: string): RetirementInspection {
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
		// Only an existing leaf is reported; absent ones have nothing to keep.
		if (!lexists(join(opts.agentDir, rel)) || skipExcluded(ctx, `agent/${rel}`)) continue;
		const inspected = inspectTodoRetirement(opts.agentDir, rel);
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

/** True when the previous applied commit had `rel`; always false in manual apply. */
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
		// The split is one operation: an excluded source or fragment target keeps everything in place.
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

/** SUPERSEDED and DATA_MOVES as ops (see RELOCATIONS in the header). */
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
					// No agent dir yet: nothing to move.
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
			// An unmodified old copy: the source writes the new copy, or dropped the template, so it has no owner left.
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

/** The old-layout template equals a version the repo shipped or this machine accepted, at either its old or its new path. */
function shippedTemplateCopy(ctx: PlanContext, from: string, to: string, content: Buffer): boolean {
	return [`agent/${from}`, `agent/${to}`].some((rel) => {
		const recorded = ctx.base.plain(rel);
		if (recorded.kind === "known" && recorded.content.equals(content)) return true;
		const current = join(ctx.opts.source, rel);
		if (existsSync(current) && readFileSync(current).equals(content)) return true;
		return ctx.history.hasVersion(rel, content);
	});
}

/**
 * Managed files the source dropped between the previous commit and HEAD, with
 * their content at the previous commit: the base of items deleted before this
 * machine recorded one. Empty without a previous commit.
 */
function droppedBeforeBase(ctx: PlanContext): Map<string, Buffer> {
	const { opts, report } = ctx;
	const dropped = new Map<string, Buffer>();
	if (opts.previousCommit === undefined) return dropped;
	// -z: NUL-separated, unquoted paths (non-ASCII names are C-quoted otherwise).
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

// --- light launcher -----------------------------------------------------------

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
	const windows = process.platform === "win32";
	const wanted: { path: string; content: string | Uint8Array; mode: number | undefined }[] = windows
		? [
				{ path: join(binDir, "omp-light.ts"), content: script, mode: undefined },
				{ path: join(binDir, "omp-light.cmd"), content: '@echo off\r\nbun "%~dp0omp-light.ts" %*\r\n', mode: undefined },
			]
		: [{ path: join(binDir, "omp-light"), content: script, mode: 0o755 }];
	for (const file of wanted) {
		const bytes = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
		const same =
			existsSync(file.path) &&
			Buffer.from(readFileSync(file.path)).equals(bytes) &&
			(file.mode === undefined || (statSync(file.path).mode & 0o777) === file.mode);
		if (same) continue;
		if (opts.check) {
			report.written.push(file.path);
			continue;
		}
		try {
			atomicWrite(file.path, bytes, file.mode);
			report.written.push(file.path);
		} catch (error) {
			report.errors.push(`${file.path}: ${errorText(error)}`);
		}
	}
	const resolved = Bun.which("omp-light");
	const expected = wanted[windows ? 1 : 0]!.path;
	if (!opts.check && resolved && resolve(resolved).toLowerCase() !== expected.toLowerCase()) {
		report.notes.push(`omp-light on PATH resolves to ${resolved}, not ${expected} (PATH shadowing)`);
	}
}

// --- plugins ------------------------------------------------------------------

/** install-plugins.sh `plugins=( … )`: quoted uncommented lines are required; a comment line holding only a source is optional. */
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
		// Same rule as plugin-audit.sh: explanatory comments contain spaces and do not match.
		const commented = /^\s*#\s*'?([^'\s]+)'?\s*$/.exec(line);
		if (commented) optional.push(commented[1]!);
	}
	return { required, optional };
}

/** Plugin name → dependency value (`#ref` stripped) recorded in ~/.omp/plugins/package.json. */
type InstalledPlugins = ReadonlyMap<string, string>;

function installedPlugins(): InstalledPlugins {
	const installed = new Map<string, string>();
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(homedir(), ".omp", "plugins", "package.json"), "utf8"));
		const deps = isMapping(parsed) && isMapping(parsed.dependencies) ? parsed.dependencies : {};
		for (const [name, value] of Object.entries(deps)) {
			// Strip `#ref`: a host install pinned to a branch or commit still counts as installed.
			if (typeof value === "string") installed.set(name, value.split("#", 1)[0]!);
		}
	} catch {
		// No plugins installed yet.
	}
	return installed;
}

function npmName(spec: string): string {
	if (spec.startsWith("@")) {
		const at = spec.indexOf("@", 1);
		return at === -1 ? spec : spec.slice(0, at);
	}
	const at = spec.indexOf("@");
	return at === -1 ? spec : spec.slice(0, at);
}

/** `owner/repo` of a GitHub source in any form `omp install` records (`github:`, https or git URL, optional `.git`), else undefined. */
function githubRepo(source: string): string | undefined {
	const match = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/i.exec(source);
	return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

/** The package name a declared spec is installed under, or undefined when it is not installed. */
function installedName(spec: string, installed: InstalledPlugins): string | undefined {
	if (!spec.includes("://")) {
		const name = npmName(spec);
		return installed.has(name) ? name : undefined;
	}
	const source = spec.split("#", 1)[0] ?? spec;
	const repo = githubRepo(source);
	for (const [name, value] of installed) {
		if (value === source || (repo !== undefined && githubRepo(value) === repo)) return name;
	}
	return undefined;
}

/** Plugin name → version recorded in ~/.omp/plugins/omp-plugins.lock.json. */
function pluginVersions(): ReadonlyMap<string, string> {
	const versions = new Map<string, string>();
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(homedir(), ".omp", "plugins", "omp-plugins.lock.json"), "utf8"));
		const plugins = isMapping(parsed) && isMapping(parsed.plugins) ? parsed.plugins : {};
		for (const [name, entry] of Object.entries(plugins)) {
			if (isMapping(entry) && typeof entry.version === "string") versions.set(name, entry.version);
		}
	} catch {
		// No plugin installed yet, or a lock file omp is rewriting: versions are display-only.
	}
	return versions;
}

type TodoPluginReadiness =
	| { readonly kind: "ready"; readonly ctx: boolean }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string };

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

/** Owner query, not dependency presence: no private imports, upgrades, enablement or Tern inspection. */
function todoPluginReadiness(): TodoPluginReadiness {
	const omp = Bun.which("omp");
	if (omp === null) return { kind: "invalid", message: "Todo plugin readiness unavailable: omp is not on PATH" };
	const result = spawnSync(omp, ["plugin", "list", "--json"], { encoding: "utf8" });
	if (result.error || result.status !== 0)
		return {
			kind: "invalid",
			message: `Todo plugin readiness query failed: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
		};
	try {
		const value: unknown = JSON.parse(result.stdout);
		if (!isMapping(value) || !Array.isArray(value.npm)) return { kind: "invalid", message: "Todo plugin readiness: invalid npm catalog" };
		const entries: unknown[] = value.npm;
		let plugin: Mapping | undefined;
		for (const entry of entries) {
			if (!isMapping(entry) || entry.name !== TODO_PLUGIN_NAME) continue;
			if (plugin !== undefined) return { kind: "invalid", message: "Todo plugin readiness: ambiguous npm entries" };
			plugin = entry;
		}
		if (plugin === undefined) return { kind: "missing" };
		if (plugin.enabled !== true) return { kind: "invalid", message: "Todo plugin is disabled or has invalid enablement; nothing switched" };
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

/** Resolution state `omp install` writes; unchanged bytes mean no plugin was installed or re-resolved. */
function pluginResolutionState(): string {
	const dir = join(homedir(), ".omp", "plugins");
	return ["bun.lock", "omp-plugins.lock.json"]
		.map((name) => {
			try {
				return readFileSync(join(dir, name), "utf8");
			} catch {
				// Expected before the first install: no lock file yet.
				return "";
			}
		})
		.join("\0");
}

/**
 * `omp install` for each spec: a missing one is installed, an installed one is
 * re-resolved to npm's latest or a GitHub URL's default-branch head. `omp plugin
 * upgrade` is not used: for GitHub-sourced plugins it reports "up to date" while
 * the locked commit is stale.
 */
function installPlugins(omp: string, specs: readonly string[]): PluginRefresh {
	const refresh: PluginRefresh = { installed: [], upgraded: [], errors: [], changes: [] };
	for (const spec of specs) {
		const before = installedName(spec, installedPlugins());
		const from = before === undefined ? null : (pluginVersions().get(before) ?? null);
		const state = pluginResolutionState();
		const result = spawnSync(omp, ["install", spec], { encoding: "utf8" });
		if (result.status !== 0) {
			refresh.errors.push(`omp install ${spec}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
			continue;
		}
		if (before !== undefined && pluginResolutionState() === state) continue;
		const name = installedName(spec, installedPlugins()) ?? before ?? spec;
		(before === undefined ? refresh.installed : refresh.upgraded).push(spec);
		refresh.changes.push({ spec, name, from, to: pluginVersions().get(name) ?? null });
	}
	return refresh;
}

/** The apply's plugin step: every required plugin, before managed file operations. */
function syncPlugins(opts: ApplyOptions, report: ApplyReport, declared: readonly string[]): void {
	const installed = installedPlugins();
	const missing = declared.filter((spec) => installedName(spec, installed) === undefined);
	if (opts.check || !opts.plugins) {
		report.pluginsMissing.push(...missing);
		if (opts.check && opts.plugins && declared.length > 0)
			report.notes.push(
				"plugins: apply runs omp install for every declared plugin (installs missing, upgrades installed); check runs none",
			);
		return;
	}
	const omp = Bun.which("omp");
	if (!omp) {
		report.pluginsMissing.push(...missing);
		report.errors.push("plugins not installed: omp is not on PATH");
		return;
	}
	const refresh = installPlugins(omp, declared);
	report.pluginsInstalled.push(...refresh.installed);
	report.pluginsUpgraded.push(...refresh.upgraded);
	report.pluginChanges.push(...refresh.changes);
	report.pluginsMissing.push(...missing.filter((spec) => !refresh.installed.includes(spec)));
	report.errors.push(...refresh.errors);
	if (refresh.changes.length > 0) report.restartNeeded = true;
}

/**
 * Plugins whose source moves without a config commit: unpinned GitHub URLs among
 * the required entries and the installed optional ones. Run by `auto` when the
 * config commit is unchanged; npm entries and `#ref` pins wait for the next commit.
 */
function refreshMovingPlugins(source: string): PluginRefresh {
	const { required, optional } = declaredPlugins(source);
	const installed = installedPlugins();
	const specs = [...required, ...optional.filter((spec) => installedName(spec, installed) !== undefined)].filter(
		(spec) => spec.includes("://") && !spec.includes("#"),
	);
	if (specs.length === 0) return { installed: [], upgraded: [], errors: [], changes: [] };
	const omp = Bun.which("omp");
	if (!omp) return { installed: [], upgraded: [], errors: ["plugins not refreshed: omp is not on PATH"], changes: [] };
	return installPlugins(omp, specs);
}

// --- settings ---------------------------------------------------------------

/** What the settings step knows before any write: the plugin's registration, the manifest and the pending omomp move. */
interface SettingsPreflight {
	/** omp on PATH, when plugin steps run; null otherwise. */
	readonly omp: string | null;
	readonly plugin: PluginState;
	/** The source's manifest; undefined when the source ships none (an older commit). */
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

/** The repo shipped `value` for omomp `section`: equal to this machine's recorded base, or to a committed version without one. */
function shippedSection(base: BaseRecord, history: RepoHistory): (section: string, value: unknown) => boolean {
	return (section, value) => unmodifiedReplacementSection(base, history, { rel: OMOMP_REL, format: "yaml" }, [section], value);
}

/**
 * Read-only: registration and stored settings through `omp plugin`, and the
 * omomp move. Without plugin steps (`--no-plugins`) OMP is not asked and
 * the plugin counts as unregistered.
 */
function settingsPreflight(opts: ApplyOptions, base: BaseRecord, history: RepoHistory): SettingsPreflight {
	const manifest = readManifest(opts.source);
	const omp = opts.plugins ? Bun.which("omp") : null;
	const plugin: PluginState = omp === null ? { kind: "unregistered" } : queryPluginState(omp, pluginDirOf(opts.agentDir));
	if (plugin.kind === "failed") throw new Error(`plugin ${PLUGIN_NAME}: ${plugin.error}; nothing applied`);
	// Planned even when the source ships no manifest: the exclude list still in the omomp file is the machine's option.
	const plan = planOmompMigration({
		agentDir: opts.agentDir,
		manifest: manifest ?? new Map(),
		shipped: shippedSection(base, history),
		appManaged: (path) => isAppManaged(path),
	});
	return { omp, plugin, manifest, plan };
}

/** The machine's exclude option: the stored plugin setting, else the list still waiting in the omomp file. */
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
	return `${move.section}${parts.length === 0 ? " (nothing to keep)" : `: ${parts.join(", ")}`}`;
}

const CONFIG_REL = "agent/config.yml";

/** The machine's `modelRoles` in config.yml; a missing file or block has none. */
function machineRoles(agentDir: string): Mapping {
	const target = targetOf(CONFIG_REL, agentDir);
	if (!existsSync(target)) return {};
	const roles = valueAt(parseStructured(readFileSync(target, "utf8"), "yaml"), ["modelRoles"]);
	if (roles === undefined) return {};
	if (!isMapping(roles)) throw new Error(`${target}: modelRoles is not a mapping`);
	return roles;
}

/** `--check` and `--no-plugins`: say what the settings step would do. */
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

/** Register `<agentDir>/extensions/_shared` as plugin `omp-config` unless OMP already knows the plugin. Returns its stored settings, or null on failure. */
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

/** `moved` carries the role bindings this run wrote, which the read-back must find with their values. */
type MoveOutcome =
	| { readonly kind: "moved"; readonly bindings: readonly RoleBinding[] }
	| { readonly kind: "kept"; readonly reason: string }
	| { readonly kind: "skipped" };

/** One section: settings the machine has not set yet, then its files and agent flags. Writes nothing before every check passed. */
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

/**
 * SETTINGS step, after every file operation: link the plugin, then move the
 * omomp sections (planned again from disk, since this apply may have rewritten
 * the file). A section leaves the file only after OMP lists each of its values
 * and `config.yml` reads back each role binding it wrote with the written value;
 * anything that cannot move stays with a note. The file goes once nothing is
 * left in it; the omomp base record goes once no omp-config section is.
 */
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

// --- apply ------------------------------------------------------------------

export async function applySnapshot(opts: ApplyOptions): Promise<ApplyReport> {
	const report = newReport();
	let ops: Op[];
	let declared: string[];
	let todoRequired: boolean;
	let base: BaseRecord;
	let ctxReady = false;
	// Planned with the rest so blocked ownership stops the apply before plugins install; used only once the plugin carries src/ctx.
	let ctxRetirements: Op[] = [];
	let history: RepoHistory;
	let settings: SettingsPreflight;
	let exclusions: Exclusions;
	try {
		base = BaseRecord.load(opts.agentDir);
		history = new RepoHistory(opts.source, !opts.check);
		settings = settingsPreflight(opts, base, history);
		exclusions = exclusionsOf(settings, opts.agentDir);
		const sources = parseSources(opts, report);
		declared = declaredPlugins(opts.source).required;
		todoRequired = declared.includes(TODO_PLUGIN_URL);
		const replacementMigration = planReplacementMigration(opts, report, base, history, exclusions);
		const ctx: PlanContext = {
			opts,
			report,
			base,
			history,
			todoRequired,
			freshMachine: freshMachine(opts.agentDir, base),
			replacementMigration,
			exclusions,
		};
		const planned = [
			...planRelocations(ctx),
			...planPlain(ctx),
			...planStructured(ctx, sources),
			...(todoRequired ? planRetirements(ctx, TODO_RETIREMENTS) : []),
		];
		ctxRetirements = todoRequired ? planRetirements(ctx, CTX_RETIREMENTS) : [];
		report.notes.push(...history.notes);
		if (opts.check || !opts.plugins) report.notes.push(...reportPendingSettings(opts, settings));
		// Moves first, managed writes next, deletions after them, base records last; Todo retirement requires all preceding operations to succeed.
		const rank: Record<Op["kind"], number> = { move: 0, split: 0, "migrate-replacements": 0, write: 1, delete: 2, base: 3 };
		ops = groupReplacementMigration(opts, replacementMigration, planned).toSorted((a, b) => rank[a.kind] - rank[b.kind]);
		assertNoExcludedOps(ctx, ops);
	} catch (error) {
		report.errors.push(errorText(error));
		return report;
	}
	if (report.errors.length > 0 && !opts.check) return report;
	const before = todoRequired ? todoPluginReadiness() : undefined;
	if (before?.kind === "invalid") {
		report.errors.push(before.message);
		if (!opts.check) return report;
	}
	syncPlugins(opts, report, declared);
	if (!opts.check && report.errors.length > 0) {
		if (report.restartNeeded) report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
		return report;
	}
	if (todoRequired) {
		const ready = opts.check ? before : todoPluginReadiness();
		switch (ready?.kind) {
			case "ready":
				report.notes.push("Todo plugin prerequisite confirmed by OMP owner catalog.");
				ctxReady = ready.ctx;
				break;
			case "missing":
				report.errors.push(
					`Required plugin ${TODO_PLUGIN_NAME} is missing; no managed files switched${opts.check ? " (check never installs)" : ""}.`,
				);
				break;
			case "invalid":
				if (ready !== before) report.errors.push(ready.message);
				break;
			case undefined:
				throw new Error("Todo readiness was not requested");
			default: {
				const unreachable: never = ready;
				throw new Error(String(unreachable));
			}
		}
		if (!opts.check && report.errors.length > 0) {
			if (report.restartNeeded) report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
			return report;
		}
	}
	if (ctxReady) ops = [...ops, ...ctxRetirements];
	// Base changes of the host operations that succeeded, recorded after all of them.
	const accepted: BaseChange[] = [];
	for (const op of ops) {
		if (!opts.check && op.kind === "delete" && report.errors.length > 0) break;
		if (op.kind === "base") {
			accepted.push(op.change);
			continue;
		}
		const leaf = op.rel.slice("agent/".length);
		const retirement =
			op.kind === "delete" && ((todoRequired && TODO_RETIREMENTS.includes(leaf)) || (ctxReady && CTX_RETIREMENTS.includes(leaf)));
		try {
			if (!opts.check && retirement) {
				const current = inspectTodoRetirement(opts.agentDir, op.rel.slice("agent/".length));
				if (current.kind === "missing") continue;
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
					// Remove the managed entry itself; a symlink's backing file is not ours.
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
		} catch (error) {
			report.errors.push(`${op.target}: ${errorText(error)}`);
			if (retirement) break;
		}
	}
	if (!opts.check) {
		try {
			base.commit(accepted);
		} catch (error) {
			report.errors.push(`${join(opts.agentDir, BASE_DIR)}: ${errorText(error)}`);
		}
		if (report.errors.length === 0) {
			try {
				settleSettings(opts, report, settings, exclusions, base, history);
			} catch (error) {
				report.errors.push(`settings: ${errorText(error)}`);
			}
		}
	}
	installLauncher(opts, report);
	if (report.errors.length > 0 && !opts.check && (todoRequired || report.restartNeeded))
		report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
	return report;
}

/** Plan read-only against `source` and return the conflicts: no plugin installs, no writes, no history fetch. */
export function scanConflicts(source: string, agentDir: string): ConflictScan {
	const opts: ApplyOptions = { source, agentDir, previousCommit: undefined, check: true, plugins: false };
	const report = newReport();
	try {
		const base = BaseRecord.load(agentDir);
		const history = new RepoHistory(source, false);
		// The exclude option lives in plugin settings: asking OMP is read-only.
		const exclusions = exclusionsOf(settingsPreflight({ ...opts, plugins: true }, base, history), agentDir);
		const sources = parseSources(opts, report);
		const todoRequired = declaredPlugins(source).required.includes(TODO_PLUGIN_URL);
		const ctx: PlanContext = {
			opts,
			report,
			base,
			history,
			todoRequired,
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

// --- lock -------------------------------------------------------------------

const LOCK_DIR = join(homedir(), ".omp", "omp-config-update.lock");
const LOCK_OWNER = join(LOCK_DIR, "pid");
/** A lock dir without a pid file is a holder that died between mkdir and write. */
const LOCK_ORPHAN_MS = 60 * 1000;

/** The lock belongs to a running process; a dead holder's lock is stale. */
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
	// ~/.omp may not exist yet (agent dir elsewhere); a missing parent is not a held lock.
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
			} catch {
				// Lock vanished between attempts; retry.
			}
		}
	}
	return false;
}

/** Release only a lock this process holds, never one taken over after it. */
function releaseLock(): void {
	try {
		if (Number(readFileSync(LOCK_OWNER, "utf8")) !== process.pid) return;
	} catch {
		return;
	}
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

// --- auto -------------------------------------------------------------------

const CLONE_DIR = join(homedir(), ".omp", "omp-config-src");

/** Fetch `branch` into the updater-owned clone; returns the clone or fetch error, if any. */
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
		// Apply with the fetched commit's own rules. Dynamic import is required:
		// the module is the just-fetched clone's copy, chosen at runtime, not this file.
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

// --- conflicts and resolve ----------------------------------------------------

/** A JSON value as a fenced block, `(absent)` for a missing one. */
function fenced(value: unknown): string {
	return value === undefined ? "  (absent)" : `  \`\`\`json\n${JSON.stringify(value, null, 2).replace(/^/gm, "  ")}\n  \`\`\``;
}

/** What one conflict looks like on each side, for the person and agent adapting it. */
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

/** The `conflicts` listing: the adaptation procedure, then every conflict. */
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
	/** The conflict is still there, but upstream changed since the id was listed. */
	readonly stale: string[];
	/** No such conflict: already resolved, or a wrong id. */
	readonly unknown: string[];
	readonly errors: string[];
}

/** Move the base of each listed conflict to the source's current value. The caller holds the lock. */
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

// --- CLI ----------------------------------------------------------------------

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
		// --check only reads, so it neither takes nor waits for the lock.
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
