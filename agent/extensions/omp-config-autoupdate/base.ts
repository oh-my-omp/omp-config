import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { atomicWrite } from "./files.ts";
import { type Format, isMapping, type Mapping, type Path, parseStructured, related, valueAt } from "./merge.ts";

export const BASE_DIR = ".omp-config-base";
const STATE_FILE = "state.json";
const FILES_DIR = "files";
const STATE_VERSION = 1;

export type PlainBase = { readonly kind: "none" } | { readonly kind: "unknown" } | { readonly kind: "known"; readonly content: Buffer };

export interface StructuredRecord {
	readonly value: Mapping;
	readonly unknown: readonly Path[];
}

export type BaseChange =
	| { readonly kind: "plain-known"; readonly rel: string; readonly content: Uint8Array }
	| { readonly kind: "plain-unknown"; readonly rel: string }
	| { readonly kind: "plain-drop"; readonly rel: string }
	| { readonly kind: "structured"; readonly rel: string; readonly record: StructuredRecord }
	| { readonly kind: "structured-drop"; readonly rel: string };

const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every((part) => typeof part === "string");

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
		readonly exists: boolean,
	) {}

	static load(agentDir: string): BaseRecord {
		const dir = join(agentDir, BASE_DIR);
		const statePath = join(dir, STATE_FILE);
		if (!existsSync(statePath)) return new BaseRecord(dir, new Set(), new Map(), false);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(statePath, "utf8"));
		} catch (error) {
			throw new Error(`${statePath}: unreadable base record (${errorText(error)}); nothing applied`);
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
			return { kind: "none" };
		}
		return { kind: "known", content: readFileSync(path) };
	}

	plainPath(rel: string): string {
		return join(this.dir, FILES_DIR, rel);
	}

	structuredOf(rel: string): StructuredRecord | undefined {
		return this.structured.get(rel);
	}

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

	commit(changes: readonly BaseChange[]): void {
		if (changes.length === 0) return;
		for (const change of changes) {
			switch (change.kind) {
				case "plain-known":
					atomicWrite(join(this.dir, FILES_DIR, change.rel), change.content);
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
				case "structured-drop":
					this.structured.delete(change.rel);
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
		atomicWrite(join(this.dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
	}
}

export function git(cwd: string, args: readonly string[]): { ok: true; out: string } | { ok: false; err: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.error) return { ok: false, err: result.error.message };
	if (result.status !== 0) return { ok: false, err: (result.stderr || result.stdout).trim() || `git ${args[0]} exited ${result.status}` };
	return { ok: true, out: result.stdout };
}

function blobId(content: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(`blob ${content.byteLength}\0`);
	hasher.update(content);
	return hasher.digest("hex");
}

export class RepoHistory {
	private deepened = false;
	private readonly blobCache = new Map<string, Set<string>>();
	readonly notes: string[] = [];

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

	private blobs(rel: string): Set<string> {
		const cached = this.blobCache.get(rel);
		if (cached !== undefined) return cached;
		this.deepen();
		const out = this.git(["log", "--format=", "--raw", "--no-abbrev", "--no-renames", "HEAD", "--", rel]);
		const ids = new Set<string>();
		for (const line of (out ?? "").split("\n")) {
			const fields = line.split("\t", 1)[0]?.split(" ") ?? [];
			for (const id of [fields[2], fields[3]]) if (id && !/^0+$/.test(id)) ids.add(id);
		}
		this.blobCache.set(rel, ids);
		return ids;
	}

	hasVersion(rel: string, content: Uint8Array): boolean {
		return this.blobs(rel).has(blobId(content));
	}

	eachVersion(rel: string, onVersion: (text: string) => void): void {
		const ids = [...this.blobs(rel)];
		if (ids.length === 0) return;
		const result = spawnSync("git", ["-C", this.source, "cat-file", "--batch"], {
			input: `${ids.join("\n")}\n`,
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.status !== 0 || result.error) return;
		const bytes = result.stdout;
		let offset = 0;
		while (offset < bytes.length) {
			const newline = bytes.indexOf(10, offset);
			if (newline === -1) break;
			const header = bytes.subarray(offset, newline).toString("utf8").split(" ");
			const size = Number(header[2]);
			if (header[1] !== "blob" || !Number.isFinite(size)) break;
			const text = bytes.subarray(newline + 1, newline + 1 + size).toString("utf8");
			offset = newline + 1 + size + 1;
			onVersion(text);
		}
	}

	show(commit: string, rel: string): Buffer | undefined {
		const result = spawnSync("git", ["-C", this.source, "show", `${commit}:${rel}`]);
		return result.status === 0 && !result.error ? result.stdout : undefined;
	}

	structuredVersions(rel: string, format: Format): Mapping[] {
		const versions: Mapping[] = [];
		this.eachVersion(rel, (text) => {
			try {
				versions.push(parseStructured(text, format));
			} catch {}
		});
		return versions;
	}
}

export function unmodifiedSection(
	base: BaseRecord,
	history: RepoHistory,
	rel: string,
	format: Format,
	path: Path,
	value: unknown,
): boolean {
	const recorded = base.structuredOf(rel);
	if (recorded !== undefined)
		return !recorded.unknown.some((unknown) => related(unknown, path)) && Bun.deepEquals(value, valueAt(recorded.value, path), true);
	return history.structuredVersions(rel, format).some((version) => Bun.deepEquals(value, valueAt(version, path), true));
}
