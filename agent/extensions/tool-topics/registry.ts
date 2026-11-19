// The `tool://` scheme on OMP's URL router: omp-config's topics for tools it does not own, built once
// from the catalog. Nothing else registers here; plugin tools serve their own topics as `xd://<tool>/<topic>`.
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	SchemeSpec,
	UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { type RegisterSchemeResult, registerInternalScheme } from "../_shared/omomp-shared/internal-url.ts";
import type { Topic } from "./catalog.ts";

function target(url: InternalUrl): { readonly tool: string; readonly topic: string | undefined } {
	const tool = url.rawHost || url.hostname;
	const segments = (url.rawPathname ?? url.pathname).split("/").filter((segment) => segment.length > 0);
	if (segments.length > 1 || (!tool && segments.length > 0) || url.search || url.hash) {
		throw new Error(`Invalid tool:// URL: ${url.href}. Use tool://<tool> or tool://<tool>/<topic>.`);
	}
	return { tool, topic: segments[0] };
}

function markdown(url: string, content: string): InternalResource {
	return { url, content, contentType: "text/markdown", size: Buffer.byteLength(content) };
}

/** The owner id the shared scheme registrar brands this extension's handler with, so a later load of any copy replaces it. */
const OWNER = "omp-config/tool-topics";

class ToolTopicsHandler implements ProtocolHandler {
	readonly scheme = "tool";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };
	readonly #tools: ReadonlyMap<string, ReadonlyMap<string, Topic>>;

	constructor(tools: ReadonlyMap<string, ReadonlyMap<string, Topic>>) {
		this.#tools = tools;
	}

	promptDoc(): string {
		return "`tool://<tool>/<topic>`: tool topics; `tool://` lists tools with topics, `tool://<tool>` lists their topics. Line selectors apply.";
	}

	#topics(tool: string): ReadonlyMap<string, Topic> {
		const topics = this.#tools.get(tool);
		if (!topics) throw new Error(`Tool '${tool}' has no tool:// topics. Tools with topics: ${[...this.#tools.keys()].join(", ")}.`);
		return topics;
	}

	#topic(tool: string, name: string): Topic {
		const topics = this.#topics(tool);
		const topic = topics.get(name);
		if (!topic) throw new Error(`Unknown topic '${name}' for ${tool}. Available: ${[...topics.keys()].join(", ")}.`);
		return topic;
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const { tool, topic } = target(url);
		if (!tool) {
			const rows = [...this.#tools.keys()].map((name) => `- [${name}](tool://${name})`);
			return markdown(url.href, ["# tool://", "", "Tools with topics:", "", ...rows, ""].join("\n"));
		}
		if (topic === undefined) {
			const rows = [...this.#topics(tool).values()].map(
				(entry) => `- [${entry.name}](tool://${tool}/${entry.name}) — ${entry.title}. Read when: ${entry.when}`,
			);
			return markdown(
				url.href,
				[`# ${tool} topics`, "", `Read tool://${tool}/<topic> (line selectors apply).`, "", ...rows, ""].join("\n"),
			);
		}
		return markdown(url.href, this.#topic(tool, topic).body);
	}

	async enumerate(url: InternalUrl): Promise<Array<{ url: string; content: string }>> {
		const { tool, topic } = target(url);
		const leaves: Array<{ url: string; content: string }> = [];
		const names = tool ? [tool] : this.#tools.keys();
		for (const name of names) {
			const topics = topic === undefined ? this.#topics(name).values() : [this.#topic(name, topic)];
			for (const entry of topics) leaves.push({ url: `tool://${name}/${entry.name}`, content: entry.body });
		}
		return leaves;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		for (const [tool, topics] of this.#tools) {
			completions.push({ value: tool });
			for (const topic of topics.values()) completions.push({ value: `${tool}/${topic.name}`, description: topic.when });
		}
		return completions;
	}
}

/**
 * Put the topics on the router as `tool://`. `registered` covers a fresh registration and replacing a
 * handler an earlier load of this extension (or of another copy) registered under the same owner;
 * `builtin` and `held` report why the router was left alone. The shared registrar also puts every
 * non-built-in scheme in name order behind the built-ins.
 */
export function publishTopics(tools: ReadonlyMap<string, readonly Topic[]>): RegisterSchemeResult {
	const byTool = new Map<string, ReadonlyMap<string, Topic>>();
	for (const [tool, topics] of tools) byTool.set(tool, new Map(topics.map((topic) => [topic.name, topic])));
	return registerInternalScheme(InternalUrlRouter.instance(), OWNER, new ToolTopicsHandler(byTool));
}
