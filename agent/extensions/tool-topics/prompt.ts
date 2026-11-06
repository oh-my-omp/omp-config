// The tool-topics delta: what this extension adds to OMP's own tool descriptions, built from the
// descriptions as OMP rendered them into its system prompt, which is only read. A tool counts as
// rendered when its description is found by tool name, not wording, in one of two layouts:
//   inline tools  — `// `-prefixed description lines right above `type <tool> = …` inside
//                   `namespace functions { … }` (pi-ai dialect/inventory.ts renderToolInventory);
//   xd:// devices — `## <tool>[ — <label>]`, blank, description, blank, `### Schema`
//                   (pi-coding-agent tools/xdev.ts renderDocs with the "##" heading).
import type { ToolDocs, Topic } from "./catalog.ts";

/** One tool's part of the delta, or why it cannot be written against the rendered description. */
export type Entry = { readonly kind: "ok"; readonly text: string } | { readonly kind: "drift"; readonly reason: string };

/** A tool's description in the rendered prompt. */
export type Rendered =
	| { readonly kind: "found"; readonly native: string }
	| { readonly kind: "absent" }
	| { readonly kind: "drift"; readonly reason: string };

const HEADING = /^(#{1,6}) (.+)$/;
const NATIVE = /\{\{native:([^}]+)\}\}/g;

/** The rendered prompt, block by block, as lines. */
export function promptLines(blocks: readonly string[]): readonly (readonly string[])[] {
	return blocks.map((block) => block.split("\n"));
}

/** The native `# Heading` line, when that heading occurs exactly once. */
function nativeHeading(native: string, heading: string): string | undefined {
	const hits = native.split("\n").filter((line) => HEADING.exec(line)?.[2] === heading);
	return hits.length === 1 ? hits[0] : undefined;
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
export function toolEntry(native: string, docs: ToolDocs, indexed: boolean): Entry | undefined {
	const index = indexed && docs.topics.length > 0 ? renderIndex(docs.tool, docs.topics) : undefined;
	if (docs.surface === undefined) {
		return index === undefined ? undefined : { kind: "ok", text: `<tool name="${docs.tool}" description="kept">\n${index}\n</tool>` };
	}
	const missing: string[] = [];
	const surface = docs.surface.replace(NATIVE, (_whole, heading: string) => {
		const line = nativeHeading(native, heading);
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

function inlineDescription(lines: readonly string[], tool: string): Rendered {
	const open = lines.indexOf("namespace functions {");
	const close = lines.indexOf("} // namespace functions");
	if (open < 0 || close < open) return { kind: "absent" };
	const signature = lines.findIndex((line, index) => index > open && index < close && line.startsWith(`type ${tool} = `));
	if (signature < 0) return { kind: "absent" };
	let start = signature;
	while (start - 1 > open && lines[start - 1]?.startsWith("//")) start--;
	const native = lines
		.slice(start, signature)
		.map((line) => (line.startsWith("// ") ? line.slice(3) : line.slice(2)))
		.join("\n");
	return { kind: "found", native };
}

function deviceDescription(lines: readonly string[], tool: string): Rendered {
	const heading = lines.findIndex((line) => line === `## ${tool}` || line.startsWith(`## ${tool} — `));
	if (heading < 0) return { kind: "absent" };
	const schema = lines.findIndex((line, index) => index > heading && line === "### Schema");
	const nextDevice = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
	if (schema < 0 || (nextDevice >= 0 && nextDevice < schema) || lines[heading + 1] !== "" || lines[schema - 1] !== "") {
		return { kind: "drift", reason: "xd:// device section no longer has the heading/blank/description/blank/### Schema layout" };
	}
	return { kind: "found", native: lines.slice(heading + 2, schema - 1).join("\n") };
}

/** `tool`'s description in the first prompt block that renders it. */
export function renderedDescription(prompt: readonly (readonly string[])[], tool: string): Rendered {
	for (const lines of prompt) {
		for (const layout of [inlineDescription, deviceDescription]) {
			const result = layout(lines, tool);
			if (result.kind !== "absent") return result;
		}
	}
	return { kind: "absent" };
}
