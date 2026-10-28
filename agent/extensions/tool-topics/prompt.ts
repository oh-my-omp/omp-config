// Structural rewrite of one tool's description inside OMP's rendered system prompt, keyed by
// tool name rather than by OMP's wording. Two layouts are recognized:
//   inline tools  — `// `-prefixed description lines right above `type <tool> = …` inside
//                   `namespace functions { … }` (pi-ai dialect/inventory.ts renderToolInventory);
//   xd:// devices — `## <tool>[ — <label>]`, blank, description, blank, `### Schema`
//                   (pi-coding-agent tools/xdev.ts renderDocs with the "##" heading).
import type { ToolDocs, Topic } from "./catalog.ts";

export type Composed = { readonly kind: "ok"; readonly text: string } | { readonly kind: "drift"; readonly reason: string };

export type Rewrite =
	| { readonly kind: "rewritten"; readonly blocks: string[] }
	| { readonly kind: "absent" }
	| { readonly kind: "drift"; readonly reason: string };

const HEADING = /^(#{1,6}) (.+)$/;
const NATIVE = /\{\{native:([^}]+)\}\}/g;

/** The native `# Heading` section (heading line included), when it occurs exactly once. */
function nativeSection(native: string, heading: string): string | undefined {
	const lines = native.split("\n");
	const hits = lines.flatMap((line, index) => {
		const match = HEADING.exec(line);
		return match?.[1] && match[2] === heading ? [{ index, level: match[1].length }] : [];
	});
	const [hit] = hits;
	if (hits.length !== 1 || hit === undefined) return undefined;
	const end = lines.findIndex((line, index) => index > hit.index && (HEADING.exec(line)?.[1]?.length ?? 7) <= hit.level);
	return lines
		.slice(hit.index, end < 0 ? lines.length : end)
		.join("\n")
		.trimEnd();
}

/** Index lines for the description: each topic's name and when to read it, as registered for tool://. */
export function renderIndex(tool: string, topics: readonly Pick<Topic, "name" | "when">[]): string {
	return [
		`Topics — before a call that needs one, read \`tool://${tool}/<topic>\`:`,
		...topics.map((topic) => `- \`${topic.name}\`: ${topic.when}`),
	].join("\n");
}

/** Surface (with `{{native:<Heading>}}` sections spliced in) or the native text, then the index. */
export function composeDescription(native: string, docs: ToolDocs, index: string | undefined): Composed {
	let base = native.trim();
	if (docs.surface !== undefined) {
		const missing: string[] = [];
		base = docs.surface.replace(NATIVE, (_whole, heading: string) => {
			const section = nativeSection(native, heading);
			if (section === undefined) missing.push(heading);
			return section ?? "";
		});
		if (missing.length > 0) return { kind: "drift", reason: `native section(s) not found exactly once: ${missing.join(", ")}` };
	}
	return { kind: "ok", text: index === undefined ? base : `${base}\n\n${index}` };
}

function rewriteInline(lines: string[], tool: string, compose: (native: string) => Composed): Rewrite {
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
	const composed = compose(native);
	if (composed.kind === "drift") return composed;
	const commented = composed.text.split("\n").map((line) => (line ? `// ${line}` : "//"));
	return { kind: "rewritten", blocks: [...lines.slice(0, start), ...commented, ...lines.slice(signature)] };
}

function rewriteDevice(lines: string[], tool: string, compose: (native: string) => Composed): Rewrite {
	const heading = lines.findIndex((line) => line === `## ${tool}` || line.startsWith(`## ${tool} — `));
	if (heading < 0) return { kind: "absent" };
	const schema = lines.findIndex((line, index) => index > heading && line === "### Schema");
	const nextDevice = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
	if (schema < 0 || (nextDevice >= 0 && nextDevice < schema) || lines[heading + 1] !== "" || lines[schema - 1] !== "") {
		return { kind: "drift", reason: "xd:// device section no longer has the heading/blank/description/blank/### Schema layout" };
	}
	const composed = compose(lines.slice(heading + 2, schema - 1).join("\n"));
	if (composed.kind === "drift") return composed;
	return { kind: "rewritten", blocks: [...lines.slice(0, heading + 2), ...composed.text.split("\n"), ...lines.slice(schema - 1)] };
}

/** Rewrite `tool`'s description in the first prompt block that renders it. */
export function rewriteTool(blocks: readonly string[], tool: string, compose: (native: string) => Composed): Rewrite {
	for (const [index, block] of blocks.entries()) {
		const lines = block.split("\n");
		for (const layout of [rewriteInline, rewriteDevice]) {
			const result = layout(lines, tool, compose);
			if (result.kind === "absent") continue;
			if (result.kind === "drift") return result;
			const next = [...blocks];
			next[index] = result.blocks.join("\n");
			return { kind: "rewritten", blocks: next };
		}
	}
	return { kind: "absent" };
}
