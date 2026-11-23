import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { type BaseRecord, type RepoHistory, unmodifiedSection } from "./base.ts";
import { atomicWrite, isAppManaged } from "./files.ts";
import { isMapping, type Mapping, parseStructured, serialize, setAt, valueAt } from "./merge.ts";
import {
	holdsOwnedSection,
	type Manifest,
	type OmompPlan,
	parseManifest,
	planOmompMigration,
	type RoleBinding,
	type SectionMove,
	splitCheckEdit,
	withoutSections,
} from "./omomp-migration.ts";
import {
	CONFIG_REL,
	EXCLUDE_KEY,
	EXCLUDED_REASON,
	type Exclusions,
	fieldExcluded,
	OMOMP_REL,
	PLUGIN_DIR,
	PLUGIN_NAME,
	parseExclusions,
	plainRelExcluded,
	targetOf,
} from "./paths.ts";
import { linkPlugin, type PluginState, pluginState, setPluginSetting } from "./plugins.ts";
import type { ApplyOptions, ApplyReport } from "./report.ts";

export interface SettingsPreflight {
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
	return (section, value) => unmodifiedSection(base, history, OMOMP_REL, "yaml", [section], value);
}

export function settingsPreflight(opts: ApplyOptions, base: BaseRecord, history: RepoHistory): SettingsPreflight {
	const manifest = readManifest(opts.source);
	const omp = opts.plugins ? Bun.which("omp") : null;
	const plugin: PluginState = omp === null ? { kind: "unregistered" } : pluginState(omp, pluginDirOf(opts.agentDir));
	if (plugin.kind === "failed") throw new Error(`plugin ${PLUGIN_NAME}: ${plugin.error}; nothing applied`);
	const plan = planOmompMigration({
		agentDir: opts.agentDir,
		manifest: manifest ?? new Map(),
		shipped: shippedSection(base, history),
		appManaged: (path) => isAppManaged(path),
	});
	return { omp, plugin, manifest, plan };
}

export function exclusionsOf(preflight: SettingsPreflight, agentDir: string, fieldFiles: readonly string[]): Exclusions {
	const stored =
		preflight.plugin.kind === "unregistered" || preflight.plugin.kind === "failed" ? undefined : preflight.plugin.settings[EXCLUDE_KEY];
	if (stored !== undefined) {
		if (typeof stored !== "string") throw new Error(`plugin setting ${EXCLUDE_KEY} is not a string; nothing applied`);
		return parseExclusions(
			stored.split(/\s+/).filter((entry) => entry !== ""),
			`plugin setting ${EXCLUDE_KEY}`,
			fieldFiles,
		);
	}
	const pending = preflight.plan.kind === "none" ? undefined : preflight.plan.pendingExclude;
	return parseExclusions(pending ?? [], `${join(agentDir, "omomp.yml")}: ${EXCLUDE_KEY}`, fieldFiles);
}

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

function machineRoles(agentDir: string): Mapping {
	const target = targetOf(CONFIG_REL, agentDir);
	if (!existsSync(target)) return {};
	const roles = valueAt(parseStructured(readFileSync(target, "utf8"), "yaml"), ["modelRoles"]);
	if (roles === undefined) return {};
	if (!isMapping(roles)) throw new Error(`${target}: modelRoles is not a mapping`);
	return roles;
}

export function reportPendingSettings(opts: ApplyOptions, preflight: SettingsPreflight): string[] {
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
			const after = pluginState(omp, dir);
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
			case "unreadable":
				report.notes.push(
					`${targetOf(edit.rel, opts.agentDir)}: frontmatter does not parse (${edit.reason}); splitCheck not added, left as it is`,
				);
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

export function settleSettings(
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
	const after = pluginState(omp, pluginDirOf(opts.agentDir));
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
