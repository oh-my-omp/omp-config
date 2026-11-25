import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
	parseInternalUrl,
	type ResolveContext,
	type UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { listToolTopics, registerToolTopics, resolveToolTopic, type ToolTopicDoc } from "../_shared/omomp-shared/internal-url.ts";
import type { ToolDocs } from "./catalog.ts";

const OWNER = "omp-config/tool-topics";
const HELP_WRAPPER_BASE: unique symbol = Symbol.for("omp-config/help-wrapper-base");

type HelpWrapper = ProtocolHandler & { readonly [HELP_WRAPPER_BASE]: ProtocolHandler };

export type Warn = (message: string, error: unknown) => void;

interface Scope {
	readonly base: ProtocolHandler;
	readonly context: ResolveContext | undefined;
	readonly warn: Warn;
}

interface Listing {
	readonly tool: string;
	readonly hub: readonly ToolTopicDoc[];
	readonly native: readonly string[];
}

function isHelpWrapper(handler: ProtocolHandler): handler is HelpWrapper {
	return Object.hasOwn(handler, HELP_WRAPPER_BASE);
}

function parseHelpTarget(url: InternalUrl): { readonly tool: string; readonly topic: string | undefined } {
	const tool = url.rawHost || url.hostname;
	const segments = (url.rawPathname ?? url.pathname).split("/").filter((segment) => segment.length > 0);
	if (segments.length > 1 || (!tool && segments.length > 0) || url.search || url.hash) {
		throw new ToolError(`Invalid help:// URL: ${url.href}. Use help://, help://<tool>, or help://<tool>/<topic>.`);
	}
	return { tool, topic: segments[0] };
}

function markdown(url: string, content: string): InternalResource {
	return { url, content, contentType: "text/markdown", size: Buffer.byteLength(content, "utf-8") };
}

function hubTopics(tool?: string): ToolTopicDoc[] {
	return listToolTopics(tool, { includeHidden: true });
}

async function nativeTopics(scope: Scope, tool: string): Promise<string[]> {
	if (scope.context?.session === undefined) return [];
	try {
		const listing = await scope.base.resolve(parseInternalUrl(`help://${tool}`), scope.context);
		if (typeof listing.content !== "string") return [];
		const prefix = `help://${tool}/`;
		return listing.content.split("\n").flatMap((line) => (line.startsWith(prefix) ? [line.slice(prefix.length)] : []));
	} catch (error) {
		if (!(error instanceof ToolError)) scope.warn(`cannot list native help://${tool}`, error);
		return [];
	}
}

async function listing(scope: Scope, tool: string, hub: readonly ToolTopicDoc[]): Promise<Listing> {
	const hubNames = new Set(hub.map((doc) => doc.topic));
	const native = (await nativeTopics(scope, tool)).filter((topic) => !hubNames.has(topic));
	return { tool, hub, native };
}

async function allListings(scope: Scope, toolNames: () => readonly string[]): Promise<Listing[]> {
	const hubByTool = new Map<string, ToolTopicDoc[]>();
	for (const doc of hubTopics()) {
		const docs = hubByTool.get(doc.tool);
		if (docs === undefined) hubByTool.set(doc.tool, [doc]);
		else docs.push(doc);
	}
	const tools = [...new Set([...hubByTool.keys(), ...toolNames()])].sort();
	const listings = await Promise.all(tools.map((tool) => listing(scope, tool, hubByTool.get(tool) ?? [])));
	return listings.filter((entry) => entry.hub.length + entry.native.length > 0);
}

async function nativeTopic(scope: Scope, tool: string, topic: string): Promise<string | undefined> {
	if (scope.context?.session === undefined) return undefined;
	const resource = await scope.base.resolve(parseInternalUrl(`help://${tool}/${topic}`), scope.context);
	return typeof resource.content === "string" ? resource.content : undefined;
}

async function resolveUnregistered(
	scope: Scope,
	url: InternalUrl,
	tool: string,
	topic: string,
): Promise<InternalResource<string | Buffer>> {
	try {
		return await scope.base.resolve(url, scope.context);
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		const { hub, native } = await listing(scope, tool, hubTopics(tool));
		const available = [...hub.map((doc) => doc.topic), ...native].sort();
		if (available.length === 0 || available.includes(topic)) throw error;
		throw new ToolError(
			`Unknown topic '${topic}' for ${tool}. Available: ${available.join(", ")}. Read help://${tool} for the topic index.`,
		);
	}
}

function hubLine(doc: ToolTopicDoc, markHidden: boolean): string {
	const suffix = markHidden && doc.hiddenFromIndex ? " [hidden]" : "";
	return `- help://${doc.tool}/${doc.topic} — ${doc.title} (when: ${doc.when})${suffix}`;
}

function renderIndex(listings: readonly Listing[]): string {
	if (listings.length === 0) return "# help://\n\nNo help topics registered.\n";
	const lines = ["# help://", "", "Available tool help topics (read `help://<tool>` or `help://<tool>/<topic>`):", ""];
	for (const { tool, hub, native } of listings) {
		const visible = hub.filter((doc) => doc.hiddenFromIndex !== true);
		const hidden = hub.length - visible.length;
		lines.push(`## ${tool}`);
		for (const doc of visible.length > 0 ? visible : hub) lines.push(hubLine(doc, visible.length === 0));
		for (const topic of native) lines.push(`- help://${tool}/${topic}`);
		if (visible.length > 0 && hidden > 0) {
			lines.push(`- (${hidden} hidden topic${hidden === 1 ? "" : "s"}; read \`help://${tool}\` to list all)`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderTool({ tool, hub, native }: Listing): string {
	return [
		`# ${tool} help topics`,
		"",
		`Read \`help://${tool}/<topic>\` (line selectors apply).`,
		"",
		...hub.map((doc) => hubLine(doc, true)),
		...native.map((topic) => `- help://${tool}/${topic}`),
		"",
	].join("\n");
}

async function listingContents(scope: Scope, listings: readonly Listing[]): Promise<Array<{ url: string; content: string }>> {
	const results: Array<{ url: string; content: string }> = [];
	for (const { tool, hub, native } of listings) {
		for (const doc of hub) {
			const resolved = resolveToolTopic(doc.tool, doc.topic);
			if (resolved !== undefined) results.push({ url: `help://${doc.tool}/${doc.topic}`, content: resolved.content });
		}
		for (const topic of native) {
			try {
				const content = await nativeTopic(scope, tool, topic);
				if (content !== undefined) results.push({ url: `help://${tool}/${topic}`, content });
			} catch (error) {
				scope.warn(`cannot read native help://${tool}/${topic}`, error);
			}
		}
	}
	return results.sort((a, b) => a.url.localeCompare(b.url));
}

function completions(listings: readonly Listing[]): UrlCompletion[] {
	return listings.flatMap(({ tool, hub, native }) => {
		const total = hub.length + native.length;
		return [
			{ value: tool, description: `${total} topic${total === 1 ? "" : "s"}` },
			...hub.map((doc) => ({ value: `${tool}/${doc.topic}`, description: `${doc.title} — ${doc.when}` })),
			...native.map((topic) => ({ value: `${tool}/${topic}` })),
		];
	});
}

function createHelpHandler(base: ProtocolHandler, toolNames: () => readonly string[], warn: Warn): HelpWrapper {
	const scope = (context: ResolveContext | undefined): Scope => ({ base, context, warn });
	return {
		[HELP_WRAPPER_BASE]: base,
		scheme: "help",
		spec: base.spec,
		promptDoc: base.promptDoc?.bind(base),
		promptReference: base.promptReference?.bind(base),
		async resolve(url, context) {
			const { tool, topic } = parseHelpTarget(url);
			if (!tool) return markdown(url.href, renderIndex(await allListings(scope(context), toolNames)));
			if (topic === undefined) {
				const hub = hubTopics(tool);
				if (hub.length === 0) return base.resolve(url, context);
				return markdown(url.href, renderTool(await listing(scope(context), tool, hub)));
			}
			const resolved = resolveToolTopic(tool, topic);
			return resolved === undefined ? resolveUnregistered(scope(context), url, tool, topic) : markdown(url.href, resolved.content);
		},
		async enumerate(url, context) {
			const { tool, topic } = parseHelpTarget(url);
			if (!tool) return listingContents(scope(context), await allListings(scope(context), toolNames));
			if (topic === undefined) {
				const entry = await listing(scope(context), tool, hubTopics(tool));
				if (entry.hub.length + entry.native.length === 0) await base.resolve(url, context);
				return listingContents(scope(context), [entry]);
			}
			const content = resolveToolTopic(tool, topic)?.content ?? (await nativeTopic(scope(context), tool, topic));
			return content === undefined ? [] : [{ url: `help://${tool}/${topic}`, content }];
		},
		async complete(prefix = "", context) {
			const all = completions(await allListings(scope(context), toolNames));
			const normalized = prefix
				.trim()
				.replace(/^help:\/\//i, "")
				.toLowerCase();
			return normalized ? all.filter((candidate) => candidate.value.toLowerCase().startsWith(normalized)) : all;
		},
	};
}

export function publishTopics(docs: readonly ToolDocs[], toolNames: () => readonly string[], warn: Warn): void {
	// Catalog inject rules may target another tool (`inject[].tool`); do not publish a tool-filtered copy to the hub.
	registerToolTopics(
		OWNER,
		docs.flatMap(({ tool, topics }) =>
			topics.map(
				(topic): ToolTopicDoc => ({
					tool,
					topic: topic.name,
					title: topic.title,
					when: topic.when,
					body: topic.body,
					hiddenFromIndex: topic.hiddenFromIndex,
				}),
			),
		),
	);
	const router = InternalUrlRouter.instance();
	const current = router.getHandler("help");
	if (current === undefined) throw new Error("omp serves no help:// scheme");
	router.register(createHelpHandler(isHelpWrapper(current) ? current[HELP_WRAPPER_BASE] : current, toolNames, warn));
}
