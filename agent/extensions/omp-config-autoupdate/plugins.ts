import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { isMapping, type Mapping } from "./merge.ts";
import { PLUGIN_NAME } from "./paths.ts";
import type { ApplyOptions, ApplyReport, PluginChange, PluginRefresh } from "./report.ts";

type OmpRun = { readonly ok: true; readonly out: string } | { readonly ok: false; readonly error: string };

function runOmp(omp: string, args: readonly string[]): OmpRun {
	const result = spawnSync(omp, args, { encoding: "utf8", cwd: "/" });
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) return { ok: false, error: `omp ${args.slice(0, 3).join(" ")}: ${(result.stderr || result.stdout).trim()}` };
	return { ok: true, out: result.stdout };
}

function ompError(omp: string, args: readonly string[]): string | undefined {
	const result = runOmp(omp, args);
	return result.ok ? undefined : result.error;
}

export interface DeclaredPlugins {
	readonly required: string[];
	readonly optional: string[];
}

export function declaredPlugins(source: string): DeclaredPlugins {
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
			const error = ompError(omp, args);
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

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

export type PluginCatalog =
	| { readonly kind: "ok"; readonly entries: readonly unknown[] }
	| { readonly kind: "invalid"; readonly message: string };

export function pluginCatalog(): PluginCatalog {
	const omp = Bun.which("omp");
	if (omp === null) return { kind: "invalid", message: "Plugin readiness unavailable: omp is not on PATH" };
	const listed = runOmp(omp, ["plugin", "list", "--json"]);
	if (!listed.ok) return { kind: "invalid", message: `Plugin readiness query failed: ${listed.error}` };
	try {
		const value: unknown = JSON.parse(listed.out);
		if (!isMapping(value) || !Array.isArray(value.npm)) return { kind: "invalid", message: "Plugin readiness: invalid npm catalog" };
		return { kind: "ok", entries: value.npm };
	} catch (error) {
		return { kind: "invalid", message: `Plugin readiness cannot be confirmed (${errorText(error)})` };
	}
}

export interface RequiredPlugin {
	readonly name: string;
	readonly label: string;
	readonly requiredBy: (spec: string) => boolean;
	readonly entry: string;
	readonly files: readonly string[];
}

export type PluginReadiness =
	| { readonly kind: "ready"; readonly path: string }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string };

export function pluginReadiness(catalog: PluginCatalog, required: RequiredPlugin): PluginReadiness {
	if (catalog.kind === "invalid") return catalog;
	const { label } = required;
	let plugin: Mapping | undefined;
	for (const entry of catalog.entries) {
		if (!isMapping(entry) || entry.name !== required.name) continue;
		if (plugin !== undefined) return { kind: "invalid", message: `${label} readiness: ambiguous npm entries` };
		plugin = entry;
	}
	if (plugin === undefined) return { kind: "missing" };
	if (plugin.enabled !== true) return { kind: "invalid", message: `${label} is disabled or has invalid enablement; nothing switched` };
	if (!isMapping(plugin.manifest) || !isStringArray(plugin.manifest.extensions) || !plugin.manifest.extensions.includes(required.entry))
		return { kind: "invalid", message: `${label} does not declare ${required.entry}; nothing switched` };
	const path = plugin.path;
	if (typeof path !== "string" || !isAbsolute(path))
		return { kind: "invalid", message: `${label} entry is missing or invalid; nothing switched` };
	const missing = required.files.filter((rel) => !existsSync(join(path, rel)));
	if (missing.length > 0) return { kind: "invalid", message: `${label} is missing ${missing.join(", ")}; nothing switched` };
	return { kind: "ready", path };
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
				const error = ompError(omp, ["install", step.spec]);
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
				const error = ompError(omp, ["plugin", "upgrade", step.name]);
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
				const error = ompError(omp, ["install", step.spec]);
				if (error !== undefined) {
					errors.push(error);
					break;
				}
				const name = installedName(step.spec);
				const restore = step.disabled ? ompError(omp, ["plugin", "disable", name]) : undefined;
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

export function syncPlugins(opts: ApplyOptions, report: ApplyReport, plugins: DeclaredPlugins): void {
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

export function refreshMovingPlugins(source: string): PluginRefresh {
	const steps = planPlugins(declaredPlugins(source));
	const notes = unrecognizedNotes(steps);
	const moving = steps.filter((step) => step.kind !== "unrecognized" && movesOnItsOwn(step.spec));
	if (moving.length === 0) return { installed: [], upgraded: [], errors: [], changes: [], notes };
	const omp = Bun.which("omp");
	if (!omp) return { installed: [], upgraded: [], errors: ["plugins not refreshed: omp is not on PATH"], changes: [], notes };
	return { ...refreshPlugins(omp, moving), notes };
}

export type PluginState =
	| { readonly kind: "registered"; readonly settings: Mapping }
	| { readonly kind: "elsewhere"; readonly path: string; readonly settings: Mapping }
	| { readonly kind: "unregistered" }
	| { readonly kind: "failed"; readonly error: string };

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync.native(a) === realpathSync.native(b);
	} catch {
		return false;
	}
}

export function pluginState(omp: string, pluginDir: string): PluginState {
	const listed = runOmp(omp, ["plugin", "list", "--json"]);
	if (!listed.ok) return { kind: "failed", error: listed.error };
	let entry: Mapping | undefined;
	try {
		const value: unknown = JSON.parse(listed.out);
		if (!isMapping(value) || !Array.isArray(value.npm)) return { kind: "failed", error: "omp plugin list: unexpected output" };
		entry = value.npm.find((item: unknown): item is Mapping => isMapping(item) && item.name === PLUGIN_NAME);
	} catch (error) {
		return { kind: "failed", error: `omp plugin list: ${errorText(error)}` };
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
		return { kind: "failed", error: `omp plugin config list: ${errorText(error)}` };
	}
	const path = typeof entry.path === "string" ? entry.path : "";
	return samePath(path, pluginDir) ? { kind: "registered", settings } : { kind: "elsewhere", path, settings };
}

export function linkPlugin(omp: string, pluginDir: string): string | undefined {
	return ompError(omp, ["plugin", "link", pluginDir]);
}

export function setPluginSetting(omp: string, key: string, value: string | number | boolean): string | undefined {
	return ompError(omp, ["plugin", "config", "set", PLUGIN_NAME, key, String(value)]);
}
