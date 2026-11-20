import { getAnthropicCompactionPayload } from "@oh-my-pi/pi-agent-core";
import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getOpenAiRemoteCompactionPayload } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { textOf } from "./messages.ts";

function contentIncludes(content: DeveloperMessage["content"], marker: string): boolean {
	if (typeof content === "string") return content.includes(marker);
	if (marker === "" || marker.includes("\n")) return textOf(content, "\n").includes(marker);
	for (const block of content) {
		if (block.type === "text" && block.text.includes(marker)) return true;
	}
	return false;
}

function deliveredContents(ctx: ExtensionContext): DeveloperMessage["content"][] {
	const manager = ctx.sessionManager;
	const leafId = manager.getLeafId();
	if (leafId === null) return [];
	const leaf = manager.getEntry(leafId);
	if (leaf === undefined) return [];

	const contents: DeveloperMessage["content"][] = [];
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
		if (entry.type === "reset_boundary") return contents;
		if (entry.type === "compaction") {
			const remote = getOpenAiRemoteCompactionPayload(entry);
			const anthropic =
				remote === undefined && entry.firstKeptEntryId === "" && entry.providerReplayThroughEntryId !== undefined
					? getAnthropicCompactionPayload(entry.preserveData)
					: undefined;
			const boundId =
				remote !== undefined || anthropic !== undefined
					? entry.providerReplayThroughEntryId
					: entry.firstKeptEntryId === ""
						? undefined
						: entry.firstKeptEntryId;
			const boundInclusive = remote === undefined && anthropic === undefined;
			const kept: DeveloperMessage["content"][] = [];
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
