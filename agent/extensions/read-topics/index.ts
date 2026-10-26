// read-topics — register read-specific content through _shared/tool-topics.ts.
// The shared module owns tool:// routing, indexes, search and completion.
// This factory supplies only the stable chapter mapping and session-independent
// readers of OMP's bundled tools/read.md. The first leaf read cuts the entire
// doc once per module load; missing/duplicate headings fail without partial text.
// No tools, commands, hooks or files; main/sub and full/light alike.
// Registration failures are warned at the factory boundary, never thrown to OMP.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getEmbeddedDoc } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { errorText } from "../_shared/errors.ts";
import { registerToolTopics } from "../_shared/tool-topics.ts";

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

export default function readTopics(pi: ExtensionAPI): void {
	try {
		const result = registerToolTopics({
			tool: "read",
			owner: "omp-config/read-topics",
			topics: TOPICS.map((section) => ({
				name: section.key,
				title: section.heading,
				async read() {
					const topics = await topicsOrThrow();
					const topic = topics.get(section.key);
					if (!topic) throw new Error(`Read topic '${section.key}' missing from the chapter table`);
					return topic.body;
				},
			})),
		});
		switch (result.kind) {
			case "registered":
				return;
			case "invalid":
			case "conflict":
				pi.logger.warn("read-topics: registration failed", { reason: result.reason });
				return;
			default: {
				const unreachable: never = result;
				throw new Error(`Unhandled registration result: ${unreachable}`);
			}
		}
	} catch (error) {
		pi.logger.warn("read-topics: registration failed", { error: errorText(error) });
	}
}
