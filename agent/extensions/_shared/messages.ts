export function textOf(content: unknown, separator = ""): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join(separator);
}

export function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message: unknown = messages[i];
		if (typeof message !== "object" || message === null) continue;
		if (!("role" in message) || message.role !== "assistant") continue;
		const text = textOf("content" in message ? message.content : undefined);
		if (text.trim() !== "") return text;
	}
	return "";
}
