/**
 * Once-per-actual-context delivery, shared by conditional prompt injectors.
 * Persisted developer messages in the active-leaf model projection are the
 * authority, not session ids, compaction counters or the full transcript.
 * The pending set only covers the current turn's batch before OMP persists its
 * additionalContext developer message; turn_start drops that transient copy.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { textOf } from "./messages.ts";

/** Call only after content is ready to return through tool_result.additionalContext. */
export function createContextDelivery(pi: ExtensionAPI): (ctx: ExtensionContext, marker: string) => boolean {
	const pending = new Set<string>();
	pi.on("turn_start", () => pending.clear());
	return (ctx, marker) => {
		if (pending.has(marker)) return false;
		const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		for (const message of messages) {
			if ("role" in message && message.role === "developer" && textOf(message.content, "\n").includes(marker)) return false;
		}
		pending.add(marker);
		return true;
	};
}
