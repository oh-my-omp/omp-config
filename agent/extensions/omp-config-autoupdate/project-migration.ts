// One-time move of a project's omp-config omomp sections (`<project>/.omp/omomp.*`,
// which OMP once read before the machine's) into that project: scalars into
// `.omp/plugin-overrides.json` under `settings["omp-config"]`, which OMP lays
// over the machine's plugin settings for this project, and model-compaction
// rules into `.omp/COMPACTION-rule-NN.md`, which rule before the machine's.
// Run by the omp-config-autoupdate extension when a main session starts in the
// project; nothing else reads the project's omomp file. Only omp-config's own
// sections leave the file; data with no project-level place stays with a reason.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMapping, type Mapping } from "./merge.ts";
import {
	type Manifest,
	PLUGIN_NAME,
	type ProjectPlan,
	planProjectMigration,
	type SectionMove,
	withoutSections,
} from "./omomp-migration.ts";

export type Kept = { readonly section: string; readonly reason: string };

/** What a project holds to move, before anything is written. */
export type ProjectWork =
	| { readonly kind: "none" }
	| { readonly kind: "blocked"; readonly reason: string }
	| {
			readonly kind: "ready";
			readonly projectDir: string;
			readonly plan: Extract<ProjectPlan, { kind: "ready" }>;
			/** Files the move writes or deletes, absolute; empty when only kept sections remain. */
			readonly files: readonly string[];
	  };

export type ProjectResult = {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly kept: readonly Kept[];
	readonly notes: readonly string[];
};

const overridesPath = (projectDir: string): string => join(projectDir, ".omp", "plugin-overrides.json");

export function planProject(projectDir: string, manifest: Manifest): ProjectWork {
	const plan = planProjectMigration(projectDir, manifest);
	if (plan.kind !== "ready") return plan;
	const files = new Set<string>();
	for (const move of plan.moves) {
		if (move.settings.size > 0) files.add(overridesPath(projectDir));
		for (const file of move.files) files.add(join(projectDir, file.rel));
	}
	if (plan.moves.length > 0) files.add(plan.file.path);
	return { kind: "ready", projectDir, plan, files: [...files] };
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.omp-config-${process.pid}.tmp`);
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** The project's overrides file as a mapping, `{}` when absent; anything else throws. */
function readOverrides(path: string): Mapping {
	if (!existsSync(path)) return {};
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isMapping(value)) throw new Error(`${path}: not a JSON object`);
	if (
		value.settings !== undefined &&
		!(isMapping(value.settings) && (value.settings[PLUGIN_NAME] === undefined || isMapping(value.settings[PLUGIN_NAME])))
	)
		throw new Error(`${path}: settings.${PLUGIN_NAME} is not an object`);
	return value;
}

/**
 * Carry out `work`: settings the project has not overridden yet, rule files that
 * do not exist yet (or already hold the same rule), then the sections leave the
 * omomp file once the overrides file reads back with every value.
 */
export function migrateProject(work: Extract<ProjectWork, { kind: "ready" }>): ProjectResult {
	const { projectDir, plan } = work;
	const written: string[] = [];
	const deleted: string[] = [];
	const kept: Kept[] = [...plan.kept];
	const notes: string[] = [];
	const path = overridesPath(projectDir);
	let overrides: Mapping;
	try {
		overrides = readOverrides(path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { written, deleted, kept: [...kept, ...plan.moves.map((move) => ({ section: move.section, reason }))], notes };
	}
	const settings: Mapping = isMapping(overrides.settings) ? { ...overrides.settings } : {};
	const own: Mapping = isMapping(settings[PLUGIN_NAME]) ? { ...settings[PLUGIN_NAME] } : {};
	const moved: SectionMove[] = [];
	const files: { target: string; content: string }[] = [];
	for (const move of plan.moves) {
		const targets = move.files.map((file) => ({ target: join(projectDir, file.rel), content: file.content }));
		const clash = targets.find(({ target, content }) => existsSync(target) && readFileSync(target, "utf8") !== content);
		if (clash !== undefined) {
			kept.push({ section: move.section, reason: `${clash.target} already exists` });
			continue;
		}
		for (const [key, value] of move.settings) {
			if (Object.hasOwn(own, key))
				notes.push(`${path} already sets ${key} (${JSON.stringify(own[key])}); omomp value ${JSON.stringify(value)} not applied`);
			else own[key] = value;
		}
		files.push(...targets.filter(({ target }) => !existsSync(target)));
		notes.push(...move.notes);
		moved.push(move);
	}
	if (moved.length === 0) return { written, deleted, kept, notes };
	if (moved.some((move) => move.settings.size > 0)) {
		writeAtomic(path, `${JSON.stringify({ ...overrides, settings: { ...settings, [PLUGIN_NAME]: own } }, null, 2)}\n`);
		written.push(path);
		const back = readOverrides(path).settings;
		const stored = isMapping(back) && isMapping(back[PLUGIN_NAME]) ? back[PLUGIN_NAME] : {};
		const missing = moved.flatMap((move) => [...move.settings.keys()].filter((key) => !Object.hasOwn(stored, key)));
		if (missing.length > 0) {
			kept.push(...moved.map((move) => ({ section: move.section, reason: `${path} does not hold ${missing.join(", ")}` })));
			return { written, deleted, kept, notes };
		}
	}
	for (const { target, content } of files) {
		writeAtomic(target, content);
		written.push(target);
	}
	const sections = moved.map((move) => move.section);
	const rewritten = withoutSections(plan.file, sections);
	if (rewritten.kind === "invalid") {
		notes.push(`${sections.join(", ")} moved but left in ${plan.file.path}: ${rewritten.reason}; delete them by hand`);
		return { written, deleted, kept, notes };
	}
	if (rewritten.empty) {
		unlinkSync(plan.file.path);
		deleted.push(plan.file.path);
	} else {
		writeAtomic(plan.file.path, rewritten.text);
		written.push(plan.file.path);
	}
	return { written, deleted, kept, notes };
}
