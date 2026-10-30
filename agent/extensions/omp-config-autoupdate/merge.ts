// Three-way merge of structured files for omp-config-update.ts. Pure: no IO.
//
// Every path of a structured file has one owner rule (PathRules): `local`
// paths belong to the machine and are never read from the repo, `seed` paths
// are written only while the host lacks them, `machineLists` keep the host's
// own entries ahead of the repo's subsequence, and every other path the repo
// has (or had, per the base) is managed: host H, base B (the repo value the
// machine last accepted) and repo R decide it. H==R or H==B takes R; R==B keeps
// H; anything else is a conflict that keeps H and the old B, so it is found
// again on every run until H converges to R or `resolve` moves B to R.

export type Mapping = Record<string, unknown>;
export type Path = readonly string[];

export function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ConflictReason = "both-changed" | "unknown-base" | "deleted-locally" | "dropped-upstream";

export interface PathRules {
	readonly local: readonly string[];
	readonly seed: readonly string[];
	readonly machineLists: readonly string[];
	/** Entries dropped from a machine list on every apply, host-only or not. */
	readonly retired: Readonly<Record<string, readonly string[]>>;
}

/** Where the base of one structured file comes from. */
export type StructuredBaseSource =
	/** No host file, or a machine the updater never ran on: every repo path is new. */
	| { readonly kind: "empty" }
	/** The record the updater keeps; `unknown` paths have no trustworthy base. */
	| { readonly kind: "recorded"; readonly value: Mapping; readonly unknown: readonly Path[] }
	/** No record yet: a host value equal to any historical repo value at its path is unmodified. */
	| { readonly kind: "history"; readonly versions: readonly Mapping[] };

export interface KeyConflict {
	readonly path: Path;
	readonly reason: ConflictReason;
}

export interface StructuredMerge {
	/** The host file after the merge; undefined only when it had nothing and gets nothing. */
	readonly host: Mapping;
	/** The new base record: repo values where accepted, old base values at conflicts. */
	readonly base: Mapping;
	readonly unknown: Path[];
	readonly conflicts: KeyConflict[];
}

type BaseValue = { readonly kind: "known"; readonly value: unknown } | { readonly kind: "unknown" };

/** `field` names `path` or one of its ancestors. */
function covers(field: string, path: Path): boolean {
	const parts = field.split(".");
	return parts.length <= path.length && parts.every((part, i) => part === path[i]);
}

/** `field` lies strictly below `path`. */
function under(field: string, path: Path): boolean {
	const parts = field.split(".");
	return parts.length > path.length && path.every((part, i) => part === parts[i]);
}

/** One path is a prefix of the other (either way). */
export function related(a: Path, b: Path): boolean {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function valueAt(root: unknown, path: Path): unknown {
	let node: unknown = root;
	for (const key of path) {
		if (!isMapping(node) || !Object.hasOwn(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

/** Deep equality where `undefined` means absent and differs from `null`. */
export function same(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) return a === b;
	return Bun.deepEquals(a, b, true);
}

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

class StructuredMerger {
	readonly unknown: Path[] = [];
	readonly conflicts: KeyConflict[] = [];

	constructor(
		private readonly rules: PathRules,
		private readonly source: StructuredBaseSource,
	) {}

	private policy(path: Path): "local" | "seed" | "managed" {
		if (this.rules.local.some((field) => covers(field, path))) return "local";
		if (this.rules.seed.some((field) => covers(field, path))) return "seed";
		return "managed";
	}

	private ruleBelow(path: Path): boolean {
		return [...this.rules.local, ...this.rules.seed, ...this.rules.machineLists].some((field) => under(field, path));
	}

	/** Every base value the source holds at `path`: one for a record, one per version for history. */
	private baseNodes(path: Path): unknown[] {
		switch (this.source.kind) {
			case "empty":
				return [];
			case "recorded":
				return [valueAt(this.source.value, path)];
			case "history":
				return this.source.versions.map((version) => valueAt(version, path));
			default: {
				const unreachable: never = this.source;
				throw new Error(String(unreachable));
			}
		}
	}

	private baseLeaf(path: Path, host: unknown, project: (node: unknown) => unknown = (node) => node): BaseValue {
		switch (this.source.kind) {
			case "empty":
				return { kind: "known", value: undefined };
			case "recorded":
				if (this.source.unknown.some((unknownPath) => related(unknownPath, path))) return { kind: "unknown" };
				return { kind: "known", value: project(valueAt(this.source.value, path)) };
			case "history":
				// Only an exact historical match proves the host value is the repo's.
				return this.source.versions.some((version) => same(project(valueAt(version, path)), host))
					? { kind: "known", value: host }
					: { kind: "unknown" };
			default: {
				const unreachable: never = this.source;
				throw new Error(String(unreachable));
			}
		}
	}

	merge(path: Path, host: unknown, repo: unknown): { host: unknown; base: unknown } {
		switch (this.policy(path)) {
			case "local":
				return { host, base: undefined };
			case "seed":
				return { host: host === undefined ? clone(repo) : host, base: undefined };
			case "managed":
				break;
		}
		if (this.rules.machineLists.includes(path.join("."))) return this.machineList(path, host, repo);
		const bases = this.baseNodes(path);
		const present = [host, repo, ...bases].filter((value) => value !== undefined);
		const maps = present.filter(isMapping);
		if (maps.length > 0 && maps.length === present.length && (this.ruleBelow(path) || maps.some((map) => Object.keys(map).length > 0)))
			return this.mapping(path, host, repo, bases);
		return this.leaf(path, host, repo);
	}

	private mapping(path: Path, host: unknown, repo: unknown, bases: readonly unknown[]): { host: unknown; base: unknown } {
		const h = isMapping(host) ? host : undefined;
		const r = isMapping(repo) ? repo : undefined;
		const repoSide = new Set<string>(Object.keys(r ?? {}));
		for (const node of bases) if (isMapping(node)) for (const key of Object.keys(node)) repoSide.add(key);
		const outHost: Mapping = h ? { ...h } : {};
		const outBase: Mapping = {};
		for (const key of repoSide) {
			// Keys only the host has are the host's: they stay as they are.
			const merged = this.merge([...path, key], h?.[key], r?.[key]);
			if (merged.host === undefined) delete outHost[key];
			else outHost[key] = merged.host;
			if (merged.base !== undefined) outBase[key] = merged.base;
		}
		const empty = Object.keys(outHost).length === 0;
		const nextHost = empty && (h === undefined || r === undefined) ? undefined : outHost;
		const nextBase = Object.keys(outBase).length > 0 || r !== undefined ? outBase : undefined;
		return { host: nextHost, base: nextBase };
	}

	private leaf(path: Path, host: unknown, repo: unknown): { host: unknown; base: unknown } {
		if (same(host, repo)) return { host, base: clone(repo) };
		const base = this.baseLeaf(path, host);
		if (base.kind === "known") {
			if (same(host, base.value)) return { host: clone(repo), base: clone(repo) };
			if (same(repo, base.value)) return { host, base: clone(base.value) };
		}
		this.conflict(path, base, host, repo);
		return { host, base: base.kind === "known" ? clone(base.value) : undefined };
	}

	private conflict(path: Path, base: BaseValue, host: unknown, repo: unknown): void {
		const reason: ConflictReason =
			base.kind === "unknown"
				? "unknown-base"
				: repo === undefined
					? "dropped-upstream"
					: host === undefined
						? "deleted-locally"
						: "both-changed";
		this.conflicts.push({ path, reason });
		if (base.kind === "unknown") this.unknown.push(path);
	}

	/**
	 * A machine list holds host-only entries (kept, ahead) and the repo's
	 * subsequence: the entries the repo lists, or its recorded base listed.
	 * Only that subsequence is merged three-way, as one value. Without a record,
	 * entries the repo dropped in the past count as the host's: history only
	 * tells whether the host's subsequence is a version the repo once had.
	 */
	private machineList(path: Path, host: unknown, repo: unknown): { host: unknown; base: unknown } {
		const repoList = Array.isArray(repo) ? repo : [];
		const known: unknown[] = [...repoList];
		const recorded = this.source.kind === "recorded" ? valueAt(this.source.value, path) : undefined;
		if (Array.isArray(recorded)) known.push(...recorded);
		const isRepoEntry = (entry: unknown): boolean => known.some((own) => same(own, entry));
		const hostList = Array.isArray(host) ? host : undefined;
		const hostOnly = (hostList ?? []).filter((entry) => !isRepoEntry(entry));
		const hostRepo = hostList?.filter(isRepoEntry);
		const subsequence = (node: unknown): unknown => (Array.isArray(node) ? node.filter(isRepoEntry) : node);
		let next: { host: unknown; base: unknown };
		if (same(hostRepo, repo)) next = { host: hostRepo, base: clone(repo) };
		else {
			const base = this.baseLeaf(path, hostRepo, subsequence);
			if (base.kind === "known" && same(hostRepo, base.value)) next = { host: clone(repo), base: clone(repo) };
			else if (base.kind === "known" && same(repo, base.value)) next = { host: hostRepo, base: clone(base.value) };
			else {
				this.conflict(path, base, hostRepo, repo);
				next = { host: hostRepo, base: base.kind === "known" ? clone(base.value) : undefined };
			}
		}
		const retired = this.rules.retired[path.join(".")] ?? [];
		const entries = [...hostOnly, ...(Array.isArray(next.host) ? next.host : [])].filter(
			(entry) => !retired.some((old) => same(old, entry)),
		);
		return { host: hostList === undefined && next.host === undefined ? undefined : entries, base: next.base };
	}
}

/** Merge one structured file. `host` undefined means the host has no such file. */
export function mergeStructured(host: Mapping | undefined, repo: Mapping, source: StructuredBaseSource, rules: PathRules): StructuredMerge {
	const merger = new StructuredMerger(rules, source);
	const merged = merger.merge([], host ?? {}, repo);
	return {
		host: isMapping(merged.host) ? merged.host : {},
		base: isMapping(merged.base) ? merged.base : {},
		unknown: merger.unknown,
		conflicts: merger.conflicts,
	};
}

/** Set (or, for undefined, remove) the value at `path`, creating maps on the way. */
export function setAt(root: Mapping, path: Path, value: unknown): void {
	if (path.length === 0) throw new Error("cannot set the root");
	let node: Mapping = root;
	for (const key of path.slice(0, -1)) {
		const next = node[key];
		if (isMapping(next)) node = next;
		else {
			if (value === undefined) return;
			const created: Mapping = {};
			node[key] = created;
			node = created;
		}
	}
	const last = path[path.length - 1] as string;
	if (value === undefined) delete node[last];
	else node[last] = structuredClone(value);
}

/** JSON Pointer (RFC 6901) for a path, used in conflict ids. */
export function pointer(path: Path): string {
	return path.map((key) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** Stable JSON: sorted keys, so equal values digest equally. */
export function canonical(value: unknown): string {
	if (value === undefined) return "\u0000absent";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isMapping(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
