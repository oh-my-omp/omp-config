/**
 * Process-wide tool:// topic registration for extensions and external plugins.
 * Static-relative-import the installed extensions/_shared/tool-topics.ts through
 * OMP's extension loader so bundled host packages resolve correctly.
 * The router-held handler owns the only registry; the versioned capability below
 * joins registrations even when OMP loads separate copies of this module.
 *
 * Registrations are complete per-tool snapshots. The same owner may replace its
 * snapshot; another owner cannot. Descriptors are copied before publication.
 * Readers must be session-independent: registrations survive session shutdown,
 * extension disabling and reload until process exit. Restart to remove them.
 * No pi/context is retained, no hooks are registered, and bodies are not cached:
 * each leaf read/search calls its reader; indexes/completion use metadata only.
 * Callers own content lifetime and catch unexpected host errors at their boundary.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	SchemeSpec,
	UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls/types";

export interface ToolTopic {
	readonly name: string;
	readonly title: string;
	/** One line telling the caller when to read the topic; shown in indexes. Optional for older callers. */
	readonly when?: string;
	readonly read: () => string | Promise<string>;
}

export interface ToolTopicsRegistration {
	readonly tool: string;
	/** Stable plugin identity, not a session id or an authorization credential. */
	readonly owner: string;
	readonly topics: readonly ToolTopic[];
}

export type ToolTopicsRegistrationResult =
	| { readonly kind: "registered" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "conflict"; readonly reason: string };

/** One tool's registered topics without their bodies, as an index lists them. */
export interface RegisteredToolTopics {
	readonly tool: string;
	readonly owner: string;
	readonly topics: readonly Pick<ToolTopic, "name" | "title" | "when">[];
}

const REGISTRATION = Symbol.for("omp-config.tool-topics.registration.v1");
/** Lists registered topics' metadata, so an index can be shown for tools other owners registered. */
const INDEX = Symbol.for("omp-config.tool-topics.index.v1");
const NAME = /^[A-Za-z0-9_.-]+$/;
const nameSchema = z.string().refine((name) => NAME.test(name), "Expected [A-Za-z0-9_.-]+");
const textSchema = z.string().refine((text) => text.trim().length > 0, "Expected non-empty text");
const registrationSchema = z.object({
	tool: nameSchema,
	owner: textSchema,
	topics: z.array(z.object({ name: nameSchema, title: textSchema, when: textSchema.optional(), read: z.unknown() })).min(1),
});

// The callback's actual return value is checked by #body at the execution boundary.
function isTopicReader(value: unknown): value is ToolTopic["read"] {
	return typeof value === "function";
}

interface TopicsRegistry extends ProtocolHandler {
	readonly [REGISTRATION]: true;
	registerTopics(registration: ToolTopicsRegistration): ToolTopicsRegistrationResult;
}

function isTopicsRegistry(handler: ProtocolHandler): handler is TopicsRegistry {
	return (
		REGISTRATION in handler && handler[REGISTRATION] === true && "registerTopics" in handler && typeof handler.registerTopics === "function"
	);
}

interface TopicsIndex extends ProtocolHandler {
	readonly [INDEX]: true;
	topicIndex(): readonly RegisteredToolTopics[];
}

function isTopicsIndex(handler: ProtocolHandler): handler is TopicsIndex {
	return INDEX in handler && handler[INDEX] === true && "topicIndex" in handler && typeof handler.topicIndex === "function";
}

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

class ToolTopicsHandler implements TopicsRegistry, TopicsIndex {
	readonly scheme = "tool";
	readonly [REGISTRATION] = true;
	readonly [INDEX] = true;
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };
	readonly #tools = new Map<string, { readonly owner: string; readonly topics: ReadonlyMap<string, ToolTopic> }>();

	registerTopics(registration: ToolTopicsRegistration): ToolTopicsRegistrationResult {
		const parsed = registrationSchema.safeParse(registration);
		if (!parsed.success) return { kind: "invalid", reason: parsed.error.message };
		const input = parsed.data;
		const topics = new Map<string, ToolTopic>();
		for (const topic of input.topics) {
			if (!isTopicReader(topic.read) || topics.has(topic.name)) {
				return { kind: "invalid", reason: `Invalid reader or duplicate topic '${topic.name}' for ${input.tool}` };
			}
			topics.set(topic.name, { name: topic.name, title: topic.title, when: topic.when, read: topic.read });
		}
		const existing = this.#tools.get(input.tool);
		if (existing && existing.owner !== input.owner) {
			return { kind: "conflict", reason: `tool://${input.tool} belongs to '${existing.owner}', not '${input.owner}'` };
		}
		this.#tools.set(input.tool, { owner: input.owner, topics });
		return { kind: "registered" };
	}

	promptDoc(): string {
		return "`tool://<tool>/<topic>`: tool topics; `tool://` lists registered tools, `tool://<tool>` lists their topics. Line selectors apply.";
	}

	topicIndex(): readonly RegisteredToolTopics[] {
		return [...this.#tools].map(([tool, entry]) => ({
			tool,
			owner: entry.owner,
			topics: [...entry.topics.values()].map((topic) => ({ name: topic.name, title: topic.title, when: topic.when })),
		}));
	}

	#topics(tool: string): ReadonlyMap<string, ToolTopic> {
		const entry = this.#tools.get(tool);
		if (!entry) throw new Error(`Tool '${tool}' has no tool:// topics. Tools with topics: ${[...this.#tools.keys()].join(", ")}.`);
		return entry.topics;
	}

	#topic(tool: string, name: string): ToolTopic {
		const topics = this.#topics(tool);
		const topic = topics.get(name);
		if (!topic) throw new Error(`Unknown topic '${name}' for ${tool}. Available: ${[...topics.keys()].join(", ")}.`);
		return topic;
	}

	async #body(tool: string, topic: ToolTopic): Promise<string> {
		const content: unknown = await topic.read();
		if (typeof content !== "string") throw new Error(`tool://${tool}/${topic.name} reader must return a string`);
		return content;
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const { tool, topic } = target(url);
		if (!tool) {
			const rows = [...this.#tools.keys()].map((name) => `- [${name}](tool://${name})`);
			return markdown(url.href, ["# tool://", "", "Tools with topics:", "", ...rows, ""].join("\n"));
		}
		if (topic === undefined) {
			const rows = [...this.#topics(tool).values()].map(
				(entry) => `- [${entry.name}](tool://${tool}/${entry.name}) — ${entry.title}${entry.when ? `. Read when: ${entry.when}` : ""}`,
			);
			return markdown(
				url.href,
				[`# ${tool} topics`, "", `Read tool://${tool}/<topic> (line selectors apply).`, "", ...rows, ""].join("\n"),
			);
		}
		return markdown(url.href, await this.#body(tool, this.#topic(tool, topic)));
	}

	async enumerate(url: InternalUrl): Promise<Array<{ url: string; content: string }>> {
		const { tool, topic } = target(url);
		const leaves: Array<{ url: string; content: string }> = [];
		const names = tool ? [tool] : this.#tools.keys();
		for (const name of names) {
			const topics = topic === undefined ? this.#topics(name).values() : [this.#topic(name, topic)];
			for (const entry of topics) leaves.push({ url: `tool://${name}/${entry.name}`, content: await this.#body(name, entry) });
		}
		return leaves;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		for (const [tool, entry] of this.#tools) {
			completions.push({ value: tool });
			for (const topic of entry.topics.values())
				completions.push({ value: `${tool}/${topic.name}`, description: topic.when ?? topic.title });
		}
		return completions;
	}
}

/**
 * Publish a tool's topic snapshot through the shared tool:// handler. Names are
 * case-sensitive ASCII [A-Za-z0-9_.-]+. Expected invalid-input/ownership failures
 * are explicit results; unexpected host errors throw to the extension boundary.
 */
export function registerToolTopics(registration: ToolTopicsRegistration): ToolTopicsRegistrationResult {
	const router = InternalUrlRouter.instance();
	if (router.isBuiltin("tool")) return { kind: "conflict", reason: "OMP owns tool://; shared topics cannot replace it" };
	const existing = router.getHandler("tool");
	if (existing) {
		if (!isTopicsRegistry(existing)) return { kind: "conflict", reason: "tool:// belongs to another host or an incompatible topics API" };
		return existing.registerTopics(registration);
	}
	const handler = new ToolTopicsHandler();
	const result = handler.registerTopics(registration);
	if (result.kind === "registered") router.register(handler);
	return result;
}

/**
 * Every tool's registered topics now, metadata only (no bodies): what an index shows. Empty when no
 * registry is on the router, or when the registry is an older copy without the index capability.
 */
export function registeredToolTopics(): readonly RegisteredToolTopics[] {
	const handler = InternalUrlRouter.instance().getHandler("tool");
	return handler && isTopicsIndex(handler) ? handler.topicIndex() : [];
}
