#!/usr/bin/env bun

// ============================================================================
// omp-config-update — apply the omp-config repo snapshot to an OMP agent dir.
// Lives in extensions/omp-config-autoupdate/ beside the extension that spawns
// it; it is a standalone Bun script, not an extension module (not index.ts).
//
// TWO ENTRY POINTS, ONE APPLY.
//   auto   Run by the omp-config-autoupdate extension at OMP start when the
//          machine's switch is on (`/omp-config-autoupdate on`; off by default).
//          Refreshes the updater-owned clone (~/.omp/omp-config-src) from
//          origin, and applies only when the fetch succeeds and its commit
//          differs from the commit last applied to this agent dir
//          (`<agent dir>/.omp-config-applied`). A failed fetch (offline)
//          applies nothing: the clone is a copy of origin as of the last
//          fetch, never a stand-in for it. A clone of a previous repo
//          location (PREVIOUS_REPO_URLS) is repointed to REPO_URL first;
//          any other origin is left untouched and reported.
//          The apply code is imported from the freshly fetched clone, so a
//          commit that changes apply rules is applied by its own rules.
//          An unchanged commit still refreshes the plugins whose GitHub
//          source moves on its own (see PLUGINS).
//   apply  Run by /update-omp against a working checkout (`--source`).
//          `--check` reports without writing.
//
// AUTHORITY. The repo owns the managed items listed in `managedPlain` and
// `STRUCTURED`; for those it wins outright, host edits included. Everything
// else under the agent dir belongs to the host and is never touched:
//   - config.yml keys outside the repo, and LOCAL_CONFIG_FIELDS even when
//     the repo has them (absence on the host stays absence);
//   - entries of a MACHINE_LIST_FIELDS list (config.yml `extensions`) that
//     the repo's list does not have, unless the repo just dropped them (see
//     DELETIONS); they stay ahead of the repo's entries;
//   - keys a structured file has only on the host;
//   - files not in the managed set (extra extensions, agents, templates,
//     host-owned sections of omomp.yml (LOCAL_OMOMP_SECTIONS, e.g. doc-polish),
//     runtime state);
//   - app-managed files (`// @orca-managed-pi-extension` first line, or the
//     Otty marker anywhere; see OTTY_MARKER), checked before every overwrite
//     and delete;
//   - symlinks: a symlinked target is written through to its resolved file.
//
// DELETIONS. Git-derived removals run only in `auto`, and only what the repo
// dropped between applied and new commits: managed files, structured keys
// and MACHINE_LIST_FIELDS entries. Without the old commit those removals skip.
// The finite TODO_RETIREMENTS are different: when the source declares the
// independent Todo plugin, both modes retire those exact leaves after the
// OMP owner confirms plugin readiness, even on first apply or without history.
// CTX_RETIREMENTS (the ctx leaves the Todo plugin now ships) follow the same rule,
// but only when the ready plugin carries src/ctx; until then the old leaves stay.
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
// Manual apply otherwise deletes only relocations and the ready-plugin Todo leaves.
//
// SAFETY. Parse and plan all source/host inputs and retirement ownership before
// plugin installation or file writes. Preflight errors stop the whole apply.
// Install and upgrade plugins, then freshly query OMP for the required Todo entry;
// failed readiness leaves all managed file operations unapplied. `--check`
// only reports candidates and prerequisites. Writes use a temp file and rename.
// Order after readiness: moves, plain files, JSON, config.yml, deletions.
// During Todo cutover, any move/write error prevents the deletion phase entirely.
// Automatic markers are written last after an error-free apply; manual apply
// never records a working-tree HEAD. Partial cutover errors require a rerun
// before restart. A lock dir (~/.omp/omp-config-update.lock) keeps
// concurrent OMP starts and /update-omp from refreshing or applying at once;
// the loser skips. The lock records its holder's pid: a dead holder's lock is
// taken over, and a process only releases a lock it holds.
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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO_URL = "https://github.com/oh-my-omp/omp-config.git";
/** Origins of updater clones made before the repo moved to oh-my-omp; repointed to REPO_URL on the next fetch. */
const PREVIOUS_REPO_URLS: readonly string[] = ["https://github.com/mouriya-s-lab/omp-config.git"];
export const DEFAULT_BRANCH = "main";
export const APPLIED_MARKER = ".omp-config-applied";

/**
 * config.yml paths owned by each machine: never written from the repo, never
 * removed. /sync-omp-config keeps the repo's values for the same paths.
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
];

/**
 * config.yml lists shared by repo and machine: entries the repo lists are the
 * repo's; entries it does not list belong to the machine and stay ahead of the
 * repo's. /sync-omp-config never writes machine entries into the repo.
 */
export const MACHINE_LIST_FIELDS: readonly string[] = ["extensions"];

/**
 * Entries earlier repo versions put in a MACHINE_LIST_FIELDS list and later
 * replaced. Manual apply has no previous commit to tell a dropped repo entry
 * from a machine one, so these are named explicitly and dropped in both modes.
 */
const RETIRED_LIST_ENTRIES: Readonly<Record<string, readonly string[]>> = {
	extensions: ["~/.omp/agent/extensions-last/system-prompt-replace.ts"],
};

/** Where this script lives, relative to the agent dir (and to `agent/` in the repo). */
const UPDATER_REL = "extensions/omp-config-autoupdate/omp-config-update.ts";

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
		"commandcode-model-spec",
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
	{ from: "omp-config-update.ts", by: UPDATER_REL },
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
	readonly localFields: readonly string[];
	readonly machineLists: readonly string[];
}

/**
 * Sections of `omomp.yml` that belong to the machine: the repo never writes
 * them and they are never synced back. A section the machine lacks stays absent.
 */
export const LOCAL_OMOMP_SECTIONS: readonly string[] = ["doc-polish", "model-compaction", "omp-config-autoupdate"];

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
	{ rel: "agent/thinking-translator.json", format: "json", localFields: [], machineLists: [] },
	{
		rel: "agent/omomp.yml",
		format: "yaml",
		localFields: LOCAL_OMOMP_SECTIONS,
		machineLists: [],
		legacySections: OMOMP_LEGACY_SECTIONS,
	},
	{ rel: "pi/agent/pi-bansos-relay-state.json", format: "json", localFields: [], machineLists: [] },
	{ rel: "agent/config.yml", format: "yaml", localFields: LOCAL_CONFIG_FIELDS, machineLists: MACHINE_LIST_FIELDS },
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
	/** Commit last applied to agentDir; enables git-derived deletions. */
	readonly previousCommit: string | undefined;
	readonly check: boolean;
	readonly plugins: boolean;
}

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

export type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string; readonly plugins: PluginRefresh }
	| { readonly kind: "applied"; readonly commit: string; readonly previous: string | undefined; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

// --- small helpers ----------------------------------------------------------

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	if (rel.startsWith("pi/agent/")) return join(homedir(), ".pi", "agent", rel.slice("pi/agent/".length));
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

// --- structured merge -------------------------------------------------------

function pathIsLocal(path: readonly string[], localFields: readonly string[]): boolean {
	const joined = path.join(".");
	return localFields.some((field) => joined === field || joined.startsWith(`${field}.`));
}

type MergeRules = Pick<StructuredItem, "localFields" | "machineLists">;

/** Repo values win key by key; host-only keys, local fields and machine list entries stay as they are. */
function overlay(host: unknown, repo: Mapping, rules: MergeRules, path: readonly string[]): Mapping {
	// Deep copy: removeDropped later mutates nested maps, which must not alias the host's.
	const result: Mapping = isMapping(host) ? structuredClone(host) : {};
	for (const [key, value] of Object.entries(repo)) {
		const keyPath = [...path, key];
		if (pathIsLocal(keyPath, rules.localFields)) continue;
		if (isMapping(value)) {
			result[key] = overlay(result[key], value, rules, keyPath);
			continue;
		}
		// A non-map would wipe a local field nested under this key; the host's map stays.
		const prefix = `${keyPath.join(".")}.`;
		if (isMapping(result[key]) && rules.localFields.some((field) => field.startsWith(prefix))) continue;
		const current = result[key];
		// Entries the repo's list lacks stay on the host, ahead of the repo's entries.
		result[key] =
			Array.isArray(value) && Array.isArray(current) && rules.machineLists.includes(keyPath.join("."))
				? [...current.filter((entry) => !value.some((own) => Bun.deepEquals(own, entry))), ...structuredClone(value)]
				: structuredClone(value);
	}
	return result;
}

/** Remove from `host` the keys and machine-list entries the repo had in `oldRepo` and dropped in `newRepo`. */
function removeDropped(host: Mapping, oldRepo: Mapping, newRepo: Mapping, rules: MergeRules, path: readonly string[]): void {
	for (const [key, oldValue] of Object.entries(oldRepo)) {
		const keyPath = [...path, key];
		if (pathIsLocal(keyPath, rules.localFields)) continue;
		const current = host[key];
		if (Array.isArray(oldValue) && Array.isArray(current) && rules.machineLists.includes(keyPath.join("."))) {
			// The repo's dropped entries go; entries the repo never listed are the machine's.
			const next = newRepo[key];
			const kept = current.filter(
				(entry) =>
					!oldValue.some((old) => Bun.deepEquals(old, entry)) || (Array.isArray(next) && next.some((own) => Bun.deepEquals(own, entry))),
			);
			if (kept.length === 0 && !(key in newRepo)) delete host[key];
			else host[key] = kept;
			continue;
		}
		if (!(key in newRepo)) {
			// A dropped map loses only the keys the repo had; host-only and local keys under it stay.
			if (isMapping(oldValue) && isMapping(current)) {
				removeDropped(current, oldValue, {}, rules, keyPath);
				if (Object.keys(current).length === 0) delete host[key];
			} else if (!isMapping(current)) {
				// The repo had a value here; a map in its place is the host's own and stays.
				delete host[key];
			}
			continue;
		}
		const next = newRepo[key];
		if (isMapping(oldValue) && isMapping(next) && isMapping(current)) removeDropped(current, oldValue, next, rules, keyPath);
	}
}

// --- plan -------------------------------------------------------------------

type Op =
	| { readonly kind: "write"; readonly rel: string; readonly target: string; readonly content: string | Uint8Array }
	| { readonly kind: "move"; readonly rel: string; readonly from: string; readonly target: string }
	| { readonly kind: "delete"; readonly rel: string; readonly target: string };

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

function oldRepoText(opts: ApplyOptions, rel: string): string | undefined {
	if (opts.previousCommit === undefined) return undefined;
	const shown = git(opts.source, ["show", `${opts.previousCommit}:${rel}`]);
	return shown.ok ? shown.out : undefined;
}

function planPlain(opts: ApplyOptions, report: ApplyReport, todoRequired: boolean): Op[] {
	const ops: Op[] = [];
	for (const rel of listSourceFiles(opts.source)) {
		if (todoRequired && TODO_RETIREMENTS.includes(rel.slice("agent/".length))) continue;
		const target = targetOf(rel, opts.agentDir);
		const content = readFileSync(join(opts.source, rel));
		if (existsSync(target)) {
			if (isAppManaged(target)) {
				report.skipped.push({ path: target, reason: "app-managed" });
				continue;
			}
			if (Buffer.from(readFileSync(target)).equals(content)) continue;
		}
		ops.push({ kind: "write", rel, target, content });
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

function planStructured(opts: ApplyOptions, report: ApplyReport, sources: readonly StructuredSource[]): Op[] {
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
				// Replacing it would drop the host's local fields; leave it and retry next start.
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
		const merged = overlay(host, repo, item, []);
		const oldText = oldRepoText(opts, item.rel);
		if (oldText !== undefined) {
			try {
				removeDropped(merged, parseStructured(oldText, item.format), repo, item, []);
			} catch {
				report.notes.push(`${item.rel}: previous version unparsable, no keys removed`);
			}
		}
		dropRetiredEntries(merged, item.machineLists);
		if (consumed.length === 0 && host !== undefined && Bun.deepEquals(host, merged)) continue;
		// Keep the repo's own formatting whenever the result is exactly the repo file.
		const content = Bun.deepEquals(merged, repo) ? text : serialize(merged, item.format);
		ops.push({ kind: "write", rel: item.rel, target, content });
		for (const rel of consumed) ops.push({ kind: "delete", rel, target: targetOf(rel, opts.agentDir) });
	}
	return ops;
}

/** Remove RETIRED_LIST_ENTRIES from the merged machine lists. */
function dropRetiredEntries(merged: Mapping, machineLists: readonly string[]): void {
	for (const field of machineLists) {
		const retired = RETIRED_LIST_ENTRIES[field];
		if (retired === undefined) continue;
		const keys = field.split(".");
		const last = keys.pop();
		let parent: unknown = merged;
		for (const key of keys) parent = isMapping(parent) ? parent[key] : undefined;
		if (last === undefined || !isMapping(parent)) continue;
		const list = parent[last];
		if (Array.isArray(list)) parent[last] = list.filter((entry) => !retired.includes(entry));
	}
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

function planDeletions(opts: ApplyOptions, report: ApplyReport, todoRequired: boolean): Op[] {
	if (opts.previousCommit === undefined) return [];
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
		report.notes.push(`deletions skipped: ${diff.err}`);
		return [];
	}
	const ops: Op[] = [];
	for (const rel of diff.out.split("\0").filter(Boolean)) {
		// The finite planner owns these leaves, including its app-managed errors and plugin prerequisite.
		if (todoRequired && TODO_RETIREMENTS.includes(rel.slice("agent/".length))) continue;
		if (CTX_RETIREMENTS.includes(rel.slice("agent/".length))) continue;
		if (!managedPlain(rel)) continue;
		const target = targetOf(rel, opts.agentDir);
		try {
			lstatSync(target);
		} catch {
			continue;
		}
		if (isAppManaged(target)) {
			report.skipped.push({ path: target, reason: "app-managed" });
			continue;
		}
		ops.push({ kind: "delete", rel, target });
	}
	return ops;
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
	const report: ApplyReport = {
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
		restartNeeded: false,
	};
	let ops: Op[];
	let declared: string[];
	let todoRequired: boolean;
	let ctxReady = false;
	try {
		const sources = parseSources(opts, report);
		declared = declaredPlugins(opts.source).required;
		todoRequired = declared.includes(TODO_PLUGIN_URL);
		const planned = [
			...planRelocations(opts, report),
			...planPlain(opts, report, todoRequired),
			...planStructured(opts, report, sources),
			...planDeletions(opts, report, todoRequired),
			...(todoRequired ? planRetirements(opts, report, TODO_RETIREMENTS) : []),
		];
		// Moves first, managed writes next, deletions last; Todo retirement requires all preceding operations to succeed.
		const rank: Record<Op["kind"], number> = { move: 0, write: 1, delete: 2 };
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
	for (const op of ops) {
		if (!opts.check && todoRequired && op.kind === "delete" && report.errors.length > 0) break;
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
					break;
				case "delete":
					// Remove the managed entry itself; a symlink's backing file is not ours.
					if (!opts.check) unlinkSync(op.target);
					report.deleted.push(op.target);
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
	installLauncher(opts, report);
	if (report.errors.length > 0 && !opts.check && (todoRequired || report.restartNeeded))
		report.notes.push("Cutover incomplete; do not restart OMP. Resolve errors and rerun apply.");
	return report;
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
		if (applied === commit) return { kind: "up-to-date", commit, plugins: refreshMovingPlugins(CLONE_DIR) };
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
		if (applied && previousCommit === undefined) report.notes.push(`previous commit ${applied} unavailable, no git-derived deletions`);
		if (report.errors.length === 0) atomicWrite(markerPath, `${commit}\n`);
		return { kind: "applied", commit, previous: applied || undefined, report };
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	} finally {
		releaseLock();
	}
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
	for (const change of report.pluginChanges) lines.push(pluginChangeLine(change));
	for (const spec of report.pluginsMissing) lines.push(`plugin missing: ${spec}`);
	for (const note of report.notes) lines.push(`note: ${note}`);
	for (const error of report.errors) lines.push(`error: ${error}`);
	if (report.written.length + report.moved.length + report.deleted.length === 0) lines.push("no file changes");
	if (report.restartNeeded && report.errors.length === 0) lines.push("restart OMP: system prompt, extensions or plugins changed");
	return lines.join("\n");
}

function usage(): never {
	process.stderr.write(
		"usage:\n  omp-config-update.ts auto [--agent-dir DIR] [--branch NAME] [--json]\n  omp-config-update.ts apply --source DIR [--agent-dir DIR] [--check] [--no-plugins] [--json]\n",
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
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		const value = (): string => rest[++i] ?? usage();
		if (arg === "--agent-dir") agentDir = resolve(value());
		else if (arg === "--branch") branch = value();
		else if (arg === "--source") source = resolve(value());
		else if (arg === "--check") check = true;
		else if (arg === "--no-plugins") plugins = false;
		else if (arg === "--json") json = true;
		else usage();
	}
	if (mode === "auto") {
		const result = await runAuto(agentDir, branch);
		if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else if (result.kind === "applied") process.stdout.write(`applied ${result.commit}\n${formatReport(result.report, false)}\n`);
		else if (result.kind === "up-to-date") {
			const { plugins } = result;
			const lines = [
				`up-to-date ${result.commit}`,
				...plugins.changes.map(pluginChangeLine),
				...plugins.errors.map((error) => `error: ${error}`),
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
	usage();
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
