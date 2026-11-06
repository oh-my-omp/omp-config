// One-time move of a project's omp-config omomp sections (`<project>/.omp/omomp.*`,
// which OMP once read before the machine's) into that project: scalars into
// `.omp/plugin-overrides.json` under `settings["omp-config"]`, which OMP lays
// over the machine's plugin settings for this project, and model-compaction
// rules into `.omp/COMPACTION-rule-NN.md`, which rule before the machine's.
// Run by the omp-config-autoupdate extension when a main session starts in the
// project; nothing else reads the project's omomp file. Only omp-config's own
// sections leave the file; data with no project-level place, or that would
// change what the project gets, stays with a reason.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMapping, type Mapping } from "./merge.ts";
import { type Manifest, PLUGIN_NAME, planProjectMigration, type Scalar, withoutSections } from "./omomp-migration.ts";

export type Kept = { readonly section: string; readonly reason: string };

type RuleFile = { readonly target: string; readonly content: string };

/** What a project holds to move, decided from disk before anything is written. */
export type ProjectWork =
	| { readonly kind: "none" }
	| { readonly kind: "blocked"; readonly reason: string }
	/** Sections are there but none can leave now: nothing would be written. */
	| { readonly kind: "stuck"; readonly path: string; readonly kept: readonly Kept[] }
	| {
			readonly kind: "ready";
			/** The project's omomp file. */
			readonly path: string;
			/** Sections that leave it. */
			readonly sections: readonly string[];
			/** The overrides file holding every value of the leaving sections; undefined when it already holds them all. */
			readonly overrides: { readonly path: string; readonly content: string } | undefined;
			/** Every value of the leaving sections, read back after the overrides file is written. */
			readonly values: ReadonlyMap<string, Scalar>;
			/** Rule files that do not exist yet. */
			readonly ruleFiles: readonly RuleFile[];
			/** The omomp file without the leaving sections; `delete` when nothing else is in it. */
			readonly omomp: { readonly kind: "rewrite"; readonly text: string } | { readonly kind: "delete" };
			readonly kept: readonly Kept[];
			readonly notes: readonly string[];
			/** Every file the move writes or deletes, absolute. */
			readonly files: readonly string[];
	  };

export type ProjectResult = {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly kept: readonly Kept[];
	readonly notes: readonly string[];
};

type Overrides =
	| { readonly kind: "ok"; readonly root: Mapping; readonly own: Mapping }
	| { readonly kind: "invalid"; readonly reason: string };

/** The project's overrides file and its omp-config settings, both `{}` when the file is absent. */
function readOverrides(path: string): Overrides {
	if (!existsSync(path)) return { kind: "ok", root: {}, own: {} };
	let root: unknown;
	try {
		root = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { kind: "invalid", reason: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isMapping(root)) return { kind: "invalid", reason: `${path}: not a JSON object` };
	if (root.settings === undefined) return { kind: "ok", root, own: {} };
	if (!isMapping(root.settings)) return { kind: "invalid", reason: `${path}: settings is not an object` };
	const own = root.settings[PLUGIN_NAME];
	if (own === undefined) return { kind: "ok", root, own: {} };
	if (!isMapping(own)) return { kind: "invalid", reason: `${path}: settings.${PLUGIN_NAME} is not an object` };
	return { kind: "ok", root, own };
}

/**
 * Plan the move of `projectDir`'s omomp sections. A section stays when its
 * rule file already exists with other content, when the overrides file cannot
 * be read and the section has values for it, or when the overrides file sets
 * one of its keys to another value: moving it then would change what the
 * project gets. A key the overrides file already sets to the same value needs
 * no write.
 */
export function planProject(projectDir: string, manifest: Manifest): ProjectWork {
	const plan = planProjectMigration(projectDir, manifest);
	if (plan.kind !== "ready") return plan;
	const path = join(projectDir, ".omp", "plugin-overrides.json");
	const overrides = readOverrides(path);
	const kept: Kept[] = [...plan.kept];
	const sections: string[] = [];
	const values = new Map<string, Scalar>();
	const added = new Map<string, Scalar>();
	const ruleFiles: RuleFile[] = [];
	const notes: string[] = [];
	for (const move of plan.moves) {
		const targets = move.files.map((file) => ({ target: join(projectDir, file.rel), content: file.content }));
		const clash = targets.find(({ target, content }) => existsSync(target) && readFileSync(target, "utf8") !== content);
		if (clash !== undefined) {
			kept.push({ section: move.section, reason: `${clash.target} already exists with other content` });
			continue;
		}
		if (move.settings.size > 0 && overrides.kind === "invalid") {
			kept.push({ section: move.section, reason: overrides.reason });
			continue;
		}
		const own = overrides.kind === "ok" ? overrides.own : {};
		const conflicts = [...move.settings].filter(([key, value]) => Object.hasOwn(own, key) && own[key] !== value);
		if (conflicts.length > 0) {
			const named = conflicts.map(([key, value]) => `${key} is ${JSON.stringify(own[key])} there, ${JSON.stringify(value)} here`);
			kept.push({ section: move.section, reason: `${path} conflicts: ${named.join("; ")}; keep one value and delete the other` });
			continue;
		}
		for (const [key, value] of move.settings) {
			values.set(key, value);
			if (!Object.hasOwn(own, key)) added.set(key, value);
		}
		ruleFiles.push(...targets.filter(({ target }) => !existsSync(target)));
		notes.push(...move.notes);
		sections.push(move.section);
	}
	if (sections.length === 0) return { kind: "stuck", path: plan.file.path, kept };
	const rewritten = withoutSections(plan.file, sections);
	if (rewritten.kind === "invalid")
		return {
			kind: "stuck",
			path: plan.file.path,
			kept: [...kept, ...sections.map((section) => ({ section, reason: `${plan.file.path} cannot drop it: ${rewritten.reason}` }))],
		};
	let next: { path: string; content: string } | undefined;
	if (added.size > 0 && overrides.kind === "ok") {
		const settings = isMapping(overrides.root.settings) ? overrides.root.settings : {};
		const own = { ...overrides.own, ...Object.fromEntries(added) };
		next = { path, content: `${JSON.stringify({ ...overrides.root, settings: { ...settings, [PLUGIN_NAME]: own } }, null, 2)}\n` };
	}
	return {
		kind: "ready",
		path: plan.file.path,
		sections,
		overrides: next,
		values,
		ruleFiles,
		omomp: rewritten.empty ? { kind: "delete" } : { kind: "rewrite", text: rewritten.text },
		kept,
		notes,
		files: [...(next === undefined ? [] : [next.path]), ...ruleFiles.map(({ target }) => target), plan.file.path],
	};
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

/**
 * Carry out `work`: the overrides file, read back with every value of the
 * leaving sections; then the rule files; then the sections leave the omomp
 * file, which is deleted once nothing else is in it.
 */
export function migrateProject(work: Extract<ProjectWork, { kind: "ready" }>): ProjectResult {
	const written: string[] = [];
	const deleted: string[] = [];
	if (work.overrides !== undefined) {
		writeAtomic(work.overrides.path, work.overrides.content);
		written.push(work.overrides.path);
		const back = readOverrides(work.overrides.path);
		const own = back.kind === "ok" ? back.own : {};
		const missing = [...work.values].filter(([key, value]) => own[key] !== value).map(([key]) => key);
		if (missing.length > 0) {
			const reason = `${work.overrides.path} does not hold ${missing.join(", ")}`;
			return { written, deleted, kept: [...work.kept, ...work.sections.map((section) => ({ section, reason }))], notes: work.notes };
		}
	}
	for (const { target, content } of work.ruleFiles) {
		writeAtomic(target, content);
		written.push(target);
	}
	switch (work.omomp.kind) {
		case "delete":
			unlinkSync(work.path);
			deleted.push(work.path);
			break;
		case "rewrite":
			writeAtomic(work.path, work.omomp.text);
			written.push(work.path);
			break;
		default: {
			const unreachable: never = work.omomp;
			return unreachable;
		}
	}
	return { written, deleted, kept: work.kept, notes: work.notes };
}
