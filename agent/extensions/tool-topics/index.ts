// tool-topics — progressive tool instructions: a short surface plus a topic index in each tool's
// description, with the detailed call instructions served on demand as tool://<tool>/<topic>.
//
// FILES. Authored beside this module (repo-managed): `TOPIC-*.md` (header: tool, name, title,
// when, upstream) and `SURFACE-*.md` (header: tool, upstream). Loaded once at factory time;
// edits apply on the next omp start. `upstream` names the OMP version and sources the text was
// checked against; after an OMP upgrade, re-check each tool against them.
//
// REGISTRATION. Each tool's topics are published through _shared/tool-topics.ts under owner
// `omp-config/tool-topics`. A tool whose registration fails gets no index, so an index never
// points at missing topics.
//
// PROMPT. On every `before_agent_start` (main and sub, full and light), when the session has
// `read`, each tool with authored docs that the prompt renders gets its description replaced by
// its surface (or kept native when it has none) followed by its index. `{{native:<Heading>}}` in
// a surface splices that native `# Heading` section, for content OMP generates per session
// (task's agent list). Sessions without `read` keep the native descriptions: they could not
// read the topics. The tool is located by name in OMP's rendered layout (prompt.ts), not by
// wording; when a rendered tool cannot be rewritten (layout change, missing native section),
// its native description stays and a warning is logged, and shown once in the main session.
//
// FAILURE. Bad files are skipped with one warning each. Hooks never throw into omp.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { registerToolTopics } from "../_shared/tool-topics.ts";
import { type Catalog, loadCatalog, type ToolDocs } from "./catalog.ts";
import { composeDescription, renderIndex, rewriteTool } from "./prompt.ts";

const OWNER = "omp-config/tool-topics";

/** Drift already reported, per tool and reason, for the life of the process. */
const reported = new Set<string>();

function report(pi: ExtensionAPI, ctx: ExtensionContext, tool: string, reason: string): void {
	const key = `${tool}\u0000${reason}`;
	if (reported.has(key)) return;
	reported.add(key);
	pi.logger.warn(`tool-topics: ${tool} keeps its native description: ${reason}`);
	if (ctx.agent.kind !== "main") return;
	const notice = tr(
		`tool-topics: ${tool} keeps its native description (${reason}); update its SURFACE/TOPIC files`,
		`tool-topics：${tool} 保留原生说明（${reason}）；请更新它的 SURFACE/TOPIC 文件`,
	);
	if (ctx.hasUI) ctx.ui.notify(notice, "warning");
	else process.stderr.write(`${notice}\n`);
}

/** Register every tool's topics; returns the tools whose index may be shown. */
function registerAll(pi: ExtensionAPI, catalog: Catalog): ReadonlySet<string> {
	const indexed = new Set<string>();
	for (const docs of catalog.tools.values()) {
		if (docs.topics.length === 0) continue;
		const result = registerToolTopics({
			tool: docs.tool,
			owner: OWNER,
			topics: docs.topics.map((topic) => ({ name: topic.name, title: topic.title, when: topic.when, read: () => topic.body })),
		});
		switch (result.kind) {
			case "registered":
				indexed.add(docs.tool);
				break;
			case "invalid":
			case "conflict":
				pi.logger.warn(`tool-topics: ${docs.tool} topics not registered`, { reason: result.reason });
				break;
			default: {
				const unreachable: never = result;
				throw new Error(`Unhandled registration result: ${unreachable}`);
			}
		}
	}
	return indexed;
}

function rewritePrompt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	blocks: string[],
	docsList: readonly ToolDocs[],
	indexed: ReadonlySet<string>,
) {
	let current = blocks;
	let changed = false;
	for (const docs of docsList) {
		const index = indexed.has(docs.tool) ? renderIndex(docs.tool, docs.topics) : undefined;
		if (docs.surface === undefined && index === undefined) continue;
		const result = rewriteTool(current, docs.tool, (native) => composeDescription(native, docs, index));
		switch (result.kind) {
			case "rewritten":
				current = result.blocks;
				changed = true;
				break;
			case "drift":
				report(pi, ctx, docs.tool, result.reason);
				break;
			case "absent":
				if (pi.getActiveTools().includes(docs.tool)) report(pi, ctx, docs.tool, "its description was not found in the rendered prompt");
				break;
			default: {
				const unreachable: never = result;
				return unreachable;
			}
		}
	}
	return changed ? current : undefined;
}

export default function toolTopics(pi: ExtensionAPI): void {
	let catalog: Catalog;
	let indexed: ReadonlySet<string>;
	try {
		catalog = loadCatalog(import.meta.dir);
		for (const problem of catalog.problems) pi.logger.warn(`tool-topics: skipped ${problem}`);
		indexed = registerAll(pi, catalog);
	} catch (error) {
		pi.logger.warn("tool-topics: loading failed", { error: errorText(error) });
		return;
	}
	const docsList = [...catalog.tools.values()];

	pi.on("before_agent_start", (event, ctx) => {
		try {
			if (!pi.getActiveTools().includes("read")) return;
			const systemPrompt = rewritePrompt(pi, ctx, event.systemPrompt, docsList, indexed);
			if (systemPrompt) return { systemPrompt };
		} catch (error) {
			pi.logger.warn("tool-topics: before_agent_start failed", { error: errorText(error) });
		}
	});
}
