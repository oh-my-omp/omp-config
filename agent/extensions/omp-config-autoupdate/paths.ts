import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Path } from "./merge.ts";

export const PLUGIN_NAME = "omp-config";
export const PLUGIN_DIR = "extensions/_shared";
export const ROOT_CHANGELOG_REL = "CHANGELOG.md";
export const CONFIG_REL = "agent/config.yml";
export const OMOMP_REL = "agent/omomp.yml";
export const EXCLUDE_KEY = "omp-config-autoupdate.exclude";
export const EXCLUDED_REASON = `excluded by the machine (${EXCLUDE_KEY})`;

export function agentPathOf(rel: string): string {
	if (rel === ROOT_CHANGELOG_REL) return `${PLUGIN_DIR}/CHANGELOG.md`;
	if (rel.startsWith("agent/")) return rel.slice("agent/".length);
	throw new Error(`no target for ${rel}`);
}

export function targetOf(rel: string, agentDir: string): string {
	return join(agentDir, agentPathOf(rel));
}

export function agentRelOf(agentDir: string, target: string): string | undefined {
	const rel = relative(resolve(agentDir), resolve(target));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return `agent/${rel.split(sep).join("/")}`;
}

export function coversPath(field: Path, path: Path): boolean {
	return field.length <= path.length && field.every((part, index) => part === path[index]);
}

export interface Exclusions {
	readonly plain: readonly ((leaf: string) => boolean)[];
	readonly fields: ReadonlyMap<string, readonly Path[]>;
}

const GLOB_MAGIC = /[*?[\]{}!\\]/;

export function parseExclusions(raw: readonly string[], origin: string, fieldFiles: readonly string[]): Exclusions {
	const normalize = (entry: string): string => {
		const trimmed = entry.trim();
		const parts = (trimmed.startsWith("agent/") ? trimmed.slice("agent/".length) : trimmed).split("/");
		if (isAbsolute(trimmed) || parts.some((part) => part === "" || part === "." || part === ".."))
			throw new Error(`${origin}: invalid exclude entry ${JSON.stringify(entry)}: expected an agent-dir relative path or glob`);
		return parts.join("/");
	};
	const plain: ((leaf: string) => boolean)[] = [];
	const fields = new Map<string, Path[]>();
	for (const entry of raw) {
		const colon = entry.indexOf(":");
		if (colon >= 0) {
			const item = `agent/${normalize(entry.slice(0, colon))}`;
			const field = entry.slice(colon + 1);
			const segments = field.split(".");
			if (!fieldFiles.includes(item) || field === "" || segments.some((segment) => segment === ""))
				throw new Error(
					`${origin}: invalid exclude entry ${JSON.stringify(entry)}: use <structured file>:<dotted field path>, the file being config.yml or omomp.yml`,
				);
			const listed = fields.get(item);
			if (listed === undefined) fields.set(item, [segments]);
			else listed.push(segments);
			continue;
		}
		const pattern = normalize(entry);
		if (GLOB_MAGIC.test(pattern)) {
			const glob = new Bun.Glob(pattern);
			plain.push((leaf) => glob.match(leaf));
		} else plain.push((leaf) => leaf === pattern || leaf.startsWith(`${pattern}/`));
	}
	return { plain, fields };
}

export function plainRelExcluded(rel: string, exclusions: Exclusions): boolean {
	const leaf = agentPathOf(rel);
	return exclusions.plain.some((match) => match(leaf));
}

export function fieldExcluded(item: string, path: Path, exclusions: Exclusions): boolean {
	return (exclusions.fields.get(item) ?? []).some((field) => coversPath(field, path));
}
