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
// Untouched by every rule: keys and files the repo never had, app-managed
// files (`// @orca-managed-pi-extension` first line, or the Otty marker
// anywhere; see OTTY_MARKER), runtime state. A symlinked target is written
// through to its resolved file.
//
// CUSTOMIZATIONS. A managed item is merged three-way: host H, base B (the repo
// content this machine last accepted, recorded under BASE_DIR; see base.ts)
// and repo R. H==R or H==B takes R; R==B keeps H; text files changed on both
// sides go through `git merge-file`, and a clean merge is written. Anything
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
// host copy is unmodified (code: always), else it conflicts. Items dropped
// before this machine had a base use `git diff previousCommit HEAD` when the
// caller passes the previous commit. The finite TODO_RETIREMENTS are
// different: when the source declares the independent Todo plugin, both modes
// retire those exact leaves after the OMP owner confirms plugin readiness,
// even on first apply or without history. CTX_RETIREMENTS (the ctx leaves the
// Todo plugin now ships) follow the same rule, but only when the ready plugin
// carries src/ctx; until then the old leaves stay.
//
// RELOCATIONS. Both modes, planned like every other op. Earlier layouts kept
// extensions flat (extensions/<name>.ts) and their files at the agent root.
//   - A file SUPERSEDED by one the source ships is deleted: a flat module
//     would load beside its directory version (two modules, one extension
//     id), the agent-root updater is replaced by the copy in
//     extensions/omp-config-autoupdate/, and read-topics/index.ts would
//     contest tool://read with the tool-topics extension that now owns it.
//     An app-managed one is reported as an error instead.
//   - An omomp section a machine lacks is imported from its old standalone JSON
//     file (OMOMP_LEGACY_SECTIONS: extensions/<name>/<name>.json, the flat
//     extensions/<name>.json, the root system-prompt-replace.json and the
//     autoswitch's root copy), then the old file is deleted. A section the
//     machine already has leaves the old file in place with a note.
//   - DATA_MOVES carry agent-root data into its extension directory: a
//     host-owned file is renamed there when the new path is free (else left,
//     with a note); a repo template (shipped now, or by the previous commit)
//     is deleted, as the source writes or dropped it. Symlinks are never
//     moved, only noted.
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
// During Todo cutover, any move/write error prevents the deletion phase entirely.
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
// only a source). The same `omp install` re-resolves each one, so the plugin
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
	"disabledProviders",
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
export const MACHINE_LIST_FIELDS: readonly string[] = ["extensions"];

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
 * Agent-root data that now lives in its extension directory (agent-dir
 * relative). `host` files are the machine's; `template` files are the repo's
 * when the source ships the new path or the previous commit shipped the old
 * one, and the machine's otherwise. A `pattern` matches names at the agent root.
 */
type DataMove =
	| { readonly kind: "file"; readonly owner: "host"; readonly from: string; readonly to: string }
	| { readonly kind: "pattern"; readonly owner: "host" | "template"; readonly pattern: RegExp; readonly toDir: string };

const DATA_MOVES: readonly DataMove[] = [
	{ kind: "file", owner: "host", from: "APPEND_SYSTEM_MODEL.md", to: "extensions/append-system-model/APPEND_SYSTEM_MODEL.md" },
	{ kind: "pattern", owner: "template", pattern: /^PROMPT-INJECT-.+\.md$/i, toDir: "extensions/user-prompt-inject" },
	{ kind: "pattern", owner: "template", pattern: /^TURN-JUDGE-.+\.md$/i, toDir: "extensions/turn-judge" },
	{ kind: "pattern", owner: "host", pattern: /^WATCHDOG-.+\.md$/i, toDir: "extensions/watchdog-agent" },
];

type Format = "json" | "yaml";

/** An omomp section and the old standalone JSON files that held it, newest layout first. */
interface LegacySection {
	readonly section: string;
	readonly rels: readonly string[];
}

interface StructuredItem {
	readonly rel: string;
	/** Old standalone files whose contents become sections of `rel`; see RELOCATIONS. */
	readonly legacySections?: readonly LegacySection[];
	readonly format: Format;
	readonly rules: PathRules;
}

/**
 * Sections of `omomp.yml` that belong to the machine: the repo never writes
 * them and they are never synced back. A section the machine lacks stays absent.
 */
export const LOCAL_OMOMP_SECTIONS: readonly string[] = ["doc-polish", "model-compaction", "omp-config-autoupdate"];

/** `omomp.yml` paths seeded from the repo while the host lacks them: language, input and hardware preferences. */
export const SEED_OMOMP_FIELDS: readonly string[] = [
	"omomp-lang",
	"lang-nag",
	"input-polish.key",
	"input-polish.instruction",
	"child-memory-warning",
];

/** `thinking-translator.json` paths seeded from the repo: the switch, the language and the provider-bound model chain. */
export const SEED_TRANSLATOR_FIELDS: readonly string[] = ["enabled", "targetLanguage", "translatorModels"];

/** Every section's data as earlier layouts kept it. */
const OMOMP_LEGACY_SECTIONS: readonly LegacySection[] = [
	{ section: "lang-nag", rels: ["agent/extensions/lang-nag/lang-nag.json", "agent/extensions/lang-nag.json"] },
	{ section: "input-polish", rels: ["agent/extensions/input-polish/input-polish.json"] },
	{
		section: "tool-policy-nag",
		rels: ["agent/extensions/tool-policy-nag/tool-policy-nag.json", "agent/extensions/tool-policy-nag.json"],
	},
	{
		section: "task-completion-judge",
		rels: ["agent/extensions/task-completion-judge/task-completion-judge.json", "agent/extensions/task-completion-judge.json"],
	},
	{
		section: "system-prompt-replace",
		rels: ["agent/extensions-last/system-prompt-replace/system-prompt-replace.json", "agent/system-prompt-replace.json"],
	},
	{ section: "doc-polish", rels: ["agent/extensions/doc-polish/doc-polish.json", "agent/extensions/doc-polish.json"] },
	{ section: "model-compaction", rels: ["agent/extensions/model-compaction/model-compaction.json"] },
	{
		section: "omp-config-autoupdate",
		rels: ["agent/extensions/omp-config-autoupdate/omp-config-autoupdate.json", "agent/omp-config-autoupdate.json"],
	},
];

/** Structured files, in apply order: config.yml last (it is live-reloaded). */
const STRUCTURED: readonly StructuredItem[] = [
	{
		rel: "agent/thinking-translator.json",
		format: "json",
		rules: { local: [], seed: SEED_TRANSLATOR_FIELDS, machineLists: [], retired: {} },
	},
	{
		rel: "agent/omomp.yml",
		format: "yaml",
		rules: { local: LOCAL_OMOMP_SECTIONS, seed: SEED_OMOMP_FIELDS, machineLists: [], retired: {} },
		legacySections: OMOMP_LEGACY_SECTIONS,
	},
	{
		rel: "agent/config.yml",
		format: "yaml",
		rules: { local: LOCAL_CONFIG_FIELDS, seed: SEED_CONFIG_FIELDS, machineLists: MACHINE_LIST_FIELDS, retired: RETIRED_LIST_ENTRIES },
	},
];

/**
 * Repo files copied verbatim. `rel` uses `/` separators. Inside an extension
 * directory only modules and shipped templates are the repo's; any other file
 * there (settings, switches, the machine's own templates) is the host's.
 */
function managedPlain(rel: string): boolean {
	if (rel.split("/").some((part) => part.startsWith("."))) return false;
	return (
		/^agent\/(SYSTEM_TEMPLATE|APPEND_SYSTEM|APPEND_SYSTEM_LIGHT|PERSONALITY)\.md$/.test(rel) ||
		/^agent\/(config-light\.yml|omp-light\.ts)$/.test(rel) ||
		/^agent\/agents\/.+$/.test(rel) ||
		/^agent\/(extensions|extensions-last)\/[^/]+\/[^/]+\.ts$/.test(rel) ||
		/^agent\/extensions\/user-prompt-inject\/PROMPT-INJECT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/turn-judge\/TURN-JUDGE-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-policy-nag\/INTENT-[^/]+\.md$/.test(rel) ||
		/^agent\/extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md$/.test(rel)
	);
}

/** Extension code and the tool-topics files it loads at start take effect on the next start; the updater script itself runs fresh each time. */
const RESTART_SCOPED =
	/^agent\/(SYSTEM_TEMPLATE\.md|APPEND_SYSTEM\.md|PERSONALITY\.md|extensions\/.+\.ts|extensions-last\/.+\.ts|extensions\/tool-topics\/(TOPIC|SURFACE)-[^/]+\.md)$/;

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
	/** RELOCATIONS: host files moved to their new path. */
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
	| { readonly kind: "delete"; readonly rel: string; readonly target: string; readonly base?: BaseChange }
	| { readonly kind: "base"; readonly rel: string; readonly change: BaseChange };

interface PlanContext {
	readonly opts: ApplyOptions;
	readonly report: ApplyReport;
	readonly base: BaseRecord;
	readonly history: RepoHistory;
	readonly todoRequired: boolean;
	/** No repo content ever reached this agent dir; see freshMachine. */
	readonly freshMachine: boolean;
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
function planPlainItem(ctx: PlanContext, rel: string, repo: Buffer | undefined, dropped?: Buffer): Op[] {
	const { opts, report } = ctx;
	const target = targetOf(rel, opts.agentDir);
	if (lexists(target) && isAppManaged(target)) {
		report.skipped.push({ path: target, reason: "app-managed" });
		return [];
	}
	const host = existsSync(target) ? readFileSync(target) : undefined;
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
	for (const rel of shipped) ops.push(...planPlainItem(ctx, rel, readFileSync(join(opts.source, rel))));
	const known = new Set(shipped);
	for (const rel of ctx.base.plainRels()) {
		if (known.has(rel)) continue;
		known.add(rel);
		// A rel no longer managed stays the host's, and retired leaves have their own planner: only the record goes.
		if (!managedPlain(rel) || retiring(ctx, rel)) ops.push({ kind: "base", rel, change: { kind: "plain-drop", rel } });
		else ops.push(...planPlainItem(ctx, rel, undefined));
	}
	for (const [rel, content] of droppedBeforeBase(ctx)) if (!known.has(rel)) ops.push(...planPlainItem(ctx, rel, undefined, content));
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
function structuredHistory(ctx: PlanContext, item: StructuredItem): Mapping[] {
	const versions: Mapping[] = [];
	for (const text of ctx.history.versions(item.rel)) {
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
		const consumed: string[] = [];
		for (const legacy of item.legacySections ?? []) {
			const present = legacy.rels.filter((rel) => lexists(targetOf(rel, opts.agentDir)));
			if (present.length === 0) continue;
			if (host !== undefined && Object.hasOwn(host, legacy.section)) {
				for (const rel of present) report.notes.push(`${rel} left in place: ${item.rel} already has section ${legacy.section}`);
				continue;
			}
			const from = targetOf(present[0] as string, opts.agentDir);
			let value: Mapping;
			try {
				value = parseStructured(readFileSync(from, "utf8"), "json");
			} catch (error) {
				report.errors.push(`${from}: old copy unparsable (${errorText(error)}); left untouched`);
				continue;
			}
			host = { ...host, [legacy.section]: value };
			consumed.push(...present);
		}
		const recorded = ctx.base.structuredOf(item.rel);
		const source: StructuredBaseSource =
			recorded !== undefined
				? { kind: "recorded", value: recorded.value, unknown: recorded.unknown }
				: host === undefined || ctx.freshMachine
					? { kind: "empty" }
					: { kind: "history", versions: structuredHistory(ctx, item) };
		const merged = mergeStructured(host, repo, source, item.rules);
		for (const { path, reason } of merged.conflicts) {
			const id = `${item.rel}#${pointer(path)}@${digest(canonical(valueAt(repo, path)))}`;
			report.conflicts.push({ kind: "key", id, rel: item.rel, target, path: [...path], reason });
		}
		const record: StructuredRecord = { value: merged.base, unknown: merged.unknown };
		const change: BaseChange | undefined =
			recorded !== undefined && Bun.deepEquals(recorded, record, true) ? undefined : { kind: "structured", rel: item.rel, record };
		if (consumed.length === 0 && host !== undefined && Bun.deepEquals(host, merged.host, true)) {
			if (change !== undefined) ops.push({ kind: "base", rel: item.rel, change });
			continue;
		}
		// Keep the repo's own formatting whenever the result is exactly the repo file.
		const content = Bun.deepEquals(merged.host, repo, true) ? text : serialize(merged.host, item.format);
		ops.push({ kind: "write", rel: item.rel, target, content, base: change });
		for (const rel of consumed) ops.push({ kind: "delete", rel, target: targetOf(rel, opts.agentDir) });
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

function planRetirements(opts: ApplyOptions, report: ApplyReport, leaves: readonly string[]): Op[] {
	const ops: Op[] = [];
	for (const rel of leaves) {
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

/** SUPERSEDED and DATA_MOVES as ops (see RELOCATIONS in the header). */
function planRelocations(opts: ApplyOptions, report: ApplyReport): Op[] {
	const ops: Op[] = [];
	for (const { from, by } of SUPERSEDED) {
		const target = join(opts.agentDir, from);
		if (!lexists(target) || !existsSync(join(opts.source, "agent", by))) continue;
		if (isAppManaged(target)) {
			report.errors.push(`${target} is app-managed and would load beside ${join(opts.agentDir, by)}; remove one of them`);
			continue;
		}
		ops.push({ kind: "delete", rel: `agent/${from}`, target });
	}
	const moves: { from: string; to: string; owner: "host" | "template" }[] = [];
	for (const entry of DATA_MOVES) {
		switch (entry.kind) {
			case "file":
				moves.push({ from: entry.from, to: entry.to, owner: entry.owner });
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
		if (isAppManaged(source)) {
			report.skipped.push({ path: source, reason: "app-managed" });
			continue;
		}
		const repoOwned = owner === "template" && (existsSync(join(opts.source, "agent", to)) || previouslyShipped(opts, `agent/${from}`));
		if (repoOwned) {
			// The source writes the new copy, or dropped the template: the old copy has no owner left.
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

/** The package name a declared spec is installed under, or undefined when it is not installed. */
function installedName(spec: string, installed: InstalledPlugins): string | undefined {
	if (!spec.includes("://")) {
		const name = npmName(spec);
		return installed.has(name) ? name : undefined;
	}
	const source = spec.split("#", 1)[0]!;
	for (const [name, value] of installed) if (value === source) return name;
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

// --- apply ------------------------------------------------------------------

export async function applySnapshot(opts: ApplyOptions): Promise<ApplyReport> {
	const report = newReport();
	let ops: Op[];
	let declared: string[];
	let todoRequired: boolean;
	let base: BaseRecord;
	let ctxReady = false;
	try {
		const sources = parseSources(opts, report);
		declared = declaredPlugins(opts.source).required;
		todoRequired = declared.includes(TODO_PLUGIN_URL);
		base = BaseRecord.load(opts.agentDir);
		const history = new RepoHistory(opts.source, !opts.check);
		const ctx: PlanContext = { opts, report, base, history, todoRequired, freshMachine: freshMachine(opts.agentDir, base) };
		const planned = [
			...planRelocations(opts, report),
			...planPlain(ctx),
			...planStructured(ctx, sources),
			...(todoRequired ? planRetirements(opts, report, TODO_RETIREMENTS) : []),
		];
		report.notes.push(...history.notes);
		// Moves first, managed writes next, deletions after them, base records last; Todo retirement requires all preceding operations to succeed.
		const rank: Record<Op["kind"], number> = { move: 0, write: 1, delete: 2, base: 3 };
		ops = planned.toSorted((a, b) => rank[a.kind] - rank[b.kind]);
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
	if (ctxReady) ops = [...ops, ...planRetirements(opts, report, CTX_RETIREMENTS)];
	// Base changes of the host operations that succeeded, recorded after all of them.
	const accepted: BaseChange[] = [];
	for (const op of ops) {
		if (!opts.check && todoRequired && op.kind === "delete" && report.errors.length > 0) break;
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
				case "move":
					if (!opts.check) {
						mkdirSync(dirname(op.target), { recursive: true });
						renameSync(op.from, op.target);
					}
					report.moved.push({ from: op.from, to: op.target });
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
	}
	installLauncher(opts, report);
	if (report.errors.length > 0 && !opts.check && (todoRequired || report.restartNeeded))
		report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
	return report;
}

/** Plan read-only against `source` and return the conflicts: no plugins, no writes, no history fetch. */
export function scanConflicts(source: string, agentDir: string): ConflictScan {
	const opts: ApplyOptions = { source, agentDir, previousCommit: undefined, check: true, plugins: false };
	const report = newReport();
	try {
		const sources = parseSources(opts, report);
		const todoRequired = declaredPlugins(source).required.includes(TODO_PLUGIN_URL);
		const base = BaseRecord.load(agentDir);
		const ctx: PlanContext = {
			opts,
			report,
			base,
			history: new RepoHistory(source, false),
			todoRequired,
			freshMachine: freshMachine(agentDir, base),
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
		return (error as NodeJS.ErrnoException).code === "EPERM";
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
		"3. Apply the choice to the local file with `edit`. In config.yml, omomp.yml and thinking-translator.json change only the conflicting key and keep comments and other keys. Keeping local needs no edit.",
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
