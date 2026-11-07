// tool-topics — progressive instructions for tools omp-config does not own (OMP's built-in tools):
// a short surface plus a topic index per tool, delivered as a delta message beside OMP's system
// prompt, which keeps the native descriptions, with the detailed call instructions served on
// demand as tool://<tool>/<topic>. Tools a plugin or another extension registers serve their own
// topics as xd://<tool>/<topic> through `docTopics()` and list them in their own description;
// this extension neither indexes nor describes them, including a plugin tool that replaces a
// built-in under the same name (OMP reports a filesystem source path for it).
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
// handler of an earlier load (subagents, isolated children). Afterwards all non-builtin schemes
// in the router are in canonical order (builtins first, others by name), independent of when
// this extension bound. When OMP or another handler holds `tool://`, no tool gets an index and
// injection is off, so nothing points at or injects topics this extension does not serve.
//
// PROMPT. At every prompt (`before_agent_start`, from the prompt it is handed) and after every
// tool call (`tool_result`, from `ctx.getSystemPrompt()`), main and sub, full and light: when the
// session has `read`, every OMP-owned tool with authored docs whose description the system prompt
// renders gets a `<tool>` element — its surface replacing that description (`description="replaced"`)
// or none (`"kept"`), then its index. `{{native:<Heading>}}` in a surface becomes a reference to
// that `# Heading` section of the rendered description, for content OMP generates per session
// (task's agent list). The elements form one delta of `_shared/context-delta.ts` with source
// `omp-config/tool-topics`, sent only when it differs from the source's effective delta in the
// current context; a session without `read` gets none, or a retraction of an earlier one, since
// it could not read the topics. The system prompt is only read: prompt.ts finds each tool by name
// in OMP's rendered layout, not by wording. A revive's `before_agent_start` is skipped, because
// OMP discards its result.
//
// FAILURE. A malformed or unreadable file — including a bad `inject` entry or a duplicate id — is
// skipped with one warning each; the rest still load. An active tool whose description cannot be
// found, or whose `{{native:…}}` section is missing, is left out of the delta, with a log warning
// and one main-session notice per tool and reason. Hooks never throw into omp.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../_shared/context-delta.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { type Catalog, loadCatalog, type ToolDocs } from "./catalog.ts";
import { installToolTopicInjection } from "./injection.ts";
import { indexPrompt, renderDelta, toolEntry } from "./prompt.ts";
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

/**
 * The catalog's tools as the delta sees them: each tool's docs, the names the prompt index answers
 * for, and the same names for membership while scanning the registry.
 */
interface Covered {
	readonly docs: readonly ToolDocs[];
	readonly names: readonly string[];
	readonly known: ReadonlySet<string>;
}

/**
 * Tools among `covered.known` that an extension or plugin file registered: OMP reports a filesystem
 * source path for them, `<origin:name>` otherwise. OMP offers no signal for a registry change, so
 * this is built per call in one pass over the registry, holding only the covered matches.
 */
function fileRegistered(pi: ExtensionAPI, known: ReadonlySet<string>): ReadonlySet<string> {
	const foreign = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if (known.has(tool.name) && !tool.sourceInfo.path.startsWith("<")) foreign.add(tool.name);
	}
	return foreign;
}

/** The `<tool>` elements for every covered tool `systemPrompt` renders, as one delta. */
function toolsDelta(pi: ExtensionAPI, ctx: ExtensionContext, systemPrompt: readonly string[], covered: Covered, indexed: boolean): Delta {
	const active = pi.getActiveTools();
	if (!active.includes("read")) return { kind: "none" };
	const prompt = indexPrompt(systemPrompt, covered.names);
	const foreign = fileRegistered(pi, covered.known);
	const entries: string[] = [];
	for (const docs of covered.docs) {
		if (foreign.has(docs.tool)) continue;
		const rendered = prompt.description(docs.tool);
		switch (rendered.kind) {
			case "found": {
				const entry = toolEntry(rendered.description, docs, indexed);
				if (entry?.kind === "ok") entries.push(entry.text);
				else if (entry?.kind === "drift") report(pi, ctx, docs.tool, entry.reason);
				break;
			}
			case "drift":
				report(pi, ctx, docs.tool, rendered.reason);
				break;
			case "absent":
				if (active.includes(docs.tool)) report(pi, ctx, docs.tool, "its description was not found in the rendered prompt");
				break;
			default: {
				const unreachable: never = rendered;
				return unreachable;
			}
		}
	}
	return entries.length === 0 ? { kind: "none" } : { kind: "text", body: renderDelta(entries) };
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
	const names = docsList.map((docs) => docs.tool);
	const covered: Covered = { docs: docsList, names, known: new Set(names) };

	// Inject only when this extension serves tool://; another handler's topics must not go out under our marker.
	if (indexed) {
		installToolTopicInjection(pi, {
			owner: "omp-config/tool-topic-injection",
			rules: docsList.flatMap((docs) =>
				docs.topics.flatMap((topic) => topic.inject.map((rule) => ({ ...rule, topic: `tool://${docs.tool}/${topic.name}` }))),
			),
		});
	}

	const deltas = createDeltaStream(pi, "tool-topics");
	pi.on("before_agent_start", (event, ctx) => {
		// OMP discards the result of a revive.
		if (event.reason === "revive") return;
		try {
			return deltas.atPrompt(ctx, toolsDelta(pi, ctx, event.systemPrompt, covered, indexed));
		} catch (error) {
			pi.logger.warn("tool-topics: cannot deliver tool descriptions", { error: errorText(error) });
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			return deltas.afterTools(ctx, toolsDelta(pi, ctx, ctx.getSystemPrompt(), covered, indexed));
		} catch (error) {
			pi.logger.warn("tool-topics: cannot deliver tool descriptions", { error: errorText(error) });
		}
	});
}
