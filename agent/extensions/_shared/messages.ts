import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, TextContent } from "@oh-my-pi/pi-ai";

export type MessageContent = Message["content"];

export function textOf(content: MessageContent, separator = ""): string {
	if (typeof content === "string") return content;
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
	}
	return texts.join(separator);
}

/** Call on raw session JSONL content only; never on host messages, which are already typed. */
export function parseStoredContent(value: unknown): MessageContent {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: TextContent[] = [];
	for (const item of value) {
		const block: unknown = item;
		if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string") parts.push({ type: "text", text: block.text });
	}
	return parts;
}

export function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = textOf(message.content);
		if (text.trim() !== "") return text;
	}
	return "";
}
