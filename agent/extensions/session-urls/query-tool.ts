// The session_query tool: this machine's OMP session history as relations for
// eval cells, which call it as `tool.session_query({...})` and read `.details`.
// Row actions (sessions, agents, events) return bounded pages; load, sql and
// save work on a SQLite workspace in the caller's local:// root (workspace.ts).
// The request is parsed once here into a discriminated union.
import { type ExtensionContext, type ToolDefinition, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { parseTypeFilter } from "./filter.ts";
import type { LocalProtocolOptions } from "./omp-adapter.ts";
import { ALL_SESSIONS, sessionRows, transcriptEvents, transcriptRow, transcriptTree } from "./relations.ts";
import { agentFile, locateSession, type SessionRef } from "./routes.ts";
import { load, save, sql, workspace } from "./workspace.ts";

export const TOOL = "session_query";

const DEFAULT_DB = "sessions";
const MAX_LOAD = 50;

const sid = z.string().min(1).describe("session id or unique id prefix");
const db = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,64}$/)
	.optional()
	.describe(`workspace name: local://sessions/<db>.sqlite; default ${DEFAULT_DB}`);
const cell = z.union([z.string(), z.number(), z.null()]);

const params = z.union([
	z
		.object({
			action: z.literal("sessions"),
			project: z.string().min(1).optional().describe("`.` this project, a bucket name or a path; omitted: every project"),
			text: z.string().min(1).optional().describe("words matched against typed prompts, title and recap"),
			since: z.string().optional().describe("ISO date/time; modified at or after"),
			until: z.string().optional().describe("ISO date/time; modified before"),
			limit: z.number().int().min(1).max(ALL_SESSIONS).optional().describe("default 200"),
		})
		.strict(),
	z.object({ action: z.literal("agents"), sid }).strict(),
	z
		.object({
			action: z.literal("events"),
			sid,
			agent: z.string().optional().describe("subagent id; omitted: the root transcript"),
			type: z.string().optional().describe("session:// type filter, e.g. `thinking,irc` or `call:bash`"),
			offset: z.number().int().min(0).optional(),
			limit: z.number().int().min(1).max(5000).optional().describe("default 500"),
		})
		.strict(),
	z
		.object({
			action: z.literal("load"),
			db,
			sids: z.array(sid).min(1).max(MAX_LOAD),
			agents: z.boolean().optional().describe("also load every subagent transcript; default true"),
		})
		.strict(),
	z
		.object({
			action: z.literal("sql"),
			db,
			query: z.string().min(1),
			params: z.union([z.array(cell), z.record(z.string(), cell)]).optional(),
			limit: z.number().int().min(1).max(100_000).optional().describe("row cap; default 1000"),
		})
		.strict(),
	z
		.object({
			action: z.literal("save"),
			db,
			table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
			rows: z.array(z.record(z.string(), z.unknown())).min(1),
			mode: z.enum(["replace", "append"]).optional().describe("default replace"),
		})
		.strict(),
]);

type Request = z.infer<typeof params>;
type Details = Record<string, unknown>;

const DESCRIPTION = [
	"Relational queries over this machine's OMP session history, called from eval: `(await tool.session_query({action, …})).details` in a JS or Python cell.",
	"`sessions`, `agents` and `events` return rows; `load` imports sessions into a SQLite workspace (`local://sessions/<db>.sqlite`), where `sql` runs SQL and `save` stores rows as a table.",
].join("\n");

interface Topic {
	readonly name: string;
	readonly when: string;
	readonly body: string;
}

const TOPICS: readonly Topic[] = [
	{
		name: "actions",
		when: "before a session_query call",
		body: `# session_query actions

Call from eval; \`.details\` holds the result. The same call works in Python: \`(await tool.session_query({...}))\`.

| action | parameters | details |
|---|---|---|
| \`sessions\` | \`project\` (\`.\`, bucket, path; omitted = all), \`text\`, \`since\`, \`until\` (ISO, on \`modified\`), \`limit\` (default 200) | \`{rows}\`: sid url timeline project cwd title created modified status assistantTurns size recap parent, newest first; filters apply before \`limit\` |
| \`agents\` | \`sid\` | \`{rows}\`: sid agent parent file bytes modified; the root has agent "" and parent null; a subagent's parent is the allocated id it ran under |
| \`events\` | \`sid\`, \`agent\`, \`type\` (session:// type filter), \`offset\`, \`limit\` (default 500) | \`{rows, total, offset, next}\`: the records of \`session://<id>/events.jsonl\`; \`next\` is the next offset or null |
| \`load\` | \`sids\` (≤ ${MAX_LOAD}), \`agents\` (default true), \`db\` | \`{db, loaded: [{sid, transcripts, events}], bytes}\` |
| \`sql\` | \`query\`, \`params\` (array or \`{$name: value}\`), \`limit\` (default 1000), \`db\` | rows: \`{kind: "rows", db, columns, rows, truncated}\`; otherwise \`{kind: "changes", db, changes}\` |
| \`save\` | \`table\`, \`rows\` (objects), \`mode\` (\`replace\` default, \`append\`), \`db\` | \`{db, table, rows, columns}\` |

- A statement returning rows (SELECT, PRAGMA, \`… RETURNING\`) runs alone: put one statement per call. Without \`params\` a statement list that returns no rows runs whole (\`CREATE TABLE …; INSERT …\`).
- Values crossing back are strings, numbers and null: integers beyond 2^53 come back as decimal strings, blobs as base64.
- \`save\` stores booleans as 0/1, dates as ISO text and objects/arrays as JSON text; columns are the union of the rows' keys.
- \`events\` and \`load\` read whole transcripts; the largest take seconds. Narrow with \`sessions\` first.
`,
	},
	{
		name: "workspace",
		when: "before load, sql or save, or when joining workspace tables",
		body: `# The SQLite workspace

\`local://sessions/<db>.sqlite\` in this session's local:// root (default db \`sessions\`), shared by later cells and by subagents using the same root. \`read local://sessions/<db>.sqlite\` lists its tables and shows the resolved host path; table selectors (\`:<table>\`, \`?q=\`) work on that host path, not on the \`local://\` URL. It is a copy taken at \`load\`; \`load\` again to refresh.

\`load\` owns these tables and replaces one session's rows in each per call; \`save\` refuses their names:

- \`sessions\`(sid PK, project, cwd, title, created, modified, status, assistant_turns, size, recap, parent, url): the \`sessions\` action's row. \`parent\` is the header's parentSession as written: a file path (forks, task children) or a session id (continuations); it is not a foreign key.
- \`transcripts\`(sid, agent, PK (sid, agent); parent, file, bytes, modified, title, created, parent_session, entries, on_branch, events, loaded_at, url): one row per root ("" agent) or subagent transcript; \`parent\` is the allocated id it ran under.
- \`events\`(sid, agent, seq, PK (sid, agent, seq); turn, t, kind, entry, block, line, call_id, tool, status, result_entry, text, data, url): the active branch in order; \`seq\` numbers events within one load; \`data\` is the full record as JSON (\`json_extract(data, '$.args.path')\`, \`json_each(data, '$.children')\`). Text longer than the session:// limits ends with \`…[clipped: N chars total]\`; \`url\` reads the entry in full.

Identity: a transcript is (sid, agent). A call joins to its result through \`result_entry\` (an entry id in the same transcript). A dispatch's requested children (\`data.children[].name/agent\`) are not allocated subagent ids; subresults carry the allocated id in \`data.id\`.

\`\`\`js
await tool.session_query({ action: "load", sids: ["019a"] });
const { details } = await tool.session_query({ action: "sql", query: \`
  SELECT e.tool, count(*) n, sum(e.status = 'error') errors
  FROM events e JOIN transcripts t USING (sid, agent)
  WHERE e.kind = 'call' GROUP BY e.tool ORDER BY n DESC\` });
await tool.session_query({ action: "save", table: "my_rows", rows: details.rows });
\`\`\`
`,
	},
];

const TOPIC_POINTERS = [
	"Topics — read the one a call needs before making it:",
	...TOPICS.map((topic) => `- \`xd://${TOOL}/${topic.name}\` — ${topic.when}`),
].join("\n");

function topics(): Readonly<Record<string, string>> {
	return Object.fromEntries(TOPICS.map((topic) => [topic.name, topic.body]));
}

function parseInstant(value: string | undefined, name: string): number | null {
	if (value === undefined) return null;
	const at = Date.parse(value);
	if (Number.isNaN(at)) throw new Error(`${name}: ${JSON.stringify(value)} is not an ISO date or time`);
	return at;
}

function localOptions(ctx: ExtensionContext): LocalProtocolOptions {
	return (
		ctx.localProtocolOptions ?? {
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		}
	);
}

async function refsOf(sids: readonly string[], cwd: string): Promise<SessionRef[]> {
	const refs: SessionRef[] = [];
	for (const prefix of sids) {
		const ref = await locateSession({ kind: "prefix", prefix }, cwd);
		if (!refs.some((known) => known.sid === ref.sid)) refs.push(ref);
	}
	return refs;
}

async function run(request: Request, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<Details> {
	switch (request.action) {
		case "sessions": {
			const rows = await sessionRows(
				{
					project: request.project ?? null,
					text: request.text ?? null,
					since: parseInstant(request.since, "since"),
					until: parseInstant(request.until, "until"),
					limit: request.limit ?? 200,
				},
				ctx.cwd,
			);
			return { rows };
		}
		case "agents": {
			const [ref] = await refsOf([request.sid], ctx.cwd);
			return { rows: ref ? await transcriptTree(ref) : [] };
		}
		case "events": {
			const [ref] = await refsOf([request.sid], ctx.cwd);
			if (!ref) return { rows: [], total: 0, offset: 0, next: null };
			const agent = request.agent ?? "";
			const file = agent === "" ? ref.file : await agentFile(ref, agent);
			const types = request.type === undefined ? null : parseTypeFilter([request.type]);
			const { records } = await transcriptEvents(await transcriptRow(ref.sid, agent, null, file), { types, window: null }, signal);
			const offset = request.offset ?? 0;
			const end = offset + (request.limit ?? 500);
			return { rows: records.slice(offset, end), total: records.length, offset, next: end < records.length ? end : null };
		}
		case "load":
			return {
				...(await load(
					workspace(request.db ?? DEFAULT_DB, localOptions(ctx)),
					await refsOf(request.sids, ctx.cwd),
					request.agents ?? true,
					signal,
				)),
			};
		case "sql":
			return {
				...(await sql(
					workspace(request.db ?? DEFAULT_DB, localOptions(ctx)),
					request.query,
					request.params ?? null,
					request.limit ?? 1000,
				)),
			};
		case "save":
			return {
				...(await save(workspace(request.db ?? DEFAULT_DB, localOptions(ctx)), request.table, request.rows, request.mode ?? "replace")),
			};
		default: {
			const unreachable: never = request;
			throw new Error(`Unhandled action ${String(unreachable)}`);
		}
	}
}

/** One line for a direct (non-eval) call; eval cells read `details`. */
function summary(request: Request, details: Details): string {
	const shown = JSON.stringify(details);
	return shown.length <= 8192 ? shown : `${request.action}: ${shown.length} chars of JSON in details; call from eval and read .details`;
}

/** Reading actions need read approval; workspace writes need write approval. */
function approval(args: unknown): "read" | "write" {
	const parsed = params.safeParse(args);
	if (!parsed.success) return "write";
	switch (parsed.data.action) {
		case "sessions":
		case "agents":
		case "events":
			return "read";
		case "load":
		case "sql":
		case "save":
			return "write";
		default: {
			const unreachable: never = parsed.data;
			throw new Error(`Unhandled action ${String(unreachable)}`);
		}
	}
}

export function sessionQueryTool(
	onError: (error: unknown) => void,
): ToolDefinition<typeof params> & { docTopics(): Readonly<Record<string, string>> } {
	return {
		name: TOOL,
		label: tr("Session Query", "会话查询"),
		description: `${DESCRIPTION}\n\n${TOPIC_POINTERS}`,
		approval,
		parameters: params,
		docTopics: topics,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const request = params.safeParse(rawParams);
			if (!request.success) return { content: [{ type: "text", text: `session_query: ${request.error.message}` }], isError: true };
			try {
				const details = await run(request.data, ctx, signal);
				return { content: [{ type: "text", text: summary(request.data, details) }], details };
			} catch (error) {
				onError(error);
				return { content: [{ type: "text", text: `session_query ${request.data.action} failed: ${errorText(error)}` }], isError: true };
			}
		},
	};
}
