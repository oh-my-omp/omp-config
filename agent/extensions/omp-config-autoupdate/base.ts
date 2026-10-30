// Base record and repo history for omp-config-update.ts.
//
// BASE. `<agent dir>/.omp-config-base/` is the updater's own record of the
// repo content each managed item last had when this machine accepted it:
//   - files/<rel>     the accepted bytes of a plain file;
//   - state.json      { version, unknownPlain: [rel], structured: { rel: {
//                     value, unknown: [path] } } } — plain files whose base
//                     could not be established, and per structured file the
//                     accepted repo projection (machine-owned and seed paths
//                     excluded) plus the paths with no trustworthy base.
// A plain file with neither entry has no base yet. Only the updater writes
// here: apply after the host write succeeded, `resolve` on request. Nothing
// here is copied into the repo.
//
// HISTORY. An item with no base is matched against the repo's history: a host
// file (or structured value) equal to any committed version is unmodified, so
// its base is that version. The updater clone is shallow; outside --check it
// is deepened once on the first lookup. Without history the base is unknown.
// A machine the updater never ran on skips history for structured files: the
// updater merges them against an empty base (omp-config-update.ts, freshMachine).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMapping, type Mapping, type Path } from "./merge.ts";

export const BASE_DIR = ".omp-config-base";
const STATE_FILE = "state.json";
const FILES_DIR = "files";
const STATE_VERSION = 1;

export type PlainBase = { readonly kind: "none" } | { readonly kind: "unknown" } | { readonly kind: "known"; readonly content: Buffer };

export interface StructuredRecord {
	readonly value: Mapping;
	readonly unknown: readonly Path[];
}

/** One change to the record, applied after the host write it belongs to. */
export type BaseChange =
	| { readonly kind: "plain-known"; readonly rel: string; readonly content: Uint8Array }
	| { readonly kind: "plain-unknown"; readonly rel: string }
	| { readonly kind: "plain-drop"; readonly rel: string }
	| { readonly kind: "structured"; readonly rel: string; readonly record: StructuredRecord };

const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every((part) => typeof part === "string");

/** A rel the record may name: relative, `/`-separated, no `.`/`..` parts. */
function cleanRel(rel: string): boolean {
	return (
		rel.length > 0 &&
		!rel.startsWith("/") &&
		!rel.includes("\\") &&
		rel.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export class BaseRecord {
	private constructor(
		private readonly dir: string,
		private readonly unknownPlain: Set<string>,
		private readonly structured: Map<string, StructuredRecord>,
		/** True when the record exists on disk. */
		readonly exists: boolean,
	) {}

	/** Read the record; a missing one is empty, an unreadable one is an error. */
	static load(agentDir: string): BaseRecord {
		const dir = join(agentDir, BASE_DIR);
		const statePath = join(dir, STATE_FILE);
		if (!existsSync(statePath)) return new BaseRecord(dir, new Set(), new Map(), false);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(statePath, "utf8"));
		} catch (error) {
			throw new Error(`${statePath}: unreadable base record (${error instanceof Error ? error.message : String(error)}); nothing applied`);
		}
		if (!isMapping(parsed) || parsed.version !== STATE_VERSION) throw new Error(`${statePath}: unsupported base record; nothing applied`);
		const unknownPlain = new Set<string>();
		if (Array.isArray(parsed.unknownPlain))
			for (const rel of parsed.unknownPlain) if (typeof rel === "string" && cleanRel(rel)) unknownPlain.add(rel);
		const structured = new Map<string, StructuredRecord>();
		if (isMapping(parsed.structured)) {
			for (const [rel, entry] of Object.entries(parsed.structured)) {
				if (!cleanRel(rel) || !isMapping(entry) || !isMapping(entry.value) || !Array.isArray(entry.unknown) || !entry.unknown.every(isPath))
					throw new Error(`${statePath}: invalid record for ${rel}; nothing applied`);
				structured.set(rel, { value: entry.value, unknown: entry.unknown });
			}
		}
		return new BaseRecord(dir, unknownPlain, structured, true);
	}

	plain(rel: string): PlainBase {
		if (this.unknownPlain.has(rel)) return { kind: "unknown" };
		const path = join(this.dir, FILES_DIR, rel);
		try {
			if (!lstatSync(path).isFile()) return { kind: "none" };
		} catch {
			// No recorded copy: no base.
			return { kind: "none" };
		}
		return { kind: "known", content: readFileSync(path) };
	}

	/** Path of the recorded copy of a plain file, for people and agents to read. */
	plainPath(rel: string): string {
		return join(this.dir, FILES_DIR, rel);
	}

	structuredOf(rel: string): StructuredRecord | undefined {
		return this.structured.get(rel);
	}

	/** Every plain rel the record has a base for (known or unknown). */
	plainRels(): string[] {
		const rels = new Set(this.unknownPlain);
		const root = join(this.dir, FILES_DIR);
		if (existsSync(root)) {
			for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const rel = join(entry.parentPath, entry.name)
					.slice(root.length + 1)
					.split("\\")
					.join("/");
				if (cleanRel(rel)) rels.add(rel);
			}
		}
		return [...rels].sort();
	}

	/** Apply changes and persist: copies first, then state.json, each by temp file + rename. */
	commit(changes: readonly BaseChange[]): void {
		if (changes.length === 0) return;
		for (const change of changes) {
			switch (change.kind) {
				case "plain-known":
					writeAtomic(join(this.dir, FILES_DIR, change.rel), change.content);
					this.unknownPlain.delete(change.rel);
					break;
				case "plain-unknown":
					rmSync(join(this.dir, FILES_DIR, change.rel), { force: true });
					this.unknownPlain.add(change.rel);
					break;
				case "plain-drop":
					rmSync(join(this.dir, FILES_DIR, change.rel), { force: true });
					this.unknownPlain.delete(change.rel);
					break;
				case "structured":
					this.structured.set(change.rel, change.record);
					break;
				default: {
					const unreachable: never = change;
					throw new Error(String(unreachable));
				}
			}
		}
		const state = {
			version: STATE_VERSION,
			unknownPlain: [...this.unknownPlain].sort(),
			structured: Object.fromEntries([...this.structured].sort(([a], [b]) => a.localeCompare(b))),
		};
		writeAtomic(join(this.dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
	}
}

/** Temp file + rename in the record's own tree; the record never follows links out. */
function writeAtomic(path: string, content: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Git's blob id of `content`, to compare a host file with committed versions without reading them. */
function blobId(content: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(`blob ${content.byteLength}\0`);
	hasher.update(content);
	return hasher.digest("hex");
}

export class RepoHistory {
	private deepened = false;
	readonly notes: string[] = [];

	/** `fetch`: whether the source may be deepened from its origin (never in --check). */
	constructor(
		private readonly source: string,
		private readonly fetch: boolean,
	) {}

	private git(args: readonly string[]): string | undefined {
		const result = spawnSync("git", ["-C", this.source, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		return result.status === 0 && !result.error ? result.stdout : undefined;
	}

	private deepen(): void {
		if (this.deepened) return;
		this.deepened = true;
		if (this.git(["rev-parse", "--is-shallow-repository"])?.trim() !== "true") return;
		if (!this.fetch) {
			this.notes.push("history: shallow source, only local commits consulted (check never fetches)");
			return;
		}
		if (this.git(["fetch", "--quiet", "--unshallow", "origin"]) === undefined)
			this.notes.push("history: could not deepen the shallow source; unmatched files get an unknown base");
	}

	/** Blob ids `rel` has had in the source's history. */
	private blobs(rel: string): Set<string> {
		this.deepen();
		const out = this.git(["log", "--format=", "--raw", "--no-abbrev", "--no-renames", "HEAD", "--", rel]);
		const ids = new Set<string>();
		for (const line of (out ?? "").split("\n")) {
			const fields = line.split("\t", 1)[0]?.split(" ") ?? [];
			for (const id of [fields[2], fields[3]]) if (id && !/^0+$/.test(id)) ids.add(id);
		}
		return ids;
	}

	/** The host file equals some committed version of `rel`. */
	hasVersion(rel: string, content: Uint8Array): boolean {
		return this.blobs(rel).has(blobId(content));
	}

	/** Every committed version of `rel`, as raw text. */
	versions(rel: string): string[] {
		const ids = [...this.blobs(rel)];
		if (ids.length === 0) return [];
		const result = spawnSync("git", ["-C", this.source, "cat-file", "--batch"], {
			input: `${ids.join("\n")}\n`,
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.status !== 0 || result.error) return [];
		const texts: string[] = [];
		const bytes = result.stdout;
		let offset = 0;
		while (offset < bytes.length) {
			const newline = bytes.indexOf(10, offset);
			if (newline === -1) break;
			const header = bytes.subarray(offset, newline).toString("utf8").split(" ");
			const size = Number(header[2]);
			if (header[1] !== "blob" || !Number.isFinite(size)) break;
			texts.push(bytes.subarray(newline + 1, newline + 1 + size).toString("utf8"));
			offset = newline + 1 + size + 1;
		}
		return texts;
	}

	/** The content of `rel` at `commit`, when the source has it. */
	show(commit: string, rel: string): Buffer | undefined {
		const result = spawnSync("git", ["-C", this.source, "show", `${commit}:${rel}`]);
		return result.status === 0 && !result.error ? result.stdout : undefined;
	}
}
