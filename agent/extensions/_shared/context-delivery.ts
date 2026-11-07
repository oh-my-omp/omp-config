/**
 * Once-per-actual-context delivery, shared by conditional prompt injectors.
 * Persisted developer messages in the active-leaf model projection are the
 * authority, not session ids, compaction counters or the full transcript.
 * The pending set only covers the current turn's batch before OMP persists its
 * additionalContext developer message; turn_start drops that transient copy.
 *
 * One claim call answers a whole tool_result's markers with a single
 * leaf-to-root walk that re-derives the projection's emitted region instead of
 * materializing `buildSessionContext` per marker. The walk stops at the region
 * edge, replicating the host's boundaries: a `reset_boundary` after the latest
 * compaction truncates everything above it; otherwise the latest compaction
 * emits its kept tail (from `firstKeptEntryId`, or after
 * `providerReplayThroughEntryId` for Anthropic empty-tail and OpenAI remote
 * replacement) plus everything appended after it. Only `type: "message"`
 * entries can hold a developer message: custom messages, branch and compaction
 * summaries all emit other roles.
 */

import { getAnthropicCompactionPayload } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getOpenAiRemoteCompactionPayload } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { textOf } from "./messages.ts";

/**
 * `textOf(content, "\n").includes(marker)` without joining: the join inserts a
 * newline only between text blocks, so a marker without a newline matches the
 * joined text exactly when it matches one block. A marker containing a newline
 * (or the empty marker, which even block-less content satisfies) falls back to
 * the joined check.
 */
function contentIncludes(content: unknown, marker: string): boolean {
	if (typeof content === "string") return content.includes(marker);
	if (!Array.isArray(content) || marker === "" || marker.includes("\n")) {
		return textOf(content, "\n").includes(marker);
	}
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string" && block.text.includes(marker)) return true;
	}
	return false;
}

/**
 * Contents of the developer messages `buildSessionContext` emits for the
 * active leaf, found by walking leaf-to-root through `getEntry` without
 * materializing the entry set, the path or the emitted message list. Entries
 * walked before the latest compaction are only candidates: a boundary reached
 * later decides whether they were emitted.
 */
function deliveredContents(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager;
	const leafId = manager.getLeafId();
	if (leafId === null) return [];
	const leaf = manager.getEntry(leafId);
	if (leaf === undefined) return [];

	const contents: unknown[] = [];
	const seen = new Set<string>([leaf.id]);
	const parentOf = (entry: SessionEntry): SessionEntry | undefined => {
		if (entry.parentId === null || seen.has(entry.parentId)) return undefined;
		seen.add(entry.parentId);
		return manager.getEntry(entry.parentId);
	};
	const deliveredMessage = (entry: SessionEntry) =>
		entry.type === "message" && entry.message.role === "developer" ? entry.message : undefined;

	let current: SessionEntry | undefined = leaf;
	while (current !== undefined) {
		const entry = current;
		current = parentOf(entry);
		// A boundary leaf-side of every compaction truncates the projection above it.
		if (entry.type === "reset_boundary") return contents;
		if (entry.type === "compaction") {
			const remote = getOpenAiRemoteCompactionPayload(entry);
			const anthropic =
				remote === undefined && entry.firstKeptEntryId === "" && entry.providerReplayThroughEntryId !== undefined
					? getAnthropicCompactionPayload(entry.preserveData)
					: undefined;
			// The id bounding the kept region root-side of the compaction:
			// inclusive for a plain kept tail, exclusive after the replay markers.
			const boundId =
				remote !== undefined || anthropic !== undefined
					? entry.providerReplayThroughEntryId
					: entry.firstKeptEntryId === ""
						? undefined
						: entry.firstKeptEntryId;
			const boundInclusive = remote === undefined && anthropic === undefined;
			const kept: unknown[] = [];
			while (current !== undefined && current.id !== boundId) {
				const older = current;
				current = parentOf(older);
				const message = deliveredMessage(older);
				if (message !== undefined) kept.push(message.content);
			}
			if (current === undefined) return contents;
			const bound = deliveredMessage(current);
			if (boundInclusive && bound !== undefined) kept.push(bound.content);
			contents.push(...kept);
			return contents;
		}
		const message = deliveredMessage(entry);
		if (message !== undefined) contents.push(message.content);
	}
	return contents;
}

/** Call only after content is ready to return through tool_result.additionalContext. */
export function createContextDelivery(pi: ExtensionAPI): (ctx: ExtensionContext, markers: readonly string[]) => boolean[] {
	const pending = new Set<string>();
	pi.on("turn_start", () => pending.clear());
	return (ctx, markers) => {
		const claims = markers.map(() => false);
		const seen = new Set<string>();
		const wanted: number[] = [];
		for (let i = 0; i < markers.length; i++) {
			const marker = markers[i];
			if (marker !== undefined && !pending.has(marker) && !seen.has(marker)) {
				seen.add(marker);
				wanted.push(i);
			}
		}
		if (wanted.length === 0) return claims;
		const contents = deliveredContents(ctx);
		for (const i of wanted) {
			const marker = markers[i];
			if (marker === undefined) continue;
			if (!contents.some((content) => contentIncludes(content, marker))) {
				pending.add(marker);
				claims[i] = true;
			}
		}
		return claims;
	};
}
