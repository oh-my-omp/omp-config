// Session history as relations, shared by the session:// metadata views and the
// session_query tool: session metadata rows (with the find filter), the
// transcript tree of one session, and the event records of one transcript.
// Every row comes from the typed listings and loaders the timeline uses; no
// rendered text is parsed back.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type LoadedSession, loadSession } from "./events.ts";
import type { EventFilter } from "./filter.ts";
import { getSessionsDir, latestRecaps, listSessions, promptMatches, type SessionInfo, sessionDirForCwd } from "./omp-adapter.ts";
import { eventRecords } from "./render.ts";
import { childAgents, childDir, type SessionRef } from "./routes.ts";

/** Listing size that means "every session". */
export const ALL_SESSIONS = 1_000_000;

/** One session's metadata, as `sessions.jsonl` lists it. */
export interface SessionRow {
	readonly sid: string;
	readonly url: string;
	readonly timeline: string;
	readonly project: string;
	readonly cwd: string;
	readonly title: string;
	readonly created: string | null;
	readonly modified: string;
	readonly status: string | null;
	readonly assistantTurns: number | null;
	readonly size: number;
	readonly recap: string | null;
	/** The header's `parentSession` as written: a file path for forks and task children, a session id for continuations. */
	readonly parent: string | null;
}

export function metadata(infos: readonly SessionInfo[]): SessionRow[] {
	const recaps = latestRecaps(infos.map((info) => info.id));
	return infos.map((info) => ({
		sid: info.id,
		url: `session://${info.id}`,
		timeline: `session://${info.id}/timeline`,
		project: path.basename(path.dirname(info.path)),
		cwd: info.cwd,
		title: info.title ?? (info.firstMessage.split("\n", 1)[0] ?? "").slice(0, 200),
		created: Number.isNaN(info.created.getTime()) ? null : info.created.toISOString(),
		modified: info.modified.toISOString(),
		status: info.status ?? null,
		assistantTurns: info.assistantTurns ?? null,
		size: info.size,
		recap: recaps.get(info.id) ?? null,
		parent: info.parentSessionPath ?? null,
	}));
}

/** Sessions directory a `project` selector names: `.` the caller's project, a bucket name, or a path; null for every project. */
export function projectDir(project: string | null, cwd: string | undefined): string | undefined {
	if (project === null) return undefined;
	if (project === ".") {
		if (!cwd) throw new Error("project=. needs the calling session's working directory");
		return sessionDirForCwd(cwd);
	}
	return project.includes("/") ? sessionDirForCwd(path.resolve(cwd ?? "/", project)) : path.join(getSessionsDir(), project);
}

/** Rows whose typed prompts (prompt-history FTS), title or recap match every word of `needle`. */
export function matchText(rows: readonly SessionRow[], needle: string): SessionRow[] {
	const fromPrompts = new Set(promptMatches(needle, 500));
	const words = needle.toLowerCase().split(/\s+/);
	return rows.filter((row) => {
		if (fromPrompts.has(row.sid)) return true;
		const haystack = `${row.title}\n${row.recap ?? ""}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

export interface SessionQuery {
	readonly project: string | null;
	readonly text: string | null;
	/** Inclusive lower and exclusive upper bound on `modified`, epoch milliseconds. */
	readonly since: number | null;
	readonly until: number | null;
	readonly limit: number;
}

/** Session rows, newest first: every filter applies before `limit` cuts the result. */
export async function sessionRows(query: SessionQuery, cwd: string | undefined): Promise<SessionRow[]> {
	const rows = metadata(await listSessions(projectDir(query.project, cwd), ALL_SESSIONS)).filter((row) => {
		const modified = Date.parse(row.modified);
		return (query.since === null || modified >= query.since) && (query.until === null || modified < query.until);
	});
	return (query.text === null ? rows : matchText(rows, query.text)).slice(0, query.limit);
}

/** One transcript of a session: the root (`agent` "") or a subagent. */
export interface TranscriptRow {
	readonly sid: string;
	readonly agent: string;
	/** Allocated id of the transcript this subagent ran under ("" for the root); null for the root itself. */
	readonly parent: string | null;
	readonly file: string;
	readonly bytes: number;
	readonly modified: string;
}

/** The transcript row of `file`, with its size and modification time now. */
export async function transcriptRow(sid: string, agent: string, parent: string | null, file: string): Promise<TranscriptRow> {
	const stat = await fs.stat(file);
	return { sid, agent, parent, file, bytes: stat.size, modified: stat.mtime.toISOString() };
}

/** The root transcript and every subagent below it, parents before children; the subagents session://<id>/agents/ lists. */
export async function transcriptTree(ref: SessionRef): Promise<TranscriptRow[]> {
	const rows: TranscriptRow[] = [await transcriptRow(ref.sid, "", null, ref.file)];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!row) break;
		for (const agent of await childAgents(row.file))
			rows.push(await transcriptRow(ref.sid, agent, row.agent, path.join(childDir(row.file), `${agent}.jsonl`)));
	}
	return rows;
}

/** Canonical session:// URL of a transcript. */
export function transcriptUrl(sid: string, agent: string): string {
	return agent === "" ? `session://${sid}` : `session://${sid}/agents/${agent}`;
}

export type EventRecord = Record<string, unknown>;

/** A transcript's active-branch events that `filter` shows, as the records events.jsonl serves. */
export async function transcriptEvents(
	transcript: TranscriptRow,
	filter: EventFilter,
	signal: AbortSignal | undefined,
): Promise<{ readonly loaded: LoadedSession; readonly records: EventRecord[] }> {
	const loaded = await loadSession(transcript.file, transcript.sid, transcript.agent, signal);
	return { loaded, records: eventRecords(loaded, transcriptUrl(transcript.sid, transcript.agent), filter) };
}
