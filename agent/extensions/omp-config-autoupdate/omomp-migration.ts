// One-time move of the omp-config sections of a machine's omomp file into the
// settings of the local OMP plugin `omp-config` (the manifest
// `extensions/_shared/package.json`) and, for list data, into the md files
// that now describe it. Planned read-only at preflight; carried out by the
// updater after its file operations, once the plugin is registered. Talks to
// OMP only through the `omp plugin` CLI (this script runs outside OMP).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { isMapping, type Mapping } from "./merge.ts";

export const PLUGIN_NAME = "omp-config";
/** Plugin root, agent-dir relative: the directory `omp plugin link` registers. */
export const PLUGIN_DIR = "extensions/_shared";
export const OMOMP_FILES = ["omomp.yml", "omomp.yaml", "omomp.json", "omomp.toml"] as const;

/** Every omomp section omp-config ever owned; `system-prompt-replace` moves through its own migration. */
const SECTIONS = [
	"omomp-lang",
	"judge",
	"lang-nag",
	"input-polish",
	"tool-policy-nag",
	"task-completion-judge",
	"task-split-check",
	"child-memory-warning",
	"tool-topic-injection",
	"doc-polish",
	"model-compaction",
	"omp-config-autoupdate",
	"subagent-usage",
] as const;
type Section = (typeof SECTIONS)[number];
export const REPLACEMENT_SECTION = "system-prompt-replace";
const OWNED: readonly string[] = [...SECTIONS, REPLACEMENT_SECTION];

/** The standalone JSON files that held a section before the omomp file existed, newest layout first. */
const LEGACY_SOURCES: Partial<Record<Section, readonly string[]>> = {
	"lang-nag": ["extensions/lang-nag/lang-nag.json", "extensions/lang-nag.json"],
	"input-polish": ["extensions/input-polish/input-polish.json"],
	"tool-policy-nag": ["extensions/tool-policy-nag/tool-policy-nag.json", "extensions/tool-policy-nag.json"],
	"task-completion-judge": ["extensions/task-completion-judge/task-completion-judge.json", "extensions/task-completion-judge.json"],
	"doc-polish": ["extensions/doc-polish/doc-polish.json", "extensions/doc-polish.json"],
	"model-compaction": ["extensions/model-compaction/model-compaction.json"],
	"omp-config-autoupdate": ["extensions/omp-config-autoupdate/omp-config-autoupdate.json", "omp-config-autoupdate.json"],
};

/** Keys that chose a model; the `@<extension>` role replaces them. */
const MODEL_KEYS: Partial<Record<Section, string>> = {
	judge: "fallbackRole",
	"input-polish": "fallbackRole",
	"task-completion-judge": "fallbackRole",
	"task-split-check": "fallbackRole",
	"doc-polish": "fallbackRole",
};

export type Scalar = string | number | boolean;

type Setting =
	| { readonly type: "string"; readonly default: string | undefined }
	| { readonly type: "number"; readonly default: number | undefined; readonly min: number | undefined; readonly max: number | undefined }
	| { readonly type: "boolean"; readonly default: boolean | undefined }
	| { readonly type: "enum"; readonly values: readonly string[]; readonly default: string | undefined };

export type Manifest = ReadonlyMap<string, Setting>;

const optional = <T>(value: unknown, guard: (value: unknown) => value is T, what: string): T | undefined => {
	if (value === undefined) return undefined;
	if (!guard(value)) throw new Error(what);
	return value;
};
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** The plugin manifest's `omp.settings`; anything malformed throws, so the apply stops before writing. */
export function parseManifest(text: string, path: string): Manifest {
	const root: unknown = JSON.parse(text);
	const settings = isMapping(root) && root.name === PLUGIN_NAME && isMapping(root.omp) ? root.omp.settings : undefined;
	if (!isMapping(settings)) throw new Error(`${path}: not the ${PLUGIN_NAME} manifest with omp.settings`);
	const out = new Map<string, Setting>();
	for (const [key, raw] of Object.entries(settings)) {
		const bad = `${path}: invalid setting ${key}`;
		if (!isMapping(raw)) throw new Error(bad);
		switch (raw.type) {
			case "string":
				out.set(key, { type: "string", default: optional(raw.default, isString, bad) });
				break;
			case "number":
				out.set(key, {
					type: "number",
					default: optional(raw.default, isNumber, bad),
					min: optional(raw.min, isNumber, bad),
					max: optional(raw.max, isNumber, bad),
				});
				break;
			case "boolean":
				out.set(key, { type: "boolean", default: optional(raw.default, isBoolean, bad) });
				break;
			case "enum": {
				const values = raw.values;
				if (!Array.isArray(values) || !values.every(isString)) throw new Error(bad);
				out.set(key, { type: "enum", values, default: optional(raw.default, isString, bad) });
				break;
			}
			default:
				throw new Error(bad);
		}
	}
	return out;
}

/** `value` as the manifest's `key` accepts it, or why not. */
function checkSetting(
	manifest: Manifest,
	key: string,
	value: unknown,
): { readonly kind: "ok"; readonly value: Scalar } | { readonly kind: "bad"; readonly reason: string } {
	const setting = manifest.get(key);
	if (setting === undefined) return { kind: "bad", reason: `${key} is not a setting` };
	switch (setting.type) {
		case "string":
			return typeof value === "string" ? { kind: "ok", value } : { kind: "bad", reason: `${key} must be a string` };
		case "number":
			return isNumber(value) && (setting.min === undefined || value >= setting.min) && (setting.max === undefined || value <= setting.max)
				? { kind: "ok", value }
				: { kind: "bad", reason: `${key} must be a number within the manifest's range` };
		case "boolean":
			return typeof value === "boolean" ? { kind: "ok", value } : { kind: "bad", reason: `${key} must be true or false` };
		case "enum":
			return typeof value === "string" && setting.values.includes(value)
				? { kind: "ok", value }
				: { kind: "bad", reason: `${key} must be one of ${setting.values.join(", ")}` };
		default: {
			const unreachable: never = setting;
			return unreachable;
		}
	}
}

// --- planning ---------------------------------------------------------------

/** A file this migration writes: agent-dir relative `rel` (`agent/…`) and its content. */
export type PlannedFile = { readonly rel: string; readonly content: string };

/** One section that can move: its settings (values that differ from the manifest default), files and agent flags. */
export type SectionMove = {
	readonly section: string;
	/** Where the values came from: the omomp file, or an old standalone JSON (`agent/…`) deleted after the move. */
	readonly from: { readonly kind: "omomp" } | { readonly kind: "legacy"; readonly rel: string };
	readonly settings: ReadonlyMap<string, Scalar>;
	readonly files: readonly PlannedFile[];
	/** Agent names whose definitions get `splitCheck: true`. */
	readonly splitAgents: readonly string[];
	readonly notes: readonly string[];
};

export type OmompFile = {
	readonly path: string;
	readonly format: "yaml" | "json";
	readonly text: string;
	readonly root: Mapping;
};

export type OmompPlan =
	| { readonly kind: "none" }
	| { readonly kind: "blocked"; readonly reason: string; readonly pendingExclude: readonly string[] | undefined }
	| {
			readonly kind: "ready";
			/** The omomp file holding omp-config sections; undefined when only old standalone JSON holds them. */
			readonly file: OmompFile | undefined;
			readonly moves: readonly SectionMove[];
			/** Sections left in place, with the reason. */
			readonly kept: readonly { readonly section: string; readonly reason: string }[];
			/** The raw `omp-config-autoupdate.exclude` still in the omomp file or its old JSON; the machine's option until it moves. */
			readonly pendingExclude: readonly string[] | undefined;
	  };

export interface PlanInput {
	readonly agentDir: string;
	readonly manifest: Manifest;
	/** True when `value` is what the repo shipped for `section` (recorded base or a committed version): nothing of the machine's to move. */
	readonly shipped: (section: string, value: unknown) => boolean;
	readonly appManaged: (path: string) => boolean;
}

type Translation =
	| {
			readonly kind: "ok";
			readonly settings: ReadonlyMap<string, Scalar>;
			readonly files: readonly PlannedFile[];
			readonly splitAgents: readonly string[];
			readonly notes: readonly string[];
	  }
	| { readonly kind: "invalid"; readonly reason: string };

/** Nested mapping → dotted leaves; arrays and nulls are not settings. */
function flatten(value: Mapping, prefix: string, out: Map<string, unknown>): string | undefined {
	for (const [key, entry] of Object.entries(value)) {
		const dotted = `${prefix}.${key}`;
		if (isMapping(entry)) {
			const problem = flatten(entry, dotted, out);
			if (problem !== undefined) return problem;
		} else if (entry === null || Array.isArray(entry)) return `${dotted} is not a setting value`;
		else out.set(dotted, entry);
	}
	return undefined;
}

/** `tool-policy-nag`: a present `risk`/`pty` block turned its lane on; missing or null left it off. */
function policyLanes(value: Mapping): Mapping | string {
	const { risk, pty, form, ...rest } = value;
	if (risk != null && !isMapping(risk)) return "risk must be a mapping or null";
	if (pty != null && (!isMapping(pty) || Object.keys(pty).length > 0)) return "pty must be {} or null";
	return {
		...rest,
		...(form == null ? {} : { form }),
		risk: risk == null ? { enabled: false } : { ...risk, enabled: true },
		pty: { enabled: pty != null },
	};
}

function compactionFile(rule: unknown, index: number): PlannedFile | string {
	if (!isMapping(rule) || Object.keys(rule).some((key) => !["provider", "model", "thresholdTokens"].includes(key)))
		return `rule ${index + 1} has keys other than provider, model, thresholdTokens`;
	const lines: string[] = [];
	for (const field of ["provider", "model"] as const) {
		const pattern = rule[field];
		if (pattern === undefined) continue;
		if (typeof pattern !== "string" || pattern.trim() === "" || pattern.includes("\n"))
			return `rule ${index + 1}: ${field} must be a one-line regex`;
		try {
			new RegExp(pattern);
		} catch {
			return `rule ${index + 1}: ${field} is not a valid regex`;
		}
		// The file format unquotes one pair of surrounding quotes; such a pattern cannot be written verbatim.
		if (/^["']|["']$/.test(pattern.trim()) || pattern !== pattern.trim())
			return `rule ${index + 1}: ${field} cannot be written as frontmatter`;
		lines.push(`${field}: ${pattern}`);
	}
	if (lines.length === 0) return `rule ${index + 1} sets neither model nor provider`;
	const tokens = rule.thresholdTokens;
	if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0)
		return `rule ${index + 1}: thresholdTokens must be a positive integer`;
	lines.push(`thresholdTokens: ${tokens}`);
	return {
		rel: `agent/extensions/model-compaction/COMPACTION-rule-${String(index + 1).padStart(2, "0")}.md`,
		content: `---\n${lines.join("\n")}\n---\n`,
	};
}

function translate(section: Section, value: unknown, input: PlanInput): Translation {
	const invalid = (reason: string): Translation => ({ kind: "invalid", reason });
	if (!isMapping(value)) return invalid("not a mapping");
	const notes: string[] = [];
	let rest: Mapping = { ...value };
	const modelKey = MODEL_KEYS[section];
	if (modelKey !== undefined && Object.hasOwn(rest, modelKey)) {
		const { [modelKey]: role, ...others } = rest;
		rest = others;
		notes.push(
			section === "judge"
				? `judge.fallbackRole (${String(role)}) dropped: an unassigned @<purpose> role now uses OMP's judge role chain`
				: `${section}.${modelKey} (${String(role)}) dropped: assign @${section} in /model, or it uses the default role`,
		);
	}
	const files: PlannedFile[] = [];
	const splitAgents: string[] = [];
	switch (section) {
		case "tool-topic-injection":
			if (!input.shipped(section, value))
				return invalid(
					"customized rules: move them into the inject list of the matching extensions/tool-topics/TOPIC-*.md by hand, then delete the section",
				);
			return { kind: "ok", settings: new Map(), files, splitAgents, notes };
		case "model-compaction": {
			const { rules, ...unknown } = rest;
			if (Object.keys(unknown).length > 0 || !Array.isArray(rules)) return invalid("expected only a rules list");
			for (const [index, rule] of rules.entries()) {
				const file = compactionFile(rule, index);
				if (typeof file === "string") return invalid(file);
				files.push(file);
			}
			return { kind: "ok", settings: new Map(), files, splitAgents, notes };
		}
		case "task-split-check": {
			const { agents, ...unknown } = rest;
			if (Object.keys(unknown).length > 0) return invalid(`unknown keys ${Object.keys(unknown).join(", ")}`);
			if (agents !== undefined && (!Array.isArray(agents) || !agents.every((name) => typeof name === "string" && name.trim() !== "")))
				return invalid("agents must be a list of agent names");
			if (agents !== undefined) splitAgents.push(...agents.map((name: string) => name.trim()));
			return { kind: "ok", settings: new Map(), files, splitAgents, notes };
		}
		case "omp-config-autoupdate": {
			const { exclude, ...others } = rest;
			if (exclude !== undefined) {
				if (
					!Array.isArray(exclude) ||
					!exclude.every((entry) => typeof entry === "string" && entry.trim() !== "" && !/\s/.test(entry.trim()))
				)
					return invalid("exclude must be a list of entries without whitespace");
				rest = { ...others, exclude: exclude.map((entry: string) => entry.trim()).join(" ") };
			}
			break;
		}
		case "tool-policy-nag": {
			const lanes = policyLanes(rest);
			if (typeof lanes === "string") return invalid(lanes);
			rest = lanes;
			break;
		}
		default:
			break;
	}
	const leaves = new Map<string, unknown>();
	const problem = flatten(rest, section, leaves);
	if (problem !== undefined) return invalid(problem);
	const settings = new Map<string, Scalar>();
	for (const [key, leaf] of leaves) {
		const checked = checkSetting(input.manifest, key, leaf);
		if (checked.kind === "bad") return invalid(checked.reason);
		if (checked.value !== input.manifest.get(key)?.default) settings.set(key, checked.value);
	}
	return { kind: "ok", settings, files, splitAgents, notes };
}

function parseOmomp(path: string, text: string): Mapping {
	const value: unknown = path.endsWith(".json") ? JSON.parse(text) : path.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.YAML.parse(text);
	if (value == null) return {};
	if (!isMapping(value)) throw new Error("root is not a mapping");
	return value;
}

/** The raw `exclude` list of an `omp-config-autoupdate` section; a malformed one throws (the machine's option is unreadable). */
function excludeOf(section: unknown, where: string): readonly string[] | undefined {
	if (!isMapping(section) || section.exclude === undefined) return undefined;
	const exclude = section.exclude;
	if (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === "string"))
		throw new Error(`${where}: omp-config-autoupdate.exclude must be a list of strings`);
	return exclude;
}

/**
 * Read every omomp file and old JSON once and decide what moves; never writes.
 * omp-config sections in several omomp files make the machine's options
 * ambiguous and throw (the apply stops, as with any unreadable option); an
 * unreadable omomp file holding nothing readable is left alone with a note.
 */
export function planOmompMigration(input: PlanInput): OmompPlan {
	const present = OMOMP_FILES.filter((name) => existsSync(join(input.agentDir, name)));
	const parsed: { path: string; text: string; root: Mapping }[] = [];
	const unreadable: string[] = [];
	for (const name of present) {
		const path = join(input.agentDir, name);
		const text = readFileSync(path, "utf8");
		try {
			const root = parseOmomp(path, text);
			if (holdsOwnedSection(root)) parsed.push({ path, text, root });
		} catch (error) {
			unreadable.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (parsed.length > 1) {
		// Only the switch section matters before the move: two copies of it leave the exclude list unknown.
		const switches = parsed.filter((file) => Object.hasOwn(file.root, "omp-config-autoupdate"));
		if (switches.length > 1)
			throw new Error(`omp-config-autoupdate appears in ${switches.map((file) => file.path).join(" and ")}; the exclude list is ambiguous`);
		const [only] = switches;
		return {
			kind: "blocked",
			reason: `omp-config sections in several omomp files: ${parsed.map((file) => file.path).join(", ")}`,
			pendingExclude: only === undefined ? undefined : excludeOf(only.root["omp-config-autoupdate"], only.path),
		};
	}
	const [holder] = parsed;
	if (holder === undefined && unreadable.length > 0) return { kind: "blocked", reason: unreadable.join("; "), pendingExclude: undefined };
	const holderExclude = holder === undefined ? undefined : excludeOf(holder.root["omp-config-autoupdate"], holder.path);
	if (holder?.path.endsWith(".toml"))
		return { kind: "blocked", reason: `${holder.path}: a TOML file cannot be rewritten here`, pendingExclude: holderExclude };
	if (holder !== undefined && input.appManaged(holder.path))
		return { kind: "blocked", reason: `${holder.path} is app-managed`, pendingExclude: holderExclude };
	const file: OmompFile | undefined =
		holder === undefined ? undefined : { ...holder, format: holder.path.endsWith(".json") ? "json" : "yaml" };
	const moves: SectionMove[] = [];
	const kept: { section: string; reason: string }[] = [];
	let pendingExclude: readonly string[] | undefined;
	for (const section of SECTIONS) {
		let value: unknown;
		let from: SectionMove["from"];
		if (file !== undefined && Object.hasOwn(file.root, section)) {
			value = file.root[section];
			from = { kind: "omomp" };
		} else {
			const rel = LEGACY_SOURCES[section]?.find((candidate) => existsSync(join(input.agentDir, candidate)));
			if (rel === undefined) continue;
			const path = join(input.agentDir, rel);
			if (input.appManaged(path)) {
				kept.push({ section, reason: `${path} is app-managed` });
				continue;
			}
			try {
				value = JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				kept.push({ section, reason: `${path}: ${error instanceof Error ? error.message : String(error)}` });
				continue;
			}
			from = { kind: "legacy", rel: `agent/${rel}` };
		}
		if (section === "omp-config-autoupdate") pendingExclude = excludeOf(value, from.kind === "omomp" ? (file?.path ?? "") : from.rel);
		const translation = translate(section, value, input);
		switch (translation.kind) {
			case "invalid":
				kept.push({ section, reason: translation.reason });
				break;
			case "ok":
				moves.push({ section, from, ...translation });
				break;
			default: {
				const unreachable: never = translation;
				return unreachable;
			}
		}
	}
	if (file === undefined && moves.length === 0 && kept.length === 0) return { kind: "none" };
	return { kind: "ready", file, moves, kept, pendingExclude };
}

// --- rewriting --------------------------------------------------------------

/**
 * `text` without the top-level YAML blocks of `sections`, verified by parsing:
 * anything the block layout cannot express (anchors, flow mappings) is refused.
 */
export function removeYamlSections(
	text: string,
	root: Mapping,
	sections: readonly string[],
): { readonly kind: "ok"; readonly text: string; readonly empty: boolean } | { readonly kind: "invalid"; readonly reason: string } {
	let lines = text.split(/(?<=\n)/);
	for (const section of sections) {
		const header = new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}:[ \\t]*(?:#.*)?\\r?\\n?$`);
		const starts = lines.flatMap((line, index) => (header.test(line) ? [index] : []));
		if (starts.length !== 1) return { kind: "invalid", reason: `${section} is not one direct top-level YAML block` };
		const start = starts[0]!;
		let end = start + 1;
		while (end < lines.length && (/^[ \t]/.test(lines[end]!) || /^[\r\n]*$/.test(lines[end]!))) end++;
		lines = [...lines.slice(0, start), ...lines.slice(end)];
	}
	const remaining = lines.join("");
	const expected = Object.fromEntries(Object.entries(root).filter(([key]) => !sections.includes(key)));
	try {
		const parsed: unknown = Bun.YAML.parse(remaining);
		if (Bun.deepEquals(parsed ?? {}, expected))
			return { kind: "ok", text: parsed == null ? `${remaining}{}\n` : remaining, empty: Object.keys(expected).length === 0 };
	} catch {
		// Anchors, flow mappings and other ambiguous layouts must be moved by hand.
	}
	return { kind: "invalid", reason: "removing the sections would change other YAML values" };
}

/** The file content after removing `sections`, or why it cannot be rewritten. */
export function withoutSections(
	file: OmompFile,
	sections: readonly string[],
): { readonly kind: "ok"; readonly text: string; readonly empty: boolean } | { readonly kind: "invalid"; readonly reason: string } {
	if (file.format === "yaml") return removeYamlSections(file.text, file.root, sections);
	const rest = Object.fromEntries(Object.entries(file.root).filter(([key]) => !sections.includes(key)));
	return { kind: "ok", text: `${JSON.stringify(rest, null, 2)}\n`, empty: Object.keys(rest).length === 0 };
}

/** Whether a mapping still holds any section omp-config owns. */
export function holdsOwnedSection(root: Mapping): boolean {
	return Object.keys(root).some((key) => OWNED.includes(key));
}

/**
 * The agent definition files under `<agentDir>/agents` whose frontmatter `name`
 * is `name`, with `splitCheck: true` added; `present` when it already says true,
 * `declined` when it sets another value (the machine's own choice).
 */
export function splitCheckEdit(
	agentDir: string,
	name: string,
):
	| { readonly kind: "edit"; readonly rel: string; readonly content: string }
	| { readonly kind: "present" }
	| { readonly kind: "declined"; readonly rel: string }
	| { readonly kind: "missing" } {
	const dir = join(agentDir, "agents");
	let entries: string[];
	try {
		entries = readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort();
	} catch {
		// No agents directory: nothing declares the name.
		return { kind: "missing" };
	}
	for (const entry of entries) {
		const text = readFileSync(join(dir, entry), "utf8");
		const parsed = parseFrontmatter(text);
		if (parsed === null || unquote(parsed.fields.name ?? "") !== name) continue;
		const rel = `agent/agents/${entry}`;
		const current = parsed.fields.splitcheck;
		if (current !== undefined) return unquote(current).toLowerCase() === "true" ? { kind: "present" } : { kind: "declined", rel };
		const close = /\r?\n---(\r?\n|$)/.exec(text.slice(3));
		if (close === null) continue;
		const at = 3 + close.index;
		const newline = close[0].startsWith("\r\n") ? "\r\n" : "\n";
		return { kind: "edit", rel, content: `${text.slice(0, at)}${newline}splitCheck: true${text.slice(at)}` };
	}
	return { kind: "missing" };
}

// --- OMP plugin CLI -----------------------------------------------------------

export type PluginState =
	| { readonly kind: "registered"; readonly settings: Mapping }
	| { readonly kind: "elsewhere"; readonly path: string; readonly settings: Mapping }
	| { readonly kind: "unregistered" }
	| { readonly kind: "failed"; readonly error: string };

/**
 * One `omp plugin …` call, run from `/`: OMP lists a plugin's settings with the
 * cwd's `.omp/plugin-overrides.json` laid over them, and the updater reads and
 * writes the machine's own values (the machine scope of `_shared/plugin-settings.ts`).
 */
function runOmp(
	omp: string,
	args: readonly string[],
): { readonly ok: true; readonly out: string } | { readonly ok: false; readonly error: string } {
	const result = spawnSync(omp, args, { encoding: "utf8", cwd: "/" });
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) return { ok: false, error: `omp ${args.slice(0, 3).join(" ")}: ${(result.stderr || result.stdout).trim()}` };
	return { ok: true, out: result.stdout };
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		// A dangling registration is not this directory.
		return false;
	}
}

/** Whether OMP knows plugin `omp-config` and from where, and its stored settings; asked through the CLI. */
export function pluginState(omp: string, pluginDir: string): PluginState {
	const listed = runOmp(omp, ["plugin", "list", "--json"]);
	if (!listed.ok) return { kind: "failed", error: listed.error };
	let entry: Mapping | undefined;
	try {
		const value: unknown = JSON.parse(listed.out);
		if (!isMapping(value) || !Array.isArray(value.npm)) return { kind: "failed", error: "omp plugin list: unexpected output" };
		entry = value.npm.find((item: unknown): item is Mapping => isMapping(item) && item.name === PLUGIN_NAME);
	} catch (error) {
		return { kind: "failed", error: `omp plugin list: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (entry === undefined) return { kind: "unregistered" };
	const config = runOmp(omp, ["plugin", "config", "list", PLUGIN_NAME, "--json"]);
	if (!config.ok) return { kind: "failed", error: config.error };
	let settings: Mapping;
	try {
		const value: unknown = JSON.parse(config.out);
		if (!isMapping(value) || !isMapping(value.settings)) return { kind: "failed", error: "omp plugin config list: unexpected output" };
		settings = value.settings;
	} catch (error) {
		return { kind: "failed", error: `omp plugin config list: ${error instanceof Error ? error.message : String(error)}` };
	}
	const path = typeof entry.path === "string" ? entry.path : "";
	return samePath(path, pluginDir) ? { kind: "registered", settings } : { kind: "elsewhere", path, settings };
}

/** `omp plugin link <dir>`; the error text, or undefined. */
export function linkPlugin(omp: string, pluginDir: string): string | undefined {
	const result = runOmp(omp, ["plugin", "link", pluginDir]);
	return result.ok ? undefined : result.error;
}

/** `omp plugin config set omp-config <key> <value>`; OMP checks the value against the manifest. */
export function setPluginSetting(omp: string, key: string, value: Scalar): string | undefined {
	const result = runOmp(omp, ["plugin", "config", "set", PLUGIN_NAME, key, String(value)]);
	return result.ok ? undefined : result.error;
}
