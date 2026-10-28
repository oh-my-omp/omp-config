// The session:// ProtocolHandler: routes → directory listings (readDirectory,
// so grep/glob walk the tree), rendered leaves (resolve, built in memory per
// call, never written to disk), host files (locate: raw.jsonl, artifacts,
// local) and jq over the event and metadata JSONL (OMP's jaq via
// executeJsonQuery on a per-call temp file removed before returning).
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntry, loadSession } from "./events.ts";
import {
	executeJsonQuery,
	getSessionsDir,
	type InternalResource,
	type InternalUrl,
	latestRecaps,
	listSessions,
	type ProtocolHandler,
	parseJsonSelector,
	promptMatches,
	type ResolveContext,
	readSessionInfo,
	type SchemeSpec,
	type SessionInfo,
	type ShellFsDirEntry,
	ShellFsFileType,
	sessionDirForCwd,
} from "./omp-adapter.ts";
import { README } from "./readme.ts";
import { eventRecords, renderEntry, renderTimeline } from "./render.ts";
import {
	agentFile,
	bucketDir,
	bucketSessions,
	childAgents,
	childDir,
	localDate,
	locateSession,
	parseRoute,
	type Route,
	type SessionPath,
	type SessionRef,
} from "./routes.ts";

export const HANDLER_MARK = Symbol.for("omp-config.session-urls.handler.v1");

const JQ_KEYS: Readonly<Record<string, true>> = { q: true, query: true, raw: true, compact: true, offset: true, limit: true };
const FIND_KEYS: Readonly<Record<string, true>> = { text: true, project: true, max: true };
const ALL_SESSIONS = 1_000_000;
const DEFAULT_FIND = 20;

interface Located {
	readonly ref: SessionRef;
	readonly file: string;
	/** Canonical URL of this transcript: `session://<sid>` or `…/agents/<id>`. */
	readonly base: string;
	readonly root: string;
}

function routeOf(url: InternalUrl): Route {
	return parseRoute(url.rawHost || url.hostname, url.rawPathname ?? url.pathname, url.href);
}

function query(url: InternalUrl): URLSearchParams {
	return new URLSearchParams(url.search.startsWith("?") ? url.search.slice(1) : url.search);
}

/** Rejects query keys outside `allowed`, naming them. */
function checkKeys(url: InternalUrl, allowed: readonly Readonly<Record<string, true>>[]): void {
	for (const key of query(url).keys()) {
		if (!allowed.some((table) => table[key] === true))
			throw new Error(`session:// does not accept ?${key}= on ${url.href.split("?")[0] ?? ""}`);
	}
}

async function locate(at: SessionPath, cwd: string | undefined): Promise<Located> {
	const ref = await locateSession(at.locator, cwd);
	const root = `session://${ref.sid}`;
	if (at.agent === "") return { ref, file: ref.file, base: root, root };
	return { ref, file: await agentFile(ref, at.agent), base: `${root}/agents/${at.agent}`, root };
}

function text(url: string, content: string): InternalResource {
	return { url, content, contentType: "text/plain", size: Buffer.byteLength(content) };
}

function jsonl(records: readonly unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n");
}

/** JSONL content, or OMP's jq output over it when the URL carries a JSON selector. */
async function jsonlResource(url: InternalUrl, records: readonly unknown[], signal: AbortSignal | undefined): Promise<InternalResource> {
	const selector = parseJsonSelector(url.search.startsWith("?") ? url.search.slice(1) : url.search);
	if (!selector) return text(url.href, jsonl(records));
	const scratch = path.join(os.tmpdir(), `session-urls-${crypto.randomUUID()}.jsonl`);
	try {
		await Bun.write(scratch, jsonl(records));
		return text(url.href, await executeJsonQuery(scratch, selector, signal));
	} finally {
		await fs.rm(scratch, { force: true });
	}
}

function metadata(infos: readonly SessionInfo[]): Array<Record<string, unknown>> {
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

/** `find?text=…[&project=.|<bucket>|<path>][&max=N]`: prompt-history FTS plus title/first-prompt/recap words. */
async function find(url: InternalUrl, cwd: string | undefined): Promise<Array<Record<string, unknown>>> {
	const params = query(url);
	const needle = params.get("text")?.trim() ?? "";
	if (needle === "") throw new Error("session://find needs ?text=<words>");
	const max = Number(params.get("max") ?? DEFAULT_FIND);
	if (!Number.isInteger(max) || max < 1) throw new Error("session://find ?max= must be a positive integer");
	const project = params.get("project");
	let dir: string | undefined;
	if (project === ".") {
		if (!cwd) throw new Error("session://find?project=. needs the calling session's working directory");
		dir = sessionDirForCwd(cwd);
	} else if (project !== null)
		dir = project.includes("/") ? sessionDirForCwd(path.resolve(cwd ?? "/", project)) : path.join(getSessionsDir(), project);
	const records = metadata(await listSessions(dir, ALL_SESSIONS));
	const fromPrompts = new Set(promptMatches(needle, 500));
	const words = needle.toLowerCase().split(/\s+/);
	return records
		.filter((record) => {
			if (fromPrompts.has(String(record.sid))) return true;
			const haystack = `${String(record.title)}\n${String(record.recap ?? "")}`.toLowerCase();
			return words.every((word) => haystack.includes(word));
		})
		.slice(0, max);
}

/** Directory entries for a directory route, or null for a leaf. */
async function listing(route: Route, cwd: string | undefined): Promise<ShellFsDirEntry[] | null> {
	const dir = (name: string): ShellFsDirEntry => ({ name, fileType: ShellFsFileType.Dir });
	const file = (name: string): ShellFsDirEntry => ({ name, fileType: ShellFsFileType.File });
	switch (route.kind) {
		case "root":
			return [dir("projects")];
		case "projects": {
			const entries = await fs.readdir(getSessionsDir(), { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => dir(entry.name));
		}
		case "bucket": {
			const dates = new Set((await bucketSessions(bucketDir(route.bucket, cwd))).map((session) => localDate(session.created)));
			return [...[...dates].sort().map(dir), file("sessions.jsonl")];
		}
		case "date": {
			const sessions = await bucketSessions(bucketDir(route.bucket, cwd));
			return sessions.filter((session) => localDate(session.created) === route.date).map((session) => dir(session.sid));
		}
		case "sessionDir": {
			const located = await locate(route.at, cwd);
			const agents = await childAgents(located.file);
			return agents.length > 0 ? [file("timeline"), dir("agents")] : [file("timeline")];
		}
		case "agentsDir": {
			const located = await locate(route.at, cwd);
			return (await childAgents(located.file)).map(dir);
		}
		case "readme":
		case "bucketSessions":
		case "allSessions":
		case "find":
		case "timeline":
		case "events":
		case "raw":
		case "entry":
		case "artifact":
		case "local":
			return null;
		default: {
			const unreachable: never = route;
			throw new Error(`Unhandled route ${String(unreachable)}`);
		}
	}
}

/** Host file behind a file-backed leaf, or null when the leaf is rendered or carries a query. */
async function hostFile(route: Route, url: InternalUrl, cwd: string | undefined): Promise<string | null> {
	switch (route.kind) {
		case "raw":
			if (url.search) return null;
			return (await locate(route.at, cwd)).file;
		case "artifact": {
			const located = await locate(route.at, cwd);
			const dir = childDir(located.ref.file);
			const names = await fs.readdir(dir).catch((): string[] => []);
			const name = names.find((candidate) => candidate.startsWith(`${route.id}.`));
			return name ? path.join(dir, name) : null;
		}
		case "local": {
			const located = await locate(route.at, cwd);
			const file = path.join(childDir(located.ref.file), "local", route.relative);
			return (await Bun.file(file).exists()) ? file : null;
		}
		case "root":
		case "readme":
		case "projects":
		case "bucket":
		case "bucketSessions":
		case "date":
		case "allSessions":
		case "find":
		case "sessionDir":
		case "agentsDir":
		case "timeline":
		case "events":
		case "entry":
			return null;
		default: {
			const unreachable: never = route;
			throw new Error(`Unhandled route ${String(unreachable)}`);
		}
	}
}

async function leaf(route: Route, url: InternalUrl, context: ResolveContext | undefined): Promise<InternalResource> {
	const cwd = context?.cwd;
	const signal = context?.signal;
	switch (route.kind) {
		case "readme":
			return text(url.href, README);
		case "allSessions":
			return jsonlResource(url, metadata(await listSessions(undefined, ALL_SESSIONS)), signal);
		case "bucketSessions":
			return jsonlResource(url, metadata(await listSessions(bucketDir(route.bucket, cwd), ALL_SESSIONS)), signal);
		case "find":
			return jsonlResource(url, await find(url, cwd), signal);
		case "timeline": {
			const located = await locate(route.at, cwd);
			const loaded = await loadSession(located.file, located.ref.sid, route.at.agent, signal);
			// OMP keeps generated titles in its session index; the journal's own title slot is often empty.
			const title = route.at.agent === "" && !loaded.meta.title ? ((await readSessionInfo(located.file))?.title ?? null) : null;
			return text(url.href, renderTimeline(loaded, located.base, located.root, title));
		}
		case "events": {
			const located = await locate(route.at, cwd);
			const loaded = await loadSession(located.file, located.ref.sid, route.at.agent, signal);
			return jsonlResource(url, eventRecords(loaded, located.base), signal);
		}
		case "entry": {
			const located = await locate(route.at, cwd);
			const detail = await loadEntry(located.file, route.selector, signal);
			const name = route.selector.kind === "id" ? `#${route.selector.id}` : `line ${route.selector.line}`;
			if (!detail) throw new Error(`No entry ${name} in ${located.base}`);
			return text(url.href, renderEntry(detail, located.base, located.ref.sid));
		}
		case "raw":
			if (url.search)
				throw new Error(
					`${url.href.split("?")[0] ?? ""} takes no query: jq runs on events.jsonl and sessions.jsonl; grep or read raw.jsonl directly.`,
				);
			throw new Error(`Session file for ${url.href} not found`);
		case "artifact":
		case "local":
			throw new Error(`${url.href} not found in the session's artifacts`);
		case "root":
		case "projects":
		case "bucket":
		case "date":
		case "sessionDir":
		case "agentsDir":
			throw new Error(`${url.href} is a directory`);
		default: {
			const unreachable: never = route;
			throw new Error(`Unhandled route ${String(unreachable)}`);
		}
	}
}

function allowedKeys(route: Route): readonly Readonly<Record<string, true>>[] {
	switch (route.kind) {
		case "events":
		case "allSessions":
		case "bucketSessions":
			return [JQ_KEYS];
		case "find":
			return [JQ_KEYS, FIND_KEYS];
		case "raw":
			return [JQ_KEYS]; // accepted only to answer with the jq-is-not-here error
		default:
			return [];
	}
}

export class SessionUrlHandler implements ProtocolHandler {
	readonly scheme = "session";
	readonly [HANDLER_MARK] = true;
	readonly spec: SchemeSpec = { backing: "file", selectors: "lines", immutable: true, linkable: false };

	promptDoc(): string {
		return "`session://`: other OMP sessions on this machine (read-only). Find: `session://find?text=<words>`, `session://sessions.jsonl?q=<jq>`; read: `session://<id>/timeline` (thinking, speech, IRC, calls as signatures), `…/entry/<id>` for one call's full args/result, `…/events.jsonl?q=<jq>`; grep `session://here/<date>/*/timeline`. Grammar: `read session://README`.";
	}

	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const route = routeOf(url);
		try {
			return await hostFile(route, url, context?.cwd);
		} catch {
			// Unknown or ambiguous sessions are reported by resolve with the full reason.
			return null;
		}
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = routeOf(url);
		checkKeys(url, allowedKeys(route));
		const entries = await listing(route, context?.cwd);
		if (entries) {
			const content = context?.skipDirectoryListing
				? ""
				: entries.map((entry) => (entry.fileType === ShellFsFileType.Dir ? `${entry.name}/` : entry.name)).join("\n");
			return { ...text(url.href, content), isDirectory: true };
		}
		return leaf(route, url, context);
	}

	async readDirectory(url: InternalUrl, context?: ResolveContext): Promise<ShellFsDirEntry[]> {
		const entries = await listing(routeOf(url), context?.cwd);
		if (!entries) throw new Error(`${url.href} is not a directory`);
		return entries;
	}
}
