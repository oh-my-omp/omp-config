// Authored tool topics and surfaces beside this extension: `TOPIC-*.md` and `SURFACE-*.md`,
// each a `---`-fenced YAML header (strict keys) followed by a non-empty markdown body.
// A TOPIC header may list `inject` entries — `{id, tool, parameter, pattern}` rules that
// deliver the file's own `tool://<tool>/<name>` after a matching tool call; ids are unique
// across the whole catalog.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";

export interface InjectRule {
	readonly id: string;
	/** The tool whose call triggers the rule — not necessarily the topic's own tool. */
	readonly tool: string;
	readonly parameter: string;
	readonly pattern: RegExp;
}

export interface Topic {
	readonly name: string;
	readonly title: string;
	readonly when: string;
	readonly body: string;
	readonly inject: readonly InjectRule[];
}

/** Everything authored for one tool: an optional surface replacing its description, and its topics. */
export interface ToolDocs {
	readonly tool: string;
	readonly surface: string | undefined;
	readonly topics: readonly Topic[];
}

export interface Catalog {
	readonly tools: ReadonlyMap<string, ToolDocs>;
	/** Files skipped, one line each (file: reason). */
	readonly problems: readonly string[];
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const nameSchema = z.string().refine((value) => NAME.test(value), "Expected [A-Za-z0-9_.-]+");
const textSchema = z.string().refine((value) => value.trim().length > 0 && !value.includes("\n"), "Expected one non-empty line");
const injectEntry = z
	.object({
		id: z.string().min(1),
		tool: z.string().min(1),
		parameter: z.string().refine((value) => /^[A-Za-z_][\w]*(?:\.[\w]+)*$/.test(value), "Expected an argument name or dotted path"),
		pattern: z
			.string()
			.refine((value) => {
				try {
					new RegExp(value);
					return true;
				} catch {
					// An invalid configured regex is the failure being reported.
					return false;
				}
			}, "Invalid regular expression")
			.transform((source) => new RegExp(source)),
	})
	.strict();
const topicHeader = z
	.object({
		tool: nameSchema,
		name: nameSchema,
		title: textSchema,
		when: textSchema,
		upstream: textSchema,
		inject: z.array(injectEntry).optional(),
	})
	.strict();
const surfaceHeader = z.object({ tool: nameSchema, upstream: textSchema }).strict();

const FILE = /^(TOPIC|SURFACE)-.+\.md$/;
const FENCED = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

type Entry =
	| { readonly kind: "topic"; readonly tool: string; readonly topic: Topic }
	| { readonly kind: "surface"; readonly tool: string; readonly body: string }
	| { readonly kind: "invalid"; readonly reason: string };

function parseEntry(file: string, text: string): Entry {
	const match = FENCED.exec(text);
	if (!match?.[1] || match[2] === undefined) return { kind: "invalid", reason: "missing --- header" };
	const body = match[2].trim();
	if (!body) return { kind: "invalid", reason: "empty body" };
	let header: unknown;
	try {
		header = Bun.YAML.parse(match[1]);
	} catch (error) {
		return { kind: "invalid", reason: `header is not YAML: ${errorText(error)}` };
	}
	if (file.startsWith("TOPIC-")) {
		const parsed = topicHeader.safeParse(header);
		if (!parsed.success) return { kind: "invalid", reason: parsed.error.message };
		const { tool, name, title, when, inject } = parsed.data;
		return { kind: "topic", tool, topic: { name, title, when, body, inject: inject ?? [] } };
	}
	const parsed = surfaceHeader.safeParse(header);
	if (!parsed.success) return { kind: "invalid", reason: parsed.error.message };
	return { kind: "surface", tool: parsed.data.tool, body };
}

/** Read every authored file in `dir`; a bad file, duplicate topic, duplicate inject id or second surface is skipped and reported. */
export function loadCatalog(dir: string): Catalog {
	const problems: string[] = [];
	const surfaces = new Map<string, string>();
	const topics = new Map<string, Map<string, Topic>>();
	const injectIds = new Set<string>();
	for (const file of readdirSync(dir)
		.filter((name) => FILE.test(name))
		.sort()) {
		let text: string;
		try {
			text = readFileSync(join(dir, file), "utf8");
		} catch (error) {
			problems.push(`${file}: unreadable (${errorText(error)})`);
			continue;
		}
		const entry = parseEntry(file, text);
		switch (entry.kind) {
			case "invalid":
				problems.push(`${file}: ${entry.reason}`);
				break;
			case "surface":
				if (surfaces.has(entry.tool)) problems.push(`${file}: second surface for ${entry.tool}`);
				else surfaces.set(entry.tool, entry.body);
				break;
			case "topic": {
				const own = topics.get(entry.tool) ?? new Map<string, Topic>();
				const ids = new Set<string>();
				const duplicate = entry.topic.inject.find((rule) => ids.size === ids.add(rule.id).size || injectIds.has(rule.id));
				if (duplicate !== undefined) problems.push(`${file}: duplicate inject id ${duplicate.id}`);
				else if (own.has(entry.topic.name)) problems.push(`${file}: duplicate topic ${entry.tool}/${entry.topic.name}`);
				else {
					for (const rule of entry.topic.inject) injectIds.add(rule.id);
					own.set(entry.topic.name, entry.topic);
				}
				topics.set(entry.tool, own);
				break;
			}
			default: {
				const unreachable: never = entry;
				return unreachable;
			}
		}
	}
	const tools = new Map<string, ToolDocs>();
	for (const tool of new Set([...surfaces.keys(), ...topics.keys()])) {
		tools.set(tool, { tool, surface: surfaces.get(tool), topics: [...(topics.get(tool)?.values() ?? [])] });
	}
	return { tools, problems };
}
