// The session_query SQLite workspace: one database file per name at
// local://sessions/<name>.sqlite under the calling session's local:// root, so
// later eval cells, subagents sharing that root and `read local://…` see it.
// `load` owns the imported tables `sessions`, `transcripts` and `events` and
// replaces one session's rows in a single transaction; `save` writes the
// caller's own tables; `sql` runs the caller's SQL. Every call opens the file,
// works and closes it: the file is the only state.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoadedSession } from "./events.ts";
import { type LocalProtocolOptions, readSessionInfo, resolveLocalUrlToPath } from "./omp-adapter.ts";
import { type EventRecord, metadata, type TranscriptRow, transcriptEvents, transcriptTree, transcriptUrl } from "./relations.ts";
import type { SessionRef } from "./routes.ts";

const SCHEMA_VERSION = 1;
/** Tables `load` owns; `save` refuses them. */
export const IMPORTED_TABLES: readonly string[] = ["sessions", "transcripts", "events"];

const SCHEMA = `
CREATE TABLE sessions (
	sid TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, created TEXT,
	modified TEXT NOT NULL, status TEXT, assistant_turns INTEGER, size INTEGER NOT NULL, recap TEXT,
	parent TEXT, url TEXT NOT NULL
);
CREATE TABLE transcripts (
	sid TEXT NOT NULL, agent TEXT NOT NULL, parent TEXT, file TEXT NOT NULL, bytes INTEGER NOT NULL,
	modified TEXT NOT NULL, title TEXT, created TEXT NOT NULL, parent_session TEXT, entries INTEGER NOT NULL,
	on_branch INTEGER NOT NULL, events INTEGER NOT NULL, loaded_at TEXT NOT NULL, url TEXT NOT NULL,
	PRIMARY KEY (sid, agent)
);
CREATE TABLE events (
	sid TEXT NOT NULL, agent TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL, t TEXT NOT NULL,
	kind TEXT NOT NULL, entry TEXT NOT NULL, block INTEGER, line INTEGER NOT NULL, call_id TEXT, tool TEXT,
	status TEXT, result_entry TEXT, text TEXT, data TEXT NOT NULL, url TEXT NOT NULL,
	PRIMARY KEY (sid, agent, seq)
);
CREATE INDEX events_call ON events (call_id);
CREATE INDEX events_entry ON events (sid, agent, entry);
CREATE INDEX events_kind ON events (kind, tool);
`;

/** A JSON-safe cell value: what both the JS and the Python eval bridge carry unchanged. */
export type Cell = string | number | null;

export interface Workspace {
	readonly url: string;
	readonly file: string;
}

/** The workspace named `name` in the calling session's local:// root. */
export function workspace(name: string, options: LocalProtocolOptions): Workspace {
	const url = `local://sessions/${name}.sqlite`;
	return { url, file: resolveLocalUrlToPath(url, options) };
}

async function open(at: Workspace): Promise<Database> {
	await fs.mkdir(path.dirname(at.file), { recursive: true });
	const db = new Database(at.file, { create: true, safeIntegers: true });
	db.run("PRAGMA busy_timeout = 5000");
	return db;
}

async function withDb<T>(at: Workspace, work: (db: Database) => T): Promise<T> {
	const db = await open(at);
	try {
		return work(db);
	} finally {
		db.close();
	}
}

function ensureSchema(db: Database): void {
	const row = db.query<{ user_version: bigint }, []>("PRAGMA user_version").get();
	const version = Number(row?.user_version ?? 0);
	if (version === SCHEMA_VERSION) return;
	if (version !== 0) throw new Error(`workspace schema version ${version} is not ${SCHEMA_VERSION}; load into a new db name`);
	db.transaction(() => {
		db.run(SCHEMA);
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}

/** A cell as SQLite returned it, in the JSON-safe domain: unsafe integers become decimal strings, blobs base64. */
function cell(value: unknown): Cell {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	if (typeof value === "number" || typeof value === "string") return value;
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	return String(value);
}

function str(record: EventRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function int(record: EventRecord, key: string): number | null {
	const value = record[key];
	return typeof value === "number" ? value : null;
}

export interface LoadedCount {
	readonly sid: string;
	readonly transcripts: number;
	readonly events: number;
}

/** Loads one session (its subagents too when `withAgents`) and replaces its rows in the imported tables. */
async function loadOne(db: Database, ref: SessionRef, withAgents: boolean, signal: AbortSignal | undefined): Promise<LoadedCount> {
	const tree = await transcriptTree(ref);
	const transcripts: readonly TranscriptRow[] = withAgents ? tree : tree.slice(0, 1);
	const loaded: Array<{ readonly transcript: TranscriptRow; readonly loaded: LoadedSession; readonly records: EventRecord[] }> = [];
	for (const transcript of transcripts)
		loaded.push({ transcript, ...(await transcriptEvents(transcript, { types: null, window: null }, signal)) });
	const info = await readSessionInfo(ref.file);
	const loadedAt = new Date().toISOString();
	const insertSession = db.prepare(
		"INSERT INTO sessions (sid, project, cwd, title, created, modified, status, assistant_turns, size, recap, parent, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const insertTranscript = db.prepare(
		"INSERT INTO transcripts (sid, agent, parent, file, bytes, modified, title, created, parent_session, entries, on_branch, events, loaded_at, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const insertEvent = db.prepare(
		"INSERT INTO events (sid, agent, seq, turn, t, kind, entry, block, line, call_id, tool, status, result_entry, text, data, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	let events = 0;
	db.transaction(() => {
		for (const table of IMPORTED_TABLES) db.run(`DELETE FROM ${table} WHERE sid = ?`, [ref.sid]);
		for (const row of info ? metadata([info]) : []) {
			insertSession.run(
				row.sid,
				row.project,
				row.cwd,
				row.title,
				row.created,
				row.modified,
				row.status,
				row.assistantTurns,
				row.size,
				row.recap,
				row.parent,
				row.url,
			);
		}
		for (const { transcript, loaded: session, records } of loaded) {
			const meta = session.meta;
			insertTranscript.run(
				transcript.sid,
				transcript.agent,
				transcript.parent,
				transcript.file,
				transcript.bytes,
				transcript.modified,
				meta.title,
				meta.created,
				meta.parentSession,
				meta.entries,
				meta.onBranch,
				records.length,
				loadedAt,
				transcriptUrl(transcript.sid, transcript.agent),
			);
			records.forEach((record, seq) => {
				insertEvent.run(
					transcript.sid,
					transcript.agent,
					seq,
					int(record, "turn") ?? 0,
					str(record, "t") ?? "",
					str(record, "kind") ?? "",
					str(record, "entry") ?? "",
					int(record, "block"),
					int(record, "line") ?? 0,
					str(record, "callId"),
					str(record, "tool"),
					str(record, "status"),
					str(record, "resultEntry"),
					str(record, "text") ?? str(record, "source"),
					JSON.stringify(record),
					str(record, "url") ?? "",
				);
			});
			events += records.length;
		}
	})();
	return { sid: ref.sid, transcripts: loaded.length, events };
}

export interface LoadResult {
	readonly db: string;
	readonly loaded: readonly LoadedCount[];
	readonly bytes: number;
}

/** Imports each session into the workspace, one transaction per session. */
export async function load(
	at: Workspace,
	refs: readonly SessionRef[],
	withAgents: boolean,
	signal: AbortSignal | undefined,
): Promise<LoadResult> {
	const db = await open(at);
	try {
		ensureSchema(db);
		const loaded: LoadedCount[] = [];
		for (const ref of refs) loaded.push(await loadOne(db, ref, withAgents, signal));
		return { db: at.url, loaded, bytes: (await fs.stat(at.file)).size };
	} finally {
		db.close();
	}
}

export type Bindings = Cell[] | Record<string, Cell>;

export type SqlResult =
	| {
			readonly kind: "rows";
			readonly db: string;
			readonly columns: readonly string[];
			readonly rows: Record<string, Cell>[];
			readonly truncated: boolean;
	  }
	| { readonly kind: "changes"; readonly db: string; readonly changes: number };

function bind(params: Bindings | null): SQLQueryBindings[] {
	if (params === null) return [];
	// Named parameters: bun:sqlite matches the object's keys with their prefix (`$name`, `:name`, `@name`).
	return Array.isArray(params) ? params : [params];
}

/**
 * Runs `query`. A statement that returns rows (SELECT, PRAGMA, … RETURNING) runs
 * alone and yields at most `limit` rows; otherwise the whole script runs, with
 * `params` allowed only for a single statement.
 */
export function sql(at: Workspace, query: string, params: Bindings | null, limit: number): Promise<SqlResult> {
	return withDb(at, (db): SqlResult => {
		const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(query);
		if (statement.columnNames.length > 0) {
			const rows: Record<string, Cell>[] = [];
			let truncated = false;
			for (const row of statement.iterate(...bind(params))) {
				if (rows.length === limit) {
					truncated = true;
					break;
				}
				rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])));
			}
			return { kind: "rows", db: at.url, columns: statement.columnNames, rows, truncated };
		}
		const changes = params === null ? db.run(query).changes : statement.run(...bind(params)).changes;
		return { kind: "changes", db: at.url, changes };
	});
}

/** A caller value as a SQLite value: booleans as 0/1, dates as ISO text, other objects as JSON text. */
function storable(value: unknown): SQLQueryBindings {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`save: ${value} is not a finite number`);
		return value;
	}
	if (typeof value === "string" || typeof value === "bigint" || value instanceof Uint8Array) return value;
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(value);
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export interface SaveResult {
	readonly db: string;
	readonly table: string;
	readonly rows: number;
	readonly columns: readonly string[];
}

/** Writes `rows` as table `table`: `replace` recreates it, `append` adds rows and any new columns. */
export function save(
	at: Workspace,
	table: string,
	rows: readonly Readonly<Record<string, unknown>>[],
	mode: "replace" | "append",
): Promise<SaveResult> {
	if (IMPORTED_TABLES.includes(table)) throw new Error(`save: ${table} is filled by load; save under another name`);
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	if (columns.length === 0) throw new Error("save: rows carry no columns");
	return withDb(at, (db): SaveResult => {
		db.transaction(() => {
			switch (mode) {
				case "replace":
					db.run(`DROP TABLE IF EXISTS ${quote(table)}`);
					db.run(`CREATE TABLE ${quote(table)} (${columns.map(quote).join(", ")})`);
					break;
				case "append": {
					db.run(`CREATE TABLE IF NOT EXISTS ${quote(table)} (${columns.map(quote).join(", ")})`);
					const existing = new Set(
						db
							.query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
							.all()
							.map((info) => info.name),
					);
					for (const column of columns) if (!existing.has(column)) db.run(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)}`);
					break;
				}
				default: {
					const unreachable: never = mode;
					throw new Error(`Unhandled save mode ${String(unreachable)}`);
				}
			}
			const insert = db.prepare(
				`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			);
			for (const row of rows) insert.run(...columns.map((column) => storable(row[column])));
		})();
		return { db: at.url, table, rows: rows.length, columns };
	});
}
