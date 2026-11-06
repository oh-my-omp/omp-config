// tool-topics — progressive instructions for tools omp-config does not own (OMP's built-in tools):
// a short surface plus a topic index in each tool's description, with the detailed call
// instructions served on demand as tool://<tool>/<topic>. Tools a plugin or another extension
// registers serve their own topics as xd://<tool>/<topic> through `docTopics()` and list them in
// their own description; this extension neither indexes nor rewrites them, including a plugin
// tool that replaces a built-in under the same name (OMP reports a filesystem source path for it).
//
// FILES. Authored beside this module (repo-managed): `TOPIC-*.md` (header: tool, name, title,
// when, upstream, optional inject) and `SURFACE-*.md` (header: tool, upstream). Loaded once at factory time;
// edits apply on the next omp start. `upstream` names the OMP version and sources the text was
// checked against; after an OMP upgrade, re-check each tool against them.
//
// INJECTION. A TOPIC header may list `inject` entries `{id, tool, parameter, pattern}`: after a
// `tool_result` whose named string argument (dotted paths allowed) matches the pattern, the file's
// own `tool://<tool>/<name>` is delivered once per actual context as trusted additionalContext
// (main and sub sessions, failed results included). Delivery identity is
// `omp-config/tool-topic-injection` + entry id; ids are unique across the catalog and stay stable
// while a rule is the same rule, so a session's already-delivered markers still dedup. Installed
// only when this extension holds `tool://`: another handler's topics must not be injected under
// its marker.
//
// ROUTING. registry.ts puts the topics on OMP's URL router as the `tool://` scheme, replacing the
// handler of an earlier load (subagents, isolated children). When OMP or another handler holds
// `tool://`, no tool gets an index and injection is off, so nothing points at or injects topics
// this extension does not serve.
//
// PROMPT. On every `before_agent_start` (main and sub, full and light), when the session has
// `read`, each tool with authored docs that the prompt renders gets its description replaced by
// its surface (or kept native when it has none) followed by its index. `{{native:<Heading>}}` in
// a surface splices that native `# Heading` section, for content OMP generates per session
// (task's agent list). Sessions without `read` keep the native descriptions: they could not read
// the topics. The tool is located by name in OMP's rendered layout (prompt.ts), not by wording;
// when a rendered tool cannot be rewritten (layout change, missing native section), its native
// description stays and a warning is logged, and shown once in the main session.
//
// FAILURE. A malformed or unreadable file — including a bad `inject` entry or a duplicate id — is
// skipped with one warning each; the rest still load. Hooks never throw into omp.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { type Catalog, loadCatalog, type ToolDocs } from "./catalog.ts";
import { installToolTopicInjection } from "./injection.ts";
import { composeDescription, renderIndex, rewriteTool } from "./prompt.ts";
import { publishTopics } from "./registry.ts";

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

/** Publish every tool's topics as `tool://`; true when the index may be shown. */
function publish(pi: ExtensionAPI, catalog: Catalog): boolean {
	const topics = new Map([...catalog.tools.values()].filter((docs) => docs.topics.length > 0).map((docs) => [docs.tool, docs.topics]));
	const result = publishTopics(topics);
	switch (result.kind) {
		case "published":
			return true;
		case "taken":
			pi.logger.warn("tool-topics: topics not published", { reason: result.reason });
			return false;
		default: {
			const unreachable: never = result;
			throw new Error(`Unhandled publish result: ${unreachable}`);
		}
	}
}

/** Tools registered from an extension or plugin file: OMP reports a filesystem source path for them, `<origin:name>` otherwise. */
function fileRegistered(pi: ExtensionAPI): ReadonlySet<string> {
	return new Set(
		pi
			.getAllTools()
			.filter((tool) => !tool.sourceInfo.path.startsWith("<"))
			.map((tool) => tool.name),
	);
}

function rewritePrompt(pi: ExtensionAPI, ctx: ExtensionContext, blocks: string[], docsList: readonly ToolDocs[], indexed: boolean) {
	let current = blocks;
	let changed = false;
	const foreign = fileRegistered(pi);
	for (const docs of docsList) {
		if (foreign.has(docs.tool)) continue;
		const index = indexed && docs.topics.length > 0 ? renderIndex(docs.tool, docs.topics) : undefined;
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
	let indexed: boolean;
	try {
		catalog = loadCatalog(import.meta.dir);
		for (const problem of catalog.problems) pi.logger.warn(`tool-topics: skipped ${problem}`);
		indexed = publish(pi, catalog);
	} catch (error) {
		pi.logger.warn("tool-topics: loading failed", { error: errorText(error) });
		return;
	}
	const docsList = [...catalog.tools.values()];

	// Inject only when this extension serves tool://; another handler's topics must not go out under our marker.
	if (indexed) {
		installToolTopicInjection(pi, {
			owner: "omp-config/tool-topic-injection",
			rules: docsList.flatMap((docs) =>
				docs.topics.flatMap((topic) => topic.inject.map((rule) => ({ ...rule, topic: `tool://${docs.tool}/${topic.name}` }))),
			),
		});
	}

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
