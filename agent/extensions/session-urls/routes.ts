// session:// URL grammar → Route, and resolution of routes to session files.
// One traversable tree (projects/<bucket>/<date>/<sid>/…) so grep never visits
// a session twice; `session://<id-prefix>/…`, `here/…`, the metadata files and
// detail leaves resolve directly but are not listed.
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EntrySelector } from "./events.ts";
import { findSessionFiles, getSessionsDir, sessionDirForCwd } from "./omp-adapter.ts";

export type BucketRef = { readonly kind: "named"; readonly name: string } | { readonly kind: "here" };
export type Locator =
	| { readonly kind: "prefix"; readonly prefix: string }
	| { readonly kind: "listed"; readonly bucket: BucketRef; readonly date: string; readonly sid: string };
export interface SessionPath {
	readonly locator: Locator;
	/** Full subagent id, or "" for the root session. */
	readonly agent: string;
}

export type Route =
	| { readonly kind: "root" }
	| { readonly kind: "readme" }
	| { readonly kind: "projects" }
	| { readonly kind: "bucket"; readonly bucket: BucketRef }
	| { readonly kind: "bucketSessions"; readonly bucket: BucketRef }
	| { readonly kind: "date"; readonly bucket: BucketRef; readonly date: string }
	| { readonly kind: "allSessions" }
	| { readonly kind: "find" }
	| { readonly kind: "sessionDir"; readonly at: SessionPath }
	| { readonly kind: "agentsDir"; readonly at: SessionPath }
	| { readonly kind: "timeline"; readonly at: SessionPath }
	| { readonly kind: "events"; readonly at: SessionPath }
	| { readonly kind: "raw"; readonly at: SessionPath }
	| { readonly kind: "entry"; readonly at: SessionPath; readonly selector: EntrySelector }
	| { readonly kind: "artifact"; readonly at: SessionPath; readonly id: string }
	| { readonly kind: "local"; readonly at: SessionPath; readonly relative: string };

const ID_PREFIX = /^[\w-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_ID = /^[A-Za-z0-9_.-]+$/;
const FILE_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;

function invalid(url: string, why: string): Error {
	return new Error(`Invalid session:// URL ${url}: ${why}. Read session://README for the grammar.`);
}

function segment(name: string, url: string): string {
	if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
		throw invalid(url, `bad path segment "${name}"`);
	return name;
}

function sessionRoute(locator: Locator, rest: readonly string[], agent: string, url: string): Route {
	const at: SessionPath = { locator, agent };
	const [head, ...tail] = rest;
	if (head === undefined) return { kind: "sessionDir", at };
	switch (head) {
		case "timeline":
		case "events.jsonl":
		case "raw.jsonl":
			if (tail.length > 0) break;
			return { kind: head === "timeline" ? "timeline" : head === "events.jsonl" ? "events" : "raw", at };
		case "entry": {
			const [id] = tail;
			if (id === undefined || tail.length !== 1) break;
			if (id.startsWith("@")) {
				const line = Number(id.slice(1));
				if (!Number.isInteger(line) || line < 1) throw invalid(url, `bad line "${id}"`);
				return { kind: "entry", at, selector: { kind: "line", line } };
			}
			return { kind: "entry", at, selector: { kind: "id", id } };
		}
		case "artifacts": {
			const [id] = tail;
			if (id === undefined || tail.length !== 1 || !/^\d+$/.test(id)) break;
			return { kind: "artifact", at, id };
		}
		case "local":
			if (tail.length === 0) break;
			return { kind: "local", at, relative: tail.map((part) => segment(part, url)).join("/") };
		case "agents": {
			const [id, ...more] = tail;
			if (id === undefined) return { kind: "agentsDir", at };
			if (!AGENT_ID.test(id)) throw invalid(url, `bad agent id "${id}"`);
			return sessionRoute(locator, more, id, url);
		}
	}
	throw invalid(url, `unknown path /${rest.join("/")}`);
}

function bucketRoute(bucket: BucketRef, rest: readonly string[], url: string): Route {
	const [date, sid, ...more] = rest;
	if (date === undefined) return { kind: "bucket", bucket };
	if (date === "sessions.jsonl" && sid === undefined) return { kind: "bucketSessions", bucket };
	if (!DATE.test(date)) throw invalid(url, `expected a YYYY-MM-DD date, got "${date}"`);
	if (sid === undefined) return { kind: "date", bucket, date };
	if (!ID_PREFIX.test(sid)) throw invalid(url, `bad session id "${sid}"`);
	return sessionRoute({ kind: "listed", bucket, date, sid }, more, "", url);
}

function route(host: string, rest: readonly string[], url: string): Route {
	switch (host) {
		case "":
			if (rest.length > 0) throw invalid(url, "the root has no path");
			return { kind: "root" };
		case "README":
			return { kind: "readme" };
		case "sessions.jsonl":
			return { kind: "allSessions" };
		case "find":
			return { kind: "find" };
		case "here":
			return bucketRoute({ kind: "here" }, rest, url);
		case "projects": {
			const [bucket, ...more] = rest;
			if (bucket === undefined) return { kind: "projects" };
			return bucketRoute({ kind: "named", name: segment(bucket, url) }, more, url);
		}
		default:
			if (!ID_PREFIX.test(host)) throw invalid(url, `"${host}" is not a session id prefix`);
			return sessionRoute({ kind: "prefix", prefix: host }, rest, "", url);
	}
}

/** A parsed URL: its route plus the `type` filter written as a `type/<filter>/` path prefix (empty when absent). */
export interface Target {
	readonly route: Route;
	readonly pathTypes: readonly string[];
}

/**
 * Parses a session:// URL's host and path (query handled by the caller).
 * `session://type/<filter>/<any other session:// path>` carries a type filter in
 * the path, where a glob can reach it (`?type=` after a glob segment is glob text).
 */
export function parseTarget(host: string, pathname: string, url: string): Target {
	const rest = pathname
		.split("/")
		.filter((part) => part !== "")
		.map((part) => decodeURIComponent(part));
	if (host !== "type") return { route: route(host, rest, url), pathTypes: [] };
	const [filter, innerHost, ...inner] = rest;
	if (filter === undefined || innerHost === undefined)
		throw invalid(url, "use session://type/<filter>/<path>, e.g. session://type/thinking/here/");
	return { route: route(innerHost, inner, url), pathTypes: [filter] };
}

/** A located root session file. */
export interface SessionRef {
	readonly sid: string;
	readonly file: string;
	readonly bucket: string;
}

/** Parses an OMP session file name `<ISO-with-dashes>_<id>.jsonl`. */
export function fileStamp(name: string): { readonly sid: string; readonly created: Date } | null {
	const match = FILE_STAMP.exec(name);
	if (!match) return null;
	const created = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isNaN(created.getTime()) ? null : { sid: match[6] ?? "", created };
}

/** Local calendar date `YYYY-MM-DD` of `at`. */
export function localDate(at: Date): string {
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function bucketName(bucket: BucketRef, cwd: string | undefined): string {
	switch (bucket.kind) {
		case "named":
			return bucket.name;
		case "here":
			if (!cwd) throw new Error("session://here needs the calling session's working directory");
			return path.basename(sessionDirForCwd(cwd));
		default: {
			const unreachable: never = bucket;
			throw new Error(`Unhandled bucket ${String(unreachable)}`);
		}
	}
}

export function bucketDir(bucket: BucketRef, cwd: string | undefined): string {
	return path.join(getSessionsDir(), bucketName(bucket, cwd));
}

/** Session files directly in a bucket, with their ids and creation dates. */
export async function bucketSessions(dir: string): Promise<Array<{ readonly sid: string; readonly created: Date; readonly file: string }>> {
	const names = await fs.readdir(dir);
	return names.flatMap((name) => {
		const stamp = fileStamp(name);
		return stamp ? [{ ...stamp, file: path.join(dir, name) }] : [];
	});
}

/** The root session a locator names; throws on no match or an ambiguous prefix. */
export async function locateSession(locator: Locator, cwd: string | undefined): Promise<SessionRef> {
	switch (locator.kind) {
		case "listed": {
			const dir = bucketDir(locator.bucket, cwd);
			const match = (await bucketSessions(dir)).find(
				(session) => session.sid === locator.sid && localDate(session.created) === locator.date,
			);
			if (!match) throw new Error(`No session ${locator.sid} dated ${locator.date} in ${path.basename(dir)}`);
			return { sid: match.sid, file: match.file, bucket: path.basename(dir) };
		}
		case "prefix": {
			const files = await findSessionFiles(locator.prefix);
			if (files.length === 0)
				throw new Error(
					`No session id starts with "${locator.prefix}". Find sessions with session://find?text=<words> or session://sessions.jsonl.`,
				);
			const refs = files.flatMap((file) => {
				const stamp = fileStamp(path.basename(file));
				return stamp ? [{ sid: stamp.sid, file, bucket: path.basename(path.dirname(file)) }] : [];
			});
			const [only, ...others] = refs;
			if (only && others.length === 0) return only;
			const shown = refs.slice(0, 8).map((ref) => `${ref.sid} (${ref.bucket})`);
			throw new Error(`"${locator.prefix}" matches ${refs.length} sessions: ${shown.join(", ")}; use a longer prefix.`);
		}
		default: {
			const unreachable: never = locator;
			throw new Error(`Unhandled locator ${String(unreachable)}`);
		}
	}
}

/** Directory holding a transcript's own children and artifacts: the file path without `.jsonl`. */
export function childDir(file: string): string {
	return file.slice(0, -".jsonl".length);
}

/** Subagent transcript for full id `A.B.C`: `<artifacts>/A/A.B/A.B.C.jsonl`, else a bounded search below the root. */
export async function agentFile(root: SessionRef, agent: string): Promise<string> {
	const parts = agent.split(".");
	let dir = childDir(root.file);
	for (let index = 1; index < parts.length; index++) dir = path.join(dir, parts.slice(0, index).join("."));
	const direct = path.join(dir, `${agent}.jsonl`);
	if (await Bun.file(direct).exists()) return direct;
	const found = await searchFile(childDir(root.file), `${agent}.jsonl`, 0);
	if (found) return found;
	throw new Error(`No subagent ${agent} in session ${root.sid}. List them with session://${root.sid}/agents/`);
}

async function searchFile(dir: string, name: string, depth: number): Promise<string | null> {
	if (depth > 8) return null;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		// A missing artifacts directory simply holds no subagents.
		return null;
	}
	if (entries.some((entry) => entry.isFile() && entry.name === name)) return path.join(dir, name);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = await searchFile(path.join(dir, entry.name), name, depth + 1);
		if (found) return found;
	}
	return null;
}

/** Subagent ids directly under a transcript (its `<file minus .jsonl>/` directory). */
export async function childAgents(transcript: string): Promise<string[]> {
	try {
		const names = await fs.readdir(childDir(transcript));
		return names.filter((name) => name.endsWith(".jsonl") && !name.startsWith("__advisor")).map((name) => name.slice(0, -".jsonl".length));
	} catch {
		// No artifacts directory: no subagents.
		return [];
	}
}
