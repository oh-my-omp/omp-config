// The tool-topics delta: what this extension adds to OMP's own tool descriptions, built from the
// descriptions as OMP rendered them into its system prompt, which is only read. A tool counts as
// rendered when its description is found by tool name, not wording, in one of two layouts:
//   inline tools  — `// `-prefixed description lines right above `type <tool> = …` inside
//                   `namespace functions { … }` (pi-ai dialect/inventory.ts renderToolInventory);
//   xd:// devices — `## <tool>[ — <label>]`, blank, description, blank, `### Schema`
//                   (pi-coding-agent tools/xdev.ts renderDocs with the "##" heading).
// One pass over the blocks locates every covered tool's section, kept as an offset into the block;
// the description's text is only composed for a `{{native:<Heading>}}` reference that needs it.
import type { ToolDocs, Topic } from "./catalog.ts";

/** One tool's part of the delta, or why it cannot be written against the rendered description. */
export type Entry = { readonly kind: "ok"; readonly text: string } | { readonly kind: "drift"; readonly reason: string };

/** A rendered description as the lines of the block that holds it, without its layout prefix. */
export interface Description {
	/** How many lines the description has. */
	readonly length: number;
	/** Line `index`, with the `// ` comment prefix removed on an inline description. */
	line(index: number): string;
}

/** A tool's description in the rendered prompt. */
export type Rendered =
	| { readonly kind: "found"; readonly description: Description }
	| { readonly kind: "absent" }
	| { readonly kind: "drift"; readonly reason: string };

/** The rendered prompt, with each covered tool's section located once. */
export interface PromptIndex {
	/** `tool`'s description in the first prompt block that renders it. */
	description(tool: string): Rendered;
}

const HEADING = /^(#{1,6}) (.+)$/;
const NATIVE = /\{\{native:([^}]+)\}\}/g;
const NAMESPACE_OPEN = "namespace functions {";
const NAMESPACE_CLOSE = "} // namespace functions";
const DEVICE_DRIFT = "xd:// device section no longer has the heading/blank/description/blank/### Schema layout";

/** `length` lines of `block` from `start`; `comments` strips the `//` marker of an inline description. */
class BlockLines implements Description {
	readonly #block: readonly string[];
	readonly #start: number;
	readonly #length: number;
	readonly #comments: boolean;

	constructor(block: readonly string[], start: number, length: number, comments: boolean) {
		this.#block = block;
		this.#start = start;
		this.#length = length;
		this.#comments = comments;
	}

	get length(): number {
		return this.#length;
	}

	line(index: number): string {
		const raw = this.#block[this.#start + index] ?? "";
		if (!this.#comments) return raw;
		return raw.startsWith("// ") ? raw.slice(3) : raw.slice(2);
	}
}

/** The inline-layout descriptions of `tools` in one block, the first signature of each winning. */
function inlineDescriptions(lines: readonly string[], tools: readonly string[]): Map<string, Rendered> {
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
			found.set(tool, { kind: "found", description: new BlockLines(lines, start, index - start, true) });
		}
	}
	return found;
}

/** The description a `## <tool>` heading opens, or the reason its section no longer fits the layout. */
function deviceSection(lines: readonly string[], heading: number): Rendered {
	let schema = -1;
	for (let index = heading + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("## ")) break;
		if (line === "### Schema") {
			schema = index;
			break;
		}
	}
	if (schema < 0 || lines[heading + 1] !== "" || lines[schema - 1] !== "") return { kind: "drift", reason: DEVICE_DRIFT };
	return { kind: "found", description: new BlockLines(lines, heading + 2, schema - heading - 3, false) };
}

/** The xd:// device descriptions of `tools` in one block, the first heading of each winning. */
function deviceDescriptions(lines: readonly string[], tools: readonly string[]): Map<string, Rendered> {
	const found = new Map<string, Rendered>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.startsWith("## ")) continue;
		for (const tool of tools) {
			if (found.has(tool)) continue;
			const rest = 3 + tool.length;
			if (!line.startsWith(tool, 3) || (line.length !== rest && !line.startsWith(" — ", rest))) continue;
			found.set(tool, deviceSection(lines, index));
		}
	}
	return found;
}

/**
 * Index `blocks` for `tools`: each block is split and scanned once for both layouts, and a tool's
 * section is taken from the first block that renders it, inline before device.
 */
export function indexPrompt(blocks: readonly string[], tools: readonly string[]): PromptIndex {
	const found = new Map<string, Rendered>();
	let pending = tools;
	for (const block of blocks) {
		if (pending.length === 0) break;
		const lines = block.split("\n");
		const inline = inlineDescriptions(lines, pending);
		const device = deviceDescriptions(lines, pending);
		for (const tool of pending) {
			const section = inline.get(tool) ?? device.get(tool);
			if (section !== undefined) found.set(tool, section);
		}
		pending = pending.filter((tool) => !found.has(tool));
	}
	return {
		description(tool) {
			return found.get(tool) ?? { kind: "absent" };
		},
	};
}

/** The `# Heading` line of a description, when exactly one of its lines is that heading. */
function nativeHeading(description: Description, heading: string): string | undefined {
	let hit: string | undefined;
	for (let index = 0; index < description.length; index++) {
		const line = description.line(index);
		if (HEADING.exec(line)?.[2] !== heading) continue;
		if (hit !== undefined) return undefined;
		hit = line;
	}
	return hit;
}

/** Index lines: one line per topic with its full URL and when to read it. */
function renderIndex(tool: string, topics: readonly Pick<Topic, "name" | "when">[]): string {
	return [
		"Topics — read the one a call needs before making it:",
		...topics.map((topic) => `- \`tool://${tool}/${topic.name}\` — ${topic.when}`),
	].join("\n");
}

/**
 * The `<tool>` element for one tool: its surface, where `{{native:<Heading>}}` becomes a reference
 * to that section of the rendered description, then its index when `indexed`. Undefined when the
 * tool has neither a surface nor topics to show.
 */
export function toolEntry(description: Description, docs: ToolDocs, indexed: boolean): Entry | undefined {
	const index = indexed && docs.topics.length > 0 ? renderIndex(docs.tool, docs.topics) : undefined;
	if (docs.surface === undefined) {
		return index === undefined ? undefined : { kind: "ok", text: `<tool name="${docs.tool}" description="kept">\n${index}\n</tool>` };
	}
	const missing: string[] = [];
	const surface = docs.surface.replace(NATIVE, (_whole, heading: string) => {
		const line = nativeHeading(description, heading);
		if (line === undefined) missing.push(heading);
		return `${line}\nSame as the \`${line}\` section of \`${docs.tool}\`'s description in the system prompt.`;
	});
	if (missing.length > 0) return { kind: "drift", reason: `native section(s) not found exactly once: ${missing.join(", ")}` };
	const body = index === undefined ? surface : `${surface}\n\n${index}`;
	return { kind: "ok", text: `<tool name="${docs.tool}" description="replaced">\n${body}\n</tool>` };
}

/** The delta body around the entries. */
export function renderDelta(entries: readonly string[]): string {
	return [
		"Descriptions of OMP's own tools from omp-config. Each <tool> element names one tool; its parameters stay as the system prompt declares them. " +
			"With description=\"replaced\", the element's text replaces that tool's description in the system prompt. " +
			"With description=\"kept\", the system prompt's description stands and the element's Topics list is appended to it. " +
			"A Topics list names call instructions kept out of the prompt, read on demand.",
		...entries,
	].join("\n\n");
}
