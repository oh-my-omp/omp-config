// session-urls — a read-only `session://` internal-URL scheme over the OMP
// session files on this machine (~/.omp/agent/sessions). `read` renders a
// session's active-branch timeline (thinking, speech, IRC, dispatches and
// subagent results in full; tool calls as one-line signatures), filterable by
// event type and by a since/until time window, single entries
// in full, events/metadata JSONL with jq (OMP's jaq), and finds sessions by
// prompt-history FTS, title and recap; `grep`/`glob` walk one tree
// (projects/<bucket>/<date>/<id>/timeline) through readDirectory.
// Registers the scheme in OMP's process-global InternalUrlRouter at module
// load of the factory: main and subagent sessions in this process alike, full
// and light mode. Never replaces an OMP-owned scheme or another host's
// handler; a newer copy of this module replaces its own earlier registration.
// Reads session files, the recap journal and history.db; writes only a
// per-call temp JSONL for jq, removed before the read returns. No tools,
// commands, hooks or config. Failures are warned, never thrown into OMP.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { HANDLER_MARK, SessionUrlHandler } from "./handler.ts";
import { router } from "./omp-adapter.ts";

export default function sessionUrls(pi: ExtensionAPI): void {
	try {
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
	} catch (error) {
		pi.logger.warn("session-urls: registration failed", { error: errorText(error) });
	}
}
