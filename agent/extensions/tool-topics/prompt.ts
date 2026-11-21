import type { ToolDocs } from "./catalog.ts";

export type Entry = { readonly kind: "ok"; readonly lines: readonly string[] } | { readonly kind: "drift"; readonly reason: string };

type Layout = "inline" | "command";

export class Description {
	readonly block: number;
	readonly start: number;
	readonly length: number;
	readonly layout: Layout;
	readonly examples: boolean;
	readonly tool: string;
	readonly #lines: readonly string[];

	constructor(block: number, lines: readonly string[], start: number, length: number, layout: Layout, examples: boolean, tool: string) {
		this.block = block;
		this.#lines = lines;
		this.start = start;
		this.length = length;
		this.layout = layout;
		this.examples = examples;
		this.tool = tool;
	}

	line(index: number): string {
		const raw = this.#lines[this.start + index] ?? "";
		if (this.layout === "command") {
			if (index === 0) {
				const prefix = `${this.tool} — `;
				return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
			}
			return raw;
		}
		return raw.startsWith("// ") ? raw.slice(3) : raw.slice(2);
	}
}

export type Rendered =
	| { readonly kind: "found"; readonly description: Description }
	| { readonly kind: "catalog" }
	| { readonly kind: "absent" }
	| { readonly kind: "drift"; readonly reason: string };

export interface Rewrite {
	readonly description: Description;
	readonly lines: readonly string[];
}

export interface PromptIndex {
	description(tool: string): Rendered;
	rewrite(rewrites: readonly Rewrite[]): string[];
}

const HEADING = /^(#{1,6}) (.+)$/;
const NATIVE = /\{\{native:([^}]+)\}\}/g;
const NAMESPACE_OPEN = "namespace functions {";
const NAMESPACE_CLOSE = "} // namespace functions";
const TOOL_COMMANDS_HEADING = "# Tool Commands";
const CATALOG_HEADING = "## More commands (help on demand)";
const COMMAND_DRIFT = "tool command section no longer has the heading/blank/<tool> — description/blank/Usage: layout";

function inlineDescriptions(block: number, lines: readonly string[], tools: readonly string[]): Map<string, Rendered> {
	const found = new Map<string, Rendered>();
	const open = lines.indexOf(NAMESPACE_OPEN);
	const close = lines.indexOf(NAMESPACE_CLOSE);
	if (open < 0 || close < open) return found;
	for (let index = open + 1; index < close; index++) {
		const line = lines[index] ?? "";
		if (!line.startsWith("type ")) continue;
		for (const tool of tools) {
			if (found.has(tool) || !line.startsWith(tool, 5) || !line.startsWith(" = ", 5 + tool.length)) continue;
			let start = index;
			while (start - 1 > open && (lines[start - 1] ?? "").startsWith("//")) start--;
			let end = index;
			let examples = false;
			for (let comment = start; comment < index; comment++) {
				const text = lines[comment] ?? "";
				if (text !== "// @example" && !text.startsWith("// @example ")) continue;
				examples = true;
				end = comment > start && lines[comment - 1] === "//" ? comment - 1 : comment;
				break;
			}
			found.set(tool, { kind: "found", description: new Description(block, lines, start, end - start, "inline", examples, tool) });
		}
	}
	return found;
}

function commandSection(block: number, lines: readonly string[], heading: number, tool: string): Rendered {
	let usage = -1;
	for (let index = heading + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("## ") || line.startsWith("# ")) break;
		if (line === "Usage:") {
			usage = index;
			break;
		}
	}
	const prefix = `${tool} — `;
	if (usage < heading + 4 || lines[heading + 1] !== "" || !(lines[heading + 2] ?? "").startsWith(prefix) || lines[usage - 1] !== "") {
		return { kind: "drift", reason: COMMAND_DRIFT };
	}
	return { kind: "found", description: new Description(block, lines, heading + 2, usage - heading - 3, "command", false, tool) };
}

function commandDescriptions(block: number, lines: readonly string[], tools: readonly string[]): Map<string, Rendered> {
	const found = new Map<string, Rendered>();
	const start = lines.indexOf(TOOL_COMMANDS_HEADING);
	if (start < 0) return found;
	let inCatalog = false;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("# ")) break;
		if (line === CATALOG_HEADING) {
			inCatalog = true;
			continue;
		}
		if (line.startsWith("## ")) {
			inCatalog = false;
			for (const tool of tools) {
				if (found.has(tool) || line !== `## ${tool}`) continue;
				found.set(tool, commandSection(block, lines, index, tool));
			}
			continue;
		}
		if (inCatalog && line.startsWith("- `")) {
			for (const tool of tools) {
				if (found.has(tool) || !line.startsWith(`- \`${tool}\` — `)) continue;
				found.set(tool, { kind: "catalog" });
			}
		}
	}
	return found;
}

function renderLines(description: Description, replacement: readonly string[]): string[] {
	switch (description.layout) {
		case "inline": {
			const rendered = replacement.map((line) => (line === "" ? "//" : `// ${line}`.trimEnd()));
			if (description.examples && description.length === 0 && rendered.length > 0) rendered.push("//");
			return rendered;
		}
		case "command": {
			if (replacement.length === 0) return [`${description.tool} — session tool`];
			return [`${description.tool} — ${replacement[0]}`, ...replacement.slice(1)];
		}
		default: {
			const unreachable: never = description.layout;
			return unreachable;
		}
	}
}

export function indexPrompt(blocks: readonly string[], tools: readonly string[]): PromptIndex {
	const found = new Map<string, Rendered>();
	const split = new Map<number, string[]>();
	let pending = tools;
	for (const [block, text] of blocks.entries()) {
		if (pending.length === 0) break;
		const lines = text.split("\n");
		split.set(block, lines);
		const inline = inlineDescriptions(block, lines, pending);
		const commands = commandDescriptions(block, lines, pending);
		for (const tool of pending) {
			const section = inline.get(tool) ?? commands.get(tool);
			if (section !== undefined) found.set(tool, section);
		}
		pending = pending.filter((tool) => !found.has(tool));
	}
	return {
		description(tool) {
			return found.get(tool) ?? { kind: "absent" };
		},
		rewrite(rewrites) {
			const byBlock = new Map<number, Rewrite[]>();
			for (const rewrite of rewrites) {
				const list = byBlock.get(rewrite.description.block);
				if (list === undefined) byBlock.set(rewrite.description.block, [rewrite]);
				else list.push(rewrite);
			}
			return blocks.map((text, block) => {
				const list = byBlock.get(block);
				const original = split.get(block);
				if (list === undefined || original === undefined) return text;
				const lines = [...original];
				list.sort((a, b) => b.description.start - a.description.start);
				for (const { description, lines: replacement } of list) {
					lines.splice(description.start, description.length, ...renderLines(description, replacement));
				}
				return lines.join("\n");
			});
		},
	};
}

function nativeSection(description: Description, heading: string): string | undefined {
	let start = -1;
	let level = 0;
	for (let index = 0; index < description.length; index++) {
		const match = HEADING.exec(description.line(index));
		if (match?.[2] !== heading) continue;
		if (start >= 0) return undefined;
		start = index;
		level = match[1]?.length ?? 0;
	}
	if (start < 0) return undefined;
	const lines = [description.line(start)];
	for (let index = start + 1; index < description.length; index++) {
		const line = description.line(index);
		const match = HEADING.exec(line);
		if (match !== null && (match[1]?.length ?? 0) <= level) break;
		lines.push(line);
	}
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

export function toolLines(description: Description, docs: ToolDocs, indexed: boolean): Entry | undefined {
	const index =
		indexed && docs.topics.length > 0
			? [
					"Topics — read the one a call needs before making it:",
					...docs.topics.map((topic) => `- \`tool://${docs.tool}/${topic.name}\` — ${topic.when}`),
				]
			: undefined;
	let body: string[];
	if (docs.surface === undefined) {
		if (index === undefined) return undefined;
		body = Array.from({ length: description.length }, (_, line) => description.line(line));
	} else {
		const missing: string[] = [];
		const surface = docs.surface.replace(NATIVE, (whole, heading: string) => {
			const section = nativeSection(description, heading);
			if (section === undefined) missing.push(heading);
			return section ?? whole;
		});
		if (missing.length > 0) return { kind: "drift", reason: `native section(s) not found exactly once: ${missing.join(", ")}` };
		body = surface.split("\n");
	}
	if (index === undefined) return { kind: "ok", lines: body };
	return { kind: "ok", lines: body.length === 0 ? index : [...body, "", ...index] };
}
