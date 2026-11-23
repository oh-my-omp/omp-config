import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { isMapping, type Mapping } from "./merge.ts";
import { PLUGIN_NAME } from "./paths.ts";

export const OMOMP_FILES = ["omomp.yml", "omomp.yaml", "omomp.json", "omomp.toml"] as const;

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

const LEGACY_SOURCES: Partial<Record<Section, readonly string[]>> = {
	"lang-nag": ["extensions/lang-nag/lang-nag.json", "extensions/lang-nag.json"],
	"input-polish": ["extensions/input-polish/input-polish.json"],
	"tool-policy-nag": ["extensions/tool-policy-nag/tool-policy-nag.json", "extensions/tool-policy-nag.json"],
	"task-completion-judge": ["extensions/task-completion-judge/task-completion-judge.json", "extensions/task-completion-judge.json"],
	"doc-polish": ["extensions/doc-polish/doc-polish.json", "extensions/doc-polish.json"],
	"model-compaction": ["extensions/model-compaction/model-compaction.json"],
	"omp-config-autoupdate": ["extensions/omp-config-autoupdate/omp-config-autoupdate.json", "omp-config-autoupdate.json"],
};

const FALLBACK_ROLES: Partial<Record<Section, readonly string[]>> = {
	judge: [],
	"input-polish": ["input-polish"],
	"task-completion-judge": ["task-completion-judge"],
	"task-split-check": ["task-split-check"],
};

const RETIRED: readonly Section[] = ["doc-polish"];

export type RoleBinding = { readonly role: string; readonly value: string };

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

export type PlannedFile = { readonly rel: string; readonly content: string };

export type SectionMove = {
	readonly section: string;
	readonly from: { readonly kind: "omomp" } | { readonly kind: "legacy"; readonly rel: string };
	readonly settings: ReadonlyMap<string, Scalar>;
	readonly files: readonly PlannedFile[];
	readonly splitAgents: readonly string[];
	readonly bindings: readonly RoleBinding[];
	readonly notes: readonly string[];
};

export type OmompFile = {
	readonly path: string;
	readonly format: "yaml" | "json";
	readonly text: string;
	readonly root: Mapping;
};

export type Kept = { readonly section: string; readonly reason: string };

function collect(section: Section, from: SectionMove["from"], translation: Translation, moves: SectionMove[], kept: Kept[]): void {
	switch (translation.kind) {
		case "invalid":
			kept.push({ section, reason: translation.reason });
			return;
		case "ok":
			moves.push({ section, from, ...translation });
			return;
		default: {
			const unreachable: never = translation;
			throw new Error(`unknown translation ${String(unreachable)}`);
		}
	}
}

export type OmompPlan =
	| { readonly kind: "none" }
	| { readonly kind: "blocked"; readonly reason: string; readonly pendingExclude: readonly string[] | undefined }
	| {
			readonly kind: "ready";
			readonly file: OmompFile | undefined;
			readonly moves: readonly SectionMove[];
			readonly kept: readonly Kept[];
			readonly pendingExclude: readonly string[] | undefined;
	  };

export interface PlanInput {
	readonly agentDir: string;
	readonly manifest: Manifest;
	readonly shipped: (section: string, value: unknown) => boolean;
	readonly appManaged: (path: string) => boolean;
}

type Translation =
	| {
			readonly kind: "ok";
			readonly settings: ReadonlyMap<string, Scalar>;
			readonly files: readonly PlannedFile[];
			readonly splitAgents: readonly string[];
			readonly bindings: readonly RoleBinding[];
			readonly notes: readonly string[];
	  }
	| { readonly kind: "invalid"; readonly reason: string };

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

function compactionFile(rule: unknown, index: number, dir: string): PlannedFile | string {
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
		rel: `${dir}/COMPACTION-rule-${String(index + 1).padStart(2, "0")}.md`,
		content: `---\n${lines.join("\n")}\n---\n`,
	};
}

export type TranslateScope =
	| { readonly kind: "machine"; readonly shipped: (section: string, value: unknown) => boolean }
	| { readonly kind: "project" };

const MACHINE_ONLY: readonly Section[] = ["omomp-lang", "omp-config-autoupdate", "subagent-usage"];

function translate(section: Section, value: unknown, manifest: Manifest, scope: TranslateScope): Translation {
	const invalid = (reason: string): Translation => ({ kind: "invalid", reason });
	if (RETIRED.includes(section)) {
		const notes = [`${section} section dropped: the ${section} extension is retired`];
		return { kind: "ok", settings: new Map(), files: [], splitAgents: [], bindings: [], notes };
	}
	if (!isMapping(value)) return invalid("not a mapping");
	if (scope.kind === "project" && MACHINE_ONLY.includes(section))
		return invalid("OMP never read this section from a project; set it in /settings → Plugins → omp-config, then delete it here");
	const notes: string[] = [];
	const bindings: RoleBinding[] = [];
	let rest: Mapping = { ...value };
	const roles = FALLBACK_ROLES[section];
	if (roles !== undefined && Object.hasOwn(rest, "fallbackRole")) {
		const { fallbackRole, ...others } = rest;
		rest = others;
		if (typeof fallbackRole !== "string" || fallbackRole.trim().replace(/^@/, "") === "")
			return invalid("fallbackRole must be a role name");
		const target = `@${fallbackRole.trim().replace(/^@/, "")}`;
		if (roles.length === 0)
			notes.push(`${section}.fallbackRole (${fallbackRole.trim()}) dropped: an unassigned @<purpose> role now uses OMP's judge role chain`);
		else if (scope.kind === "project")
			return invalid(
				`fallbackRole has no project-level place: assign ${roles.map((role) => `@${role}`).join(", ")} in /model, then delete it here`,
			);
		bindings.push(...roles.map((role) => ({ role, value: target })));
	}
	const files: PlannedFile[] = [];
	const splitAgents: string[] = [];
	const lists = (): Translation => ({ kind: "ok", settings: new Map(), files, splitAgents, bindings, notes });
	switch (section) {
		case "tool-topic-injection":
			if (scope.kind === "project")
				return invalid(
					"injection rules have no project-level place: move them into a TOPIC-*.md inject list by hand, then delete the section",
				);
			if (!scope.shipped(section, value))
				return invalid(
					"customized rules: move them into the inject list of the matching extensions/tool-topics/TOPIC-*.md by hand, then delete the section",
				);
			return lists();
		case "model-compaction": {
			const { rules, ...unknown } = rest;
			if (Object.keys(unknown).length > 0 || !Array.isArray(rules)) return invalid("expected only a rules list");
			for (const [index, rule] of rules.entries()) {
				const file = compactionFile(rule, index, scope.kind === "project" ? ".omp" : "agent/extensions/model-compaction");
				if (typeof file === "string") return invalid(file);
				files.push(file);
			}
			return lists();
		}
		case "task-split-check": {
			const { agents, ...unknown } = rest;
			if (Object.keys(unknown).length > 0) return invalid(`unknown keys ${Object.keys(unknown).join(", ")}`);
			if (agents !== undefined && (!Array.isArray(agents) || !agents.every((name) => typeof name === "string" && name.trim() !== "")))
				return invalid("agents must be a list of agent names");
			if (agents !== undefined && scope.kind === "project")
				return invalid("agents have no project-level place: add splitCheck: true to their agent definitions, then delete it here");
			if (agents !== undefined) splitAgents.push(...agents.map((name: string) => name.trim()));
			return lists();
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
		const checked = checkSetting(manifest, key, leaf);
		if (checked.kind === "bad") return invalid(checked.reason);
		if (scope.kind === "project" || checked.value !== manifest.get(key)?.default) settings.set(key, checked.value);
	}
	return { kind: "ok", settings, files, splitAgents, bindings, notes };
}

function parseOmomp(path: string, text: string): Mapping {
	const value: unknown = path.endsWith(".json") ? JSON.parse(text) : path.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.YAML.parse(text);
	if (value == null) return {};
	if (!isMapping(value)) throw new Error("root is not a mapping");
	return value;
}

function excludeOf(section: unknown, where: string): readonly string[] | undefined {
	if (!isMapping(section) || section.exclude === undefined) return undefined;
	const exclude = section.exclude;
	if (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === "string"))
		throw new Error(`${where}: omp-config-autoupdate.exclude must be a list of strings`);
	return exclude;
}

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
			unreadable.push(`${path}: ${errorText(error)}`);
		}
	}
	if (parsed.length > 1) {
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
	const kept: Kept[] = [];
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
				kept.push({ section, reason: `${path}: ${errorText(error)}` });
				continue;
			}
			from = { kind: "legacy", rel: `agent/${rel}` };
		}
		if (section === "omp-config-autoupdate") pendingExclude = excludeOf(value, from.kind === "omomp" ? (file?.path ?? "") : from.rel);
		collect(section, from, translate(section, value, input.manifest, { kind: "machine", shipped: input.shipped }), moves, kept);
	}
	if (file === undefined && moves.length === 0 && kept.length === 0) return { kind: "none" };
	return { kind: "ready", file, moves, kept, pendingExclude };
}

export type ProjectPlan =
	| { readonly kind: "none" }
	| { readonly kind: "blocked"; readonly reason: string }
	| {
			readonly kind: "ready";
			readonly file: OmompFile;
			readonly moves: readonly SectionMove[];
			readonly kept: readonly Kept[];
	  };

export function planProjectMigration(projectDir: string, manifest: Manifest): ProjectPlan {
	const dir = join(projectDir, ".omp");
	const holders: OmompFile[] = [];
	for (const name of OMOMP_FILES) {
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		let root: Mapping;
		try {
			root = parseOmomp(path, text);
		} catch (error) {
			return { kind: "blocked", reason: `${path}: ${errorText(error)}` };
		}
		if (holdsOwnedSection(root)) holders.push({ path, text, root, format: path.endsWith(".json") ? "json" : "yaml" });
	}
	if (holders.length > 1)
		return { kind: "blocked", reason: `several omomp files in ${dir}: ${holders.map((file) => file.path).join(", ")}` };
	const [file] = holders;
	if (file === undefined) return { kind: "none" };
	if (file.path.endsWith(".toml")) return { kind: "blocked", reason: `${file.path}: a TOML file cannot be rewritten here` };
	const moves: SectionMove[] = [];
	const kept: Kept[] = [];
	for (const section of SECTIONS) {
		if (Object.hasOwn(file.root, section))
			collect(section, { kind: "omomp" }, translate(section, file.root[section], manifest, { kind: "project" }), moves, kept);
	}
	return { kind: "ready", file, moves, kept };
}

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
	} catch {}
	return { kind: "invalid", reason: "removing the sections would change other YAML values" };
}

export function withoutSections(
	file: OmompFile,
	sections: readonly string[],
): { readonly kind: "ok"; readonly text: string; readonly empty: boolean } | { readonly kind: "invalid"; readonly reason: string } {
	if (file.format === "yaml") return removeYamlSections(file.text, file.root, sections);
	const rest = Object.fromEntries(Object.entries(file.root).filter(([key]) => !sections.includes(key)));
	return { kind: "ok", text: `${JSON.stringify(rest, null, 2)}\n`, empty: Object.keys(rest).length === 0 };
}

export function holdsOwnedSection(root: Mapping): boolean {
	return Object.keys(root).some((key) => OWNED.includes(key));
}

export function splitCheckEdit(
	agentDir: string,
	name: string,
):
	| { readonly kind: "edit"; readonly rel: string; readonly content: string }
	| { readonly kind: "present" }
	| { readonly kind: "declined"; readonly rel: string }
	| { readonly kind: "unreadable"; readonly rel: string; readonly reason: string }
	| { readonly kind: "missing" } {
	const dir = join(agentDir, "agents");
	let entries: string[];
	try {
		entries = readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort();
	} catch {
		return { kind: "missing" };
	}
	for (const entry of entries) {
		const text = readFileSync(join(dir, entry), "utf8");
		const parsed = parseFrontmatter(text);
		if (parsed === null || unquote(parsed.fields.name ?? "") !== name) continue;
		const rel = `agent/agents/${entry}`;
		const frontmatter = agentFrontmatter(text);
		if (frontmatter.kind === "unreadable") return { kind: "unreadable", rel, reason: frontmatter.reason };
		if (Object.hasOwn(frontmatter.fields, "splitCheck")) {
			return frontmatter.fields.splitCheck === true ? { kind: "present" } : { kind: "declined", rel };
		}
		const close = /\r?\n---(\r?\n|$)/.exec(text.slice(3));
		if (close === null) continue;
		const at = 3 + close.index;
		const newline = close[0].startsWith("\r\n") ? "\r\n" : "\n";
		return { kind: "edit", rel, content: `${text.slice(0, at)}${newline}splitCheck: true${text.slice(at)}` };
	}
	return { kind: "missing" };
}

// Must read agent definitions exactly as omp's parseFrontmatter with level "fatal" does: a looser reading marks
// definitions omp ignores as set, or inserts a second splitCheck key over the user's own value.
// @upstream adapted @oh-my-pi/pi-utils@19.1.0 src/frontmatter.ts#parseFrontmatter
// The level "fatal" path with normalize and repair on, run by bare bun without host packages: a parse failure is the unreadable result instead of a logged FrontmatterError, and the body is not returned.
function agentFrontmatter(
	content: string,
): { readonly kind: "parsed"; readonly fields: Mapping } | { readonly kind: "unreadable"; readonly reason: string } {
	const newlineNormalized = content.replace(/\r\n?/g, "\n");
	const normalized = stripLeadingHtmlComments(newlineNormalized);
	if (!normalized.startsWith("---")) return { kind: "parsed", fields: {} };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { kind: "parsed", fields: {} };
	const metadata = normalized.slice(4, endIndex).replace(/<!--[\s\S]*?-->/g, "");
	try {
		return { kind: "parsed", fields: camelKeys(yamlRecord(metadata)) };
	} catch (error) {
		const quoted = quoteAmbiguousPlainScalars(metadata);
		if (quoted !== undefined) {
			try {
				return { kind: "parsed", fields: camelKeys(yamlRecord(quoted)) };
			} catch {}
		}
		return { kind: "unreadable", reason: errorText(error) };
	}
}

function stripLeadingHtmlComments(content: string): string {
	const leading = /^(?:(?:\s*<!--[\s\S]*?-->)+)/.exec(content);
	if (leading === null) return content;
	const rest = content.slice(leading[0].length);
	return /^\s*---/.test(rest) ? rest.replace(/^\s+/, "") : content;
}

function yamlRecord(metadata: string): Mapping {
	const loaded: unknown = Bun.YAML.parse(metadata.replaceAll("\t", "  "));
	return isMapping(loaded) ? loaded : {};
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
	let changed = false;
	const lines = metadata.split("\n").map((line) => {
		const match = PLAIN_SCALAR_KEY_VALUE.exec(line);
		if (match === null) return line;
		const [, prefix = "", rawValue = "", suffix = ""] = match;
		const value = rawValue.trimEnd();
		if (!value.includes(": ")) return line;
		if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0] ?? "")) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : undefined;
}

function camelKeys(mapping: Mapping): Mapping {
	return Object.fromEntries(
		Object.entries(mapping).map(([key, item]) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), camelValue(item)]),
	);
}

function camelValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(camelValue);
	return isMapping(value) ? camelKeys(value) : value;
}
// @upstream-end
