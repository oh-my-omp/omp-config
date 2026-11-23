import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
	type ResolveContext,
	type SchemeSpec,
	type UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	listToolTopics,
	registerToolTopics,
	resolveToolTopic,
	type ToolTopicDoc,
	type ToolTopicInjectRule,
} from "../_shared/omomp-shared/internal-url.ts";
import type { Topic } from "./catalog.ts";

const OWNER = "omp-config/tool-topics";
const HELP_WRAPPER_BASE = Symbol.for("omp-config/help-wrapper-base");
const DEFAULT_HELP_SPEC: SchemeSpec = {
	backing: "virtual",
	selectors: "lines",
	immutable: true,
	compactTranscript: true,
};
const NATIVE_HELP_PROBE_TOOLS = ["read", "eval"] as const;

function toHubInjectRule(rule: Topic["inject"][number]): ToolTopicInjectRule {
	return {
		...(rule.parameter !== undefined ? { param: rule.parameter } : {}),
		...(rule.patternSource !== undefined ? { pattern: rule.patternSource } : {}),
		...(rule.onError !== undefined ? { onError: rule.onError } : {}),
		...(rule.resultPatternSource !== undefined ? { resultPattern: rule.resultPatternSource } : {}),
	};
}

function unwrapBaseHelpHandler(handler: ProtocolHandler | undefined): ProtocolHandler | undefined {
	if (handler === undefined) return undefined;
	if (Object.hasOwn(handler, HELP_WRAPPER_BASE)) {
		const inner: unknown = Reflect.get(handler, HELP_WRAPPER_BASE);
		return typeof inner === "object" && inner !== null ? (inner as ProtocolHandler) : undefined;
	}
	return handler;
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
	return {
		url,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
	};
}

function groupByTool(docs: readonly ToolTopicDoc[]): Map<string, ToolTopicDoc[]> {
	const grouped = new Map<string, ToolTopicDoc[]>();
	for (const doc of docs) {
		const list = grouped.get(doc.tool);
		if (list) list.push(doc);
		else grouped.set(doc.tool, [doc]);
	}
	return grouped;
}

function formatTopicLine(doc: ToolTopicDoc, markHidden: boolean): string {
	const suffix = markHidden && doc.hiddenFromIndex ? " [hidden]" : "";
	return `- help://${doc.tool}/${doc.topic} — ${doc.title} (when: ${doc.when})${suffix}`;
}

function parseNativeListing(tool: string, content: string): string[] {
	const prefix = `help://${tool}/`;
	const names: string[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.startsWith(prefix)) {
			const topic = line.slice(prefix.length).trim();
			if (topic && !topic.includes(" ")) names.push(topic);
		}
	}
	return names;
}

function nativeTopicsForSessionTool(context: ResolveContext | undefined, tool: string): string[] {
	const session = context?.session;
	if (!session?.getToolByName) return [];
	const found = session.getToolByName(tool) as { docTopics?: () => Readonly<Record<string, string>> } | undefined;
	const topics = found?.docTopics?.();
	return topics ? Object.keys(topics).sort() : [];
}

async function nativeTopicsViaBase(
	base: ProtocolHandler | undefined,
	tool: string,
	url: InternalUrl,
	context: ResolveContext | undefined,
): Promise<string[]> {
	const direct = nativeTopicsForSessionTool(context, tool);
	if (direct.length > 0) return direct;
	if (!base || !context?.session) return [];
	try {
		const res = await base.resolve(url, context);
		return typeof res.content === "string" ? parseNativeListing(tool, res.content) : [];
	} catch {
		return [];
	}
}

async function collectNativeToolMap(
	base: ProtocolHandler | undefined,
	context: ResolveContext | undefined,
	knownTools: Iterable<string>,
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	if (!context?.session) return result;
	const candidates = new Set<string>([...NATIVE_HELP_PROBE_TOOLS, ...knownTools]);
	for (const tool of [...candidates].sort()) {
		const direct = nativeTopicsForSessionTool(context, tool);
		if (direct.length > 0) {
			result.set(tool, direct);
			continue;
		}
		if (tool === "eval" && base) {
			try {
				const parsed = new URL("help://eval") as InternalUrl;
				parsed.rawHost = "eval";
				parsed.rawPathname = "";
				const res = await base.resolve(parsed, context);
				const topics = typeof res.content === "string" ? parseNativeListing("eval", res.content) : [];
				if (topics.length > 0) result.set("eval", topics);
			} catch {}
		}
	}
	return result;
}

function createAugmentedHelpHandler(base: ProtocolHandler | undefined, listToolNames?: () => readonly string[]): ProtocolHandler {
	const handler: ProtocolHandler = {
		scheme: "help",
		spec: base?.spec ?? DEFAULT_HELP_SPEC,
		...(base?.promptDoc ? { promptDoc: (host) => base.promptDoc?.(host) } : {}),
		...(base?.promptReference ? { promptReference: () => base.promptReference?.() } : {}),
		async resolve(url: InternalUrl, context?: ResolveContext) {
			const { tool, topic } = parseHelpTarget(url);
			if (!tool) {
				const hubDocs = listToolTopics(undefined, { includeHidden: true });
				const grouped = groupByTool(hubDocs);
				const nativeMap = await collectNativeToolMap(base, context, [...grouped.keys(), ...(listToolNames?.() ?? [])]);
				const allTools = [...new Set([...grouped.keys(), ...nativeMap.keys()])].sort();
				if (allTools.length === 0) {
					return markdown(url.href, "# help://\n\nNo help topics registered.\n");
				}
				const lines: string[] = ["# help://", "", "Available tool help topics (read `help://<tool>` or `help://<tool>/<topic>`):", ""];
				for (const name of allTools) {
					const docs = grouped.get(name) ?? [];
					const visible = docs.filter((doc) => doc.hiddenFromIndex !== true);
					const listed = visible.length > 0 ? visible : docs;
					const hubNames = new Set(docs.map((doc) => doc.topic));
					const nativeExtras = (nativeMap.get(name) ?? []).filter((entry) => !hubNames.has(entry));
					lines.push(`## ${name}`);
					for (const doc of listed) {
						lines.push(formatTopicLine(doc, visible.length === 0));
					}
					for (const extra of nativeExtras) {
						lines.push(`- help://${name}/${extra}`);
					}
					if (visible.length > 0 && visible.length < docs.length) {
						const hiddenCount = docs.length - visible.length;
						lines.push(`- (${hiddenCount} hidden topic${hiddenCount === 1 ? "" : "s"}; read \`help://${name}\` to list all)`);
					}
					lines.push("");
				}
				return markdown(url.href, lines.join("\n"));
			}
			if (topic === undefined) {
				const docs = listToolTopics(tool, { includeHidden: true });
				if (docs.length === 0) {
					if (base) return base.resolve(url, context);
					const available = [...new Set(listToolTopics(undefined, { includeHidden: true }).map((doc) => doc.tool))].join(", ") || "none";
					throw new ToolError(`Tool '${tool}' has no help:// topics. Tools with topics: ${available}.`);
				}
				const hubNames = new Set(docs.map((doc) => doc.topic));
				const nativeExtras = (await nativeTopicsViaBase(base, tool, url, context)).filter((entry) => !hubNames.has(entry));
				const lines = [
					`# ${tool} help topics`,
					"",
					`Read \`help://${tool}/<topic>\` (line selectors apply).`,
					"",
					...docs.map((doc) => formatTopicLine(doc, true)),
					...nativeExtras.map((extra) => `- help://${tool}/${extra}`),
					"",
				];
				return markdown(url.href, lines.join("\n"));
			}
			const resolved = resolveToolTopic(tool, topic);
			if (resolved !== undefined) {
				return markdown(url.href, resolved.content);
			}
			if (base) return base.resolve(url, context);
			const available = listToolTopics(tool, { includeHidden: true })
				.map((doc) => doc.topic)
				.join(", ");
			throw new ToolError(
				available ? `Unknown topic '${topic}' for ${tool}. Available: ${available}.` : `Tool '${tool}' has no help:// topics.`,
			);
		},
		async enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
			const { tool, topic } = parseHelpTarget(url);
			const results = new Map<string, string>();
			if (!tool) {
				for (const doc of listToolTopics(undefined, { includeHidden: true })) {
					const resolved = resolveToolTopic(doc.tool, doc.topic);
					if (resolved) results.set(`help://${doc.tool}/${doc.topic}`, resolved.content);
				}
				const nativeMap = await collectNativeToolMap(base, context, listToolNames?.() ?? []);
				for (const [name, topics] of nativeMap) {
					for (const entry of topics) {
						const key = `help://${name}/${entry}`;
						if (results.has(key) || !base) continue;
						try {
							const leafUrl = new URL(key) as InternalUrl;
							leafUrl.rawHost = name;
							leafUrl.rawPathname = `/${entry}`;
							const res = await base.resolve(leafUrl, context);
							if (typeof res.content === "string") results.set(key, res.content);
						} catch {}
					}
				}
				return [...results.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([href, content]) => ({ url: href, content }));
			}
			if (topic === undefined) {
				for (const doc of listToolTopics(tool, { includeHidden: true })) {
					const resolved = resolveToolTopic(doc.tool, doc.topic);
					if (resolved) results.set(`help://${doc.tool}/${doc.topic}`, resolved.content);
				}
				const nativeTopics = await nativeTopicsViaBase(base, tool, url, context);
				for (const entry of nativeTopics) {
					const key = `help://${tool}/${entry}`;
					if (results.has(key) || !base) continue;
					try {
						const leafUrl = new URL(key) as InternalUrl;
						leafUrl.rawHost = tool;
						leafUrl.rawPathname = `/${entry}`;
						const res = await base.resolve(leafUrl, context);
						if (typeof res.content === "string") results.set(key, res.content);
					} catch {}
				}
				if (results.size === 0 && base) {
					await base.resolve(url, context);
				}
				return [...results.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([href, content]) => ({ url: href, content }));
			}
			const resolved = resolveToolTopic(tool, topic);
			if (resolved !== undefined) {
				return [{ url: `help://${tool}/${topic}`, content: resolved.content }];
			}
			if (base) {
				const res = await base.resolve(url, context);
				return typeof res.content === "string" ? [{ url: `help://${tool}/${topic}`, content: res.content }] : [];
			}
			throw new ToolError(`Unknown topic '${topic}' for ${tool}.`);
		},
		async complete(prefix = "", context?: ResolveContext): Promise<UrlCompletion[]> {
			const hubDocs = listToolTopics(undefined, { includeHidden: true });
			const grouped = groupByTool(hubDocs);
			const nativeMap = await collectNativeToolMap(base, context, [...grouped.keys(), ...(listToolNames?.() ?? [])]);
			const allTools = [...new Set([...grouped.keys(), ...nativeMap.keys()])].sort();
			const completions: UrlCompletion[] = [];
			for (const name of allTools) {
				const docs = grouped.get(name) ?? [];
				const hubNames = new Set(docs.map((doc) => doc.topic));
				const nativeExtras = (nativeMap.get(name) ?? []).filter((entry) => !hubNames.has(entry));
				const total = docs.length + nativeExtras.length;
				completions.push({ value: name, description: `${total} topic${total === 1 ? "" : "s"}` });
				for (const doc of docs) {
					completions.push({ value: `${name}/${doc.topic}`, description: `${doc.title} — ${doc.when}` });
				}
				for (const extra of nativeExtras) {
					completions.push({ value: `${name}/${extra}` });
				}
			}
			const normalized = prefix
				.trim()
				.replace(/^help:\/\//i, "")
				.toLowerCase();
			if (!normalized) return completions;
			return completions.filter((candidate) => candidate.value.toLowerCase().startsWith(normalized));
		},
	};
	Object.defineProperty(handler, HELP_WRAPPER_BASE, { value: base, enumerable: false, writable: false, configurable: false });
	return handler;
}

export function publishTopics(tools: ReadonlyMap<string, readonly Topic[]>, listToolNames?: () => readonly string[]): boolean {
	const docs: ToolTopicDoc[] = [];
	for (const [tool, topics] of tools) {
		for (const topic of topics) {
			const inject = topic.inject.filter((rule) => rule.tool === tool).map(toHubInjectRule);
			docs.push({
				tool,
				topic: topic.name,
				title: topic.title,
				when: topic.when,
				body: topic.body,
				...(topic.hiddenFromIndex ? { hiddenFromIndex: true } : {}),
				...(inject.length > 0 ? { inject } : {}),
			});
		}
	}
	registerToolTopics(OWNER, docs);
	const router = InternalUrlRouter.instance();
	const base = unwrapBaseHelpHandler(router.getHandler("help"));
	router.register(createAugmentedHelpHandler(base, listToolNames));
	return true;
}
