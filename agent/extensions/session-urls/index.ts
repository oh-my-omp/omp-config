// session-urls — a read-only `session://` internal-URL scheme over the OMP
// session files on this machine (~/.omp/agent/sessions), plus the
// `session_query` tool that serves the same history as relations to eval.
// `read` renders a session's active-branch timeline (thinking, speech, IRC,
// dispatches and subagent results in full; tool calls as one-line
// signatures), filterable by event type and by a since/until time window,
// single entries in full, events/metadata JSONL with jq (OMP's jaq), and finds
// sessions by prompt-history FTS, title and recap; `grep`/`glob` walk one tree
// (projects/<bucket>/<date>/<id>/timeline) through readDirectory.
// The scheme is registered in OMP's process-global InternalUrlRouter at module
// load of the factory: main and subagent sessions in this process alike, full
// and light mode. Never replaces an OMP-owned scheme or another host's
// handler; a newer copy of this module replaces its own earlier registration.
// `session_query` (an xd device, called from eval as `tool.session_query`) is
// registered per session: sessions, agents and events return rows; load, sql
// and save work on the SQLite workspace local://sessions/<db>.sqlite in the
// calling session's local:// root, the only file it writes (workspace.ts).
// Reads session files, the recap journal and history.db; the scheme writes
// only a per-call temp JSONL for jq, removed before the read returns. No
// commands, hooks or config. Failures are warned or returned as tool errors,
// never thrown into OMP.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { HANDLER_MARK, SessionUrlHandler } from "./handler.ts";
import { router } from "./omp-adapter.ts";
import { sessionQueryTool } from "./query-tool.ts";

function registerScheme(pi: ExtensionAPI): void {
	const routes = router();
	if (routes.isBuiltin("session")) {
		pi.logger.warn("session-urls: OMP owns session://; not registering");
		return;
	}
	const existing = routes.getHandler("session");
	if (existing && !(HANDLER_MARK in existing)) {
		pi.logger.warn("session-urls: another host registered session://; not replacing it");
		return;
	}
	routes.register(new SessionUrlHandler());
}

export default function sessionUrls(pi: ExtensionAPI): void {
	try {
		registerScheme(pi);
	} catch (error) {
		pi.logger.warn("session-urls: registration failed", { error: errorText(error) });
	}
	pi.registerTool(sessionQueryTool((error) => pi.logger.warn("session-urls: session_query failed", { error: errorText(error) })));
}
