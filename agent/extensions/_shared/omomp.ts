import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getAgentDir, type zod } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";

/**
 * Unified extension configuration. Every extension keeps its settings as one
 * top-level section of an `omomp` file; the section id is the extension's
 * directory name, so `defineOmompSection(import.meta.dir, schema)` is the whole
 * mapping from file to extension. A `_shared` module whose behavior several
 * extensions share owns one section named after its file
 * (`defineSharedOmompSection(import.meta.path, schema)`). Sections are never
 * deep-merged.
 *
 * Locations, first valid copy wins per section:
 *   1. `<cwd>/.omp/omomp.{yml,yaml,json,toml}`  (project; skipped when cwd is null)
 *   2. `<agent dir>/omomp.{yml,yaml,json,toml}`  (profile-aware)
 * A location holding two omomp files is reported and skipped.
 */

export type ConfigProblem = { readonly path: string; readonly reason: string };

export type ConfigLoad<T> =
	| { readonly kind: "found"; readonly value: T; readonly path: string; readonly skipped: readonly ConfigProblem[] }
	| { readonly kind: "none"; readonly skipped: readonly ConfigProblem[] };

export type OmompSection<T> = {
	readonly id: string;
	readonly schema: zod.ZodLikeSchema<T>;
};

const BASENAME = "omomp";
const EXTENSIONS = ["yml", "yaml", "json", "toml"] as const;
type Ext = (typeof EXTENSIONS)[number];
type Root = Readonly<Record<string, unknown>>;

/** Bind an extension's config type to its section. `extensionDir` is `import.meta.dir`. */
export function defineOmompSection<T>(extensionDir: string, schema: zod.ZodLikeSchema<T>): OmompSection<T> {
	return { id: basename(extensionDir), schema };
}

/** Bind a `_shared` module's config type to its section. `modulePath` is `import.meta.path`; the id is the file name without `.ts`. */
export function defineSharedOmompSection<T>(modulePath: string, schema: zod.ZodLikeSchema<T>): OmompSection<T> {
	return { id: basename(modulePath, extname(modulePath)), schema };
}

type Located =
	| { readonly kind: "file"; readonly path: string; readonly ext: Ext }
	| { readonly kind: "none" }
	| { readonly kind: "ambiguous"; readonly paths: readonly string[] };

function locate(dir: string): Located {
	const found: string[] = [];
	for (const ext of EXTENSIONS) {
		const path = join(dir, `${BASENAME}.${ext}`);
		if (existsSync(path)) found.push(path);
	}
	if (found.length === 0) return { kind: "none" };
	if (found.length > 1) return { kind: "ambiguous", paths: found };
	const path = found[0] as string;
	return { kind: "file", path, ext: extname(path).slice(1) as Ext };
}

type Parsed = { readonly kind: "ok"; readonly root: Root } | { readonly kind: "error"; readonly reason: string };

function parseText(text: string, ext: Ext): unknown {
	switch (ext) {
		case "yml":
		case "yaml":
			return Bun.YAML.parse(text);
		case "json":
			return JSON.parse(text);
		case "toml":
			return Bun.TOML.parse(text);
	}
}

function readRoot(path: string, ext: Ext): Parsed {
	let value: unknown;
	try {
		value = parseText(readFileSync(path, "utf8"), ext);
	} catch (error) {
		return { kind: "error", reason: errorText(error) };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "error", reason: "root is not a mapping" };
	return { kind: "ok", root: value as Root };
}

function locations(cwd: string | null): readonly string[] {
	return cwd === null ? [getAgentDir()] : [join(cwd, ".omp"), getAgentDir()];
}

/**
 * The section from the first location holding a valid copy. A location without
 * the section is passed over silently; an unreadable, ambiguous or invalid one
 * is recorded in `skipped` and the next location is tried.
 */
export function loadOmompSection<T>(section: OmompSection<T>, cwd: string | null): ConfigLoad<T> {
	const skipped: ConfigProblem[] = [];
	for (const dir of locations(cwd)) {
		const located = locate(dir);
		if (located.kind === "none") continue;
		if (located.kind === "ambiguous") {
			skipped.push({ path: dir, reason: `several ${BASENAME} files: ${located.paths.map((p) => basename(p)).join(", ")}` });
			continue;
		}
		const parsed = readRoot(located.path, located.ext);
		if (parsed.kind === "error") {
			skipped.push({ path: located.path, reason: parsed.reason });
			continue;
		}
		if (!Object.hasOwn(parsed.root, section.id)) continue;
		const result = section.schema.safeParse(parsed.root[section.id]);
		if (result.success) return { kind: "found", value: result.data, path: located.path, skipped };
		skipped.push({
			path: `${located.path}#${section.id}`,
			reason: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
		});
	}
	return { kind: "none", skipped };
}

/**
 * Write one section into the agent-directory omomp file, creating `omomp.yml`
 * when none exists. Other sections are kept; the file is replaced atomically.
 */
export function writeOmompSection(sectionId: string, value: unknown): string {
	const dir = getAgentDir();
	const located = locate(dir);
	if (located.kind === "ambiguous") throw new Error(`several ${BASENAME} files in ${dir}`);
	let root: Record<string, unknown> = {};
	let path = join(dir, `${BASENAME}.yml`);
	let ext: Ext = "yml";
	if (located.kind === "file") {
		const parsed = readRoot(located.path, located.ext);
		if (parsed.kind === "error") throw new Error(`cannot update ${located.path}: ${parsed.reason}`);
		root = { ...parsed.root };
		path = located.path;
		ext = located.ext;
	}
	root[sectionId] = value;
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, serialize(root, ext));
	renameSync(temp, path);
	return path;
}

function serialize(root: Root, ext: Ext): string {
	switch (ext) {
		case "yml":
		case "yaml": {
			// Bun.YAML.stringify leaves "key: " before nested blocks; drop that space and
			// refuse to write anything that does not parse back to the same value.
			const text = `${Bun.YAML.stringify(root, null, 2).replace(/:[ ]+$/gm, ":")}\n`;
			if (!Bun.deepEquals(Bun.YAML.parse(text), root)) throw new Error("serialized omomp YAML does not round-trip");
			return text;
		}
		case "json":
			return `${JSON.stringify(root, null, 2)}\n`;
		case "toml":
			return Bun.TOML.stringify(root);
	}
}
