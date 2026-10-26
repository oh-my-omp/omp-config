// ============================================================================
// read-topics — topic lookup for the built-in `read` tool through `tool://`.
//
// `read tool://read` lists the topics, `read tool://read/<topic>` returns one
// (line selectors apply: `tool://read/sqlite:1-40`), `read tool://` lists the
// tools that have topics. The text is not a copy: each topic is one section of
// OMP's own bundled `omp://tools/read.md` (`getEmbeddedDoc`), cut by the fixed
// heading table `TOPICS`, so it follows the installed OMP version. The doc is
// loaded and cut once, on the first `tool://` read; a missing doc or a heading
// the table names that the doc no longer has exactly once fails that read with
// the drift spelled out, instead of serving partial topics.
//
// The factory registers one `tool://` handler in OMP's process-global
// `InternalUrlRouter`, which `read`, `grep` and prompt completion consult, and
// whose `promptDoc` line the system prompt lists. Registration is per process
// and idempotent (the handler carries `OWNER`); an OMP-owned `tool` scheme or
// one another host registered is left alone with a warning. Nothing is
// unregistered: every session of the process shares the router.
//
// Registers no tools, commands or hooks; reads no files of its own; main and
// sub sessions alike. Failures are logged; nothing throws into omp.
// ============================================================================
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getEmbeddedDoc } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	SchemeSpec,
	UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { errorText } from "../_shared/errors.ts";

const SCHEME = "tool";
const OWNER = "omp-config/read-topics";
const READ_DOC = "tools/read.md";

/** One topic: a stable key and the exact `##`/`###` heading of `omp://tools/read.md` it cuts. */
interface TopicSection {
	readonly key: string;
	readonly level: 2 | 3;
	readonly heading: string;
}

// Keys are the public API; headings follow OMP's doc. `Source`,
// `Registration / Visibility` and `Notes` are maintainer-only and stay out.
const TOPICS: readonly TopicSection[] = [
	{ key: "selectors", level: 2, heading: "Inputs" },
	{ key: "outputs", level: 2, heading: "Outputs" },
	{ key: "flow", level: 2, heading: "Flow" },
	{ key: "local-files", level: 3, heading: "Local text files" },
	{ key: "directories", level: 3, heading: "Directory listings" },
	{ key: "archives", level: 3, heading: "Archives" },
	{ key: "executables", level: 3, heading: "Executables and IDA databases" },
	{ key: "video", level: 3, heading: "Video" },
	{ key: "profiler-reports", level: 3, heading: "Profiler reports" },
	{ key: "sqlite", level: 3, heading: "SQLite databases" },
	{ key: "documents", level: 3, heading: "Documents" },
	{ key: "notebooks", level: 3, heading: "Jupyter notebooks" },
	{ key: "images", level: 3, heading: "Images" },
	{ key: "internal-urls", level: 3, heading: "Internal URLs" },
	{ key: "web-urls", level: 3, heading: "Web URLs" },
	{ key: "side-effects", level: 2, heading: "Side Effects" },
	{ key: "limits", level: 2, heading: "Limits & Caps" },
	{ key: "errors", level: 2, heading: "Errors" },
];

interface Topic {
	readonly key: string;
	readonly heading: string;
	readonly body: string;
}

type Cut = { readonly kind: "ok"; readonly topics: ReadonlyMap<string, Topic> } | { readonly kind: "drift"; readonly reason: string };

interface Heading {
	readonly level: number;
	readonly text: string;
	readonly line: number;
}

const FENCE = /^ {0,3}(```|~~~)/;
const ATX = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;

/** ATX headings outside fenced code blocks. */
function headingsOf(lines: readonly string[]): Heading[] {
	const headings: Heading[] = [];
	let fence: string | undefined;
	for (const [line, text] of lines.entries()) {
		const marker = FENCE.exec(text)?.[1];
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (marker === fence) fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		const match = ATX.exec(text);
		if (match?.[1] && match[2] !== undefined) headings.push({ level: match[1].length, text: match[2], line });
	}
	return headings;
}

/** Cut every `TOPICS` section out of the doc; each heading must occur exactly once at its level. */
function cutTopics(doc: string): Cut {
	const lines = doc.split("\n");
	const headings = headingsOf(lines);
	const topics = new Map<string, Topic>();
	const problems: string[] = [];
	for (const section of TOPICS) {
		const hits = headings.filter((h) => h.level === section.level && h.text === section.heading);
		const start = hits[0];
		if (hits.length !== 1 || start === undefined) {
			problems.push(`"${"#".repeat(section.level)} ${section.heading}" found ${hits.length} times`);
			continue;
		}
		const end = headings.find((h) => h.line > start.line && h.level <= section.level)?.line ?? lines.length;
		topics.set(section.key, { key: section.key, heading: section.heading, body: lines.slice(start.line, end).join("\n").trimEnd() });
	}
	if (problems.length > 0) return { kind: "drift", reason: `omp://${READ_DOC} no longer matches the topic table: ${problems.join("; ")}` };
	return { kind: "ok", topics };
}

let cachedCut: Promise<Cut> | undefined;

/** The read topics, loaded and cut once per process on first use. */
function loadReadTopics(): Promise<Cut> {
	cachedCut ??= getEmbeddedDoc(READ_DOC).then(
		(doc): Cut => (doc === undefined ? { kind: "drift", reason: `omp://${READ_DOC} is not in this omp build` } : cutTopics(doc)),
	);
	return cachedCut;
}

async function topicsOrThrow(): Promise<ReadonlyMap<string, Topic>> {
	const cut = await loadReadTopics();
	switch (cut.kind) {
		case "ok":
			return cut.topics;
		case "drift":
			throw new Error(`tool://read topics unavailable: ${cut.reason}`);
		default: {
			const unreachable: never = cut;
			return unreachable;
		}
	}
}

function markdown(url: string, content: string): InternalResource {
	return { url, content, contentType: "text/markdown", size: Buffer.byteLength(content) };
}

/** `tool://<tool>[/<topic>]` → tool name and optional topic; throws on deeper paths. */
function target(url: InternalUrl): { readonly tool: string; readonly topic: string | undefined } {
	const tool = url.rawHost || url.hostname;
	const segments = (url.rawPathname ?? url.pathname).split("/").filter((segment) => segment.length > 0);
	if (segments.length > 1) throw new Error(`Invalid ${SCHEME}:// URL: ${url.href}. Use ${SCHEME}://<tool> or ${SCHEME}://<tool>/<topic>.`);
	return { tool, topic: segments[0] };
}

function topicIndex(topics: ReadonlyMap<string, Topic>): string {
	const rows = [...topics.values()].map((topic) => `- [${topic.key}](${SCHEME}://read/${topic.key}) — ${topic.heading}`);
	return [
		"# read topics",
		"",
		`Sections of omp://${READ_DOC}; read ${SCHEME}://read/<topic> (line selectors apply).`,
		"",
		...rows,
		"",
	].join("\n");
}

class ToolTopicsHandler implements ProtocolHandler {
	readonly scheme = SCHEME;
	readonly owner = OWNER;
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };

	promptDoc(): string {
		return `\`${SCHEME}://read/<topic>\`: per-feature \`read\` docs (selectors, sqlite, archives, images, web-urls, limits, …); \`${SCHEME}://read\` lists topics.`;
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const { tool, topic } = target(url);
		if (!tool) return markdown(url.href, `# ${SCHEME}://\n\nTools with topics:\n\n- [read](${SCHEME}://read)\n`);
		if (tool !== "read") throw new Error(`Tool '${tool}' has no ${SCHEME}:// topics. Tools with topics: read.`);
		const topics = await topicsOrThrow();
		if (topic === undefined) return markdown(url.href, topicIndex(topics));
		const found = topics.get(topic);
		if (!found) throw new Error(`Unknown topic '${topic}' for read. Available: ${[...topics.keys()].join(", ")}.`);
		return markdown(url.href, found.body);
	}

	/** `grep`/`find` leaves: every read topic under `tool://` and `tool://read`, else the one topic. */
	async enumerate(url: InternalUrl): Promise<Array<{ url: string; content: string }>> {
		const { tool, topic } = target(url);
		if (tool && tool !== "read") throw new Error(`Tool '${tool}' has no ${SCHEME}:// topics. Tools with topics: read.`);
		const topics = await topicsOrThrow();
		const leaves = topic === undefined ? [...topics.values()] : [topics.get(topic)].filter((found) => found !== undefined);
		if (leaves.length === 0) throw new Error(`Unknown topic '${topic}' for read. Available: ${[...topics.keys()].join(", ")}.`);
		return leaves.map((leaf) => ({ url: `${SCHEME}://read/${leaf.key}`, content: leaf.body }));
	}

	async complete(): Promise<UrlCompletion[]> {
		return [{ value: "read" }, ...TOPICS.map((section) => ({ value: `read/${section.key}`, description: section.heading }))];
	}
}

export default function readTopics(pi: ExtensionAPI): void {
	try {
		const router = InternalUrlRouter.instance();
		if (router.isBuiltin(SCHEME)) {
			pi.logger.warn(`read-topics: OMP now owns ${SCHEME}://; topic handler not registered`);
			return;
		}
		const existing = router.getHandler(SCHEME);
		if (existing && Reflect.get(existing, "owner") !== OWNER) {
			pi.logger.warn(`read-topics: ${SCHEME}:// is registered by another host; topic handler not registered`);
			return;
		}
		router.register(new ToolTopicsHandler());
	} catch (error) {
		pi.logger.warn("read-topics: registering tool:// failed", { error: errorText(error) });
	}
}
