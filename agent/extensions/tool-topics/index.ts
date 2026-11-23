import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { loadCatalog, type ToolDocs } from "./catalog.ts";
import { installToolTopicInjection } from "./injection.ts";
import { indexPrompt, type Rewrite, toolLines } from "./prompt.ts";
import { publishTopics, type Warn } from "./registry.ts";

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

interface Covered {
	readonly docs: readonly ToolDocs[];
	readonly names: readonly string[];
	readonly known: ReadonlySet<string>;
}

function fileRegistered(pi: ExtensionAPI, known: ReadonlySet<string>): ReadonlySet<string> {
	const foreign = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if (known.has(tool.name) && !tool.sourceInfo.path.startsWith("<")) foreign.add(tool.name);
	}
	return foreign;
}

function rewritePrompt(pi: ExtensionAPI, ctx: ExtensionContext, systemPrompt: readonly string[], covered: Covered): string[] | undefined {
	const active = pi.getActiveTools();
	if (!active.includes("read")) return undefined;
	const prompt = indexPrompt(systemPrompt, covered.names);
	const foreign = fileRegistered(pi, covered.known);
	const rewrites: Rewrite[] = [];
	for (const docs of covered.docs) {
		if (foreign.has(docs.tool)) continue;
		const rendered = prompt.description(docs.tool);
		switch (rendered.kind) {
			case "found": {
				const entry = toolLines(rendered.description, docs);
				if (entry?.kind === "ok") rewrites.push({ description: rendered.description, lines: entry.lines });
				else if (entry?.kind === "drift") report(pi, ctx, docs.tool, entry.reason);
				break;
			}
			case "catalog":
				break;
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
	return rewrites.length === 0 ? undefined : prompt.rewrite(rewrites);
}

export default function toolTopics(pi: ExtensionAPI): void {
	const warn: Warn = (message, error) => pi.logger.warn(`tool-topics: ${message}`, { error: errorText(error) });
	let docsList: ToolDocs[];
	try {
		const catalog = loadCatalog(import.meta.dir);
		for (const problem of catalog.problems) pi.logger.warn(`tool-topics: skipped ${problem}`);
		docsList = [...catalog.tools.values()];
		publishTopics(docsList, () => pi.getAllTools().map((tool) => tool.name), warn);
	} catch (error) {
		warn("loading failed", error);
		return;
	}
	const names = docsList.map((docs) => docs.tool);
	const covered: Covered = { docs: docsList, names, known: new Set(names) };

	installToolTopicInjection(
		pi,
		docsList.flatMap((docs) =>
			docs.topics.flatMap((topic) =>
				topic.inject.map((rule) => ({ id: rule.id, tool: rule.tool, topic: `help://${docs.tool}/${topic.name}`, match: rule.match })),
			),
		),
	);

	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			const systemPrompt = rewritePrompt(pi, ctx, event.systemPrompt, covered);
			return systemPrompt === undefined ? undefined : { systemPrompt };
		} catch (error) {
			warn("cannot rewrite tool descriptions", error);
		}
	});
}
