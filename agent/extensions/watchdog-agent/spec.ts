import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";
export const WATCHDOG_FILE_PATTERN = /^WATCHDOG-.+\.md$/i;
/** Marks injected advisory user-messages so they are excluded from review + counting. */
export const ADVISORY_TAG = "<watchdog";
const DEFAULT_TOOLS: readonly string[] = ["read", "grep", "glob"];
/** Reviewer tools we are willing to grant from frontmatter (superset stays read-only by default). */
const GRANTABLE_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	edit: true,
	write: true,
	bash: true,
	eval: true,
};

const DEFAULT_MAX_PER_CONTEXT = Number.POSITIVE_INFINITY; // advisories per watchdog per context; unlimited unless configured.
const DEFAULT_EVERY = 30; // watched actions (tool calls + text replies) between runs.

/** Which messages a run reviews: the whole branch, or only those after the watchdog's previous run. */
export type Scope = "full" | "window";

export type DeliverAs = "aside" | "steer" | "nextTurn" | "followUp";

export type Identity = { readonly kind: "main" } | { readonly kind: "sub"; readonly agent: string; readonly fileId: string };

type WatchdogBase = {
	readonly name: string;
	readonly targets: readonly string[];
	/** File-level (global) switch: frontmatter `enabled`, default true. A session override may shadow it. */
	readonly enabled: boolean;
	readonly delivery: DeliverAs;
	readonly maxPerContext: number;
	readonly every: number;
	readonly scope: Scope;
	readonly guidance: string;
	readonly filePath: string;
};

export type ChatWatchdog = WatchdogBase & {
	readonly kind: "chat";
	readonly model?: string;
	readonly tools: readonly string[];
};

/** What happens when Jev picks an option: stay quiet, or inject the author's prompt. */
type JevOutcome = { readonly kind: "silent" } | { readonly kind: "inject"; readonly prompt: string; readonly delivery: DeliverAs };

type JevOption = {
	readonly label: string;
	/** Rubric handed to Jev; null when the label alone is self-explanatory. */
	readonly criteria: string | null;
	readonly outcome: JevOutcome;
};

export type JevWatchdog = WatchdogBase & {
	readonly kind: "jev";
	readonly instructions: string;
	readonly options: readonly JevOption[];
};

export type WatchdogSpec = ChatWatchdog | JevWatchdog;

export type Verdict =
	| { readonly kind: "pass" }
	| { readonly kind: "advice"; readonly severity: string; readonly note: string; readonly delivery: DeliverAs };

const DEFAULT_JEV_INSTRUCTIONS =
	"Judge only the latest work in the supplied transcript against the configured guidance. Do not infer facts outside the supplied transcript.";
const JEV_OPTION_KEY = /^option\.([a-z0-9_-]+)(?:\.(prompt|delivery))?$/;

/** Checked keyed access without an unchecked cast. */
export function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
	return typeof value === "object" && value !== null && key in value;
}

// --- discovery + parsing ----------------------------------------------------

/** Extension-level files precede the repository's watchdogs. */
export function discoverWatchdogFiles(cwd: string): string[] {
	return discoverSpecFiles(WATCHDOG_FILE_PATTERN, import.meta.dir, cwd);
}

/** Split a scalar/CSV/`[a, b]` frontmatter value into trimmed, unquoted items. */
function toList(value: string): string[] {
	let s = value.trim();
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	return s
		.split(",")
		.map((x) =>
			x
				.trim()
				.replace(/^["']|["']$/g, "")
				.trim(),
		)
		.filter((x) => x !== "");
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * The file text with frontmatter `enabled` set, replacing an existing `enabled:` line or
 * appending one as the last frontmatter line; everything else is kept byte for byte.
 * Null when the file has no frontmatter (it could not be a valid watchdog).
 */
export function setFrontmatterEnabled(raw: string, enabled: boolean): string | null {
	const m = raw.match(FRONTMATTER_PATTERN);
	if (!m || m[1] === undefined) return null;
	const blockStart = m[0].startsWith("---\r\n") ? 5 : 4;
	const blockEnd = blockStart + m[1].length;
	const eol = m[1].includes("\r\n") ? "\r\n" : "\n";
	const line = /^([ \t]*)enabled[ \t]*:.*$/im;
	const block = line.test(m[1]) ? m[1].replace(line, `$1enabled: ${enabled}`) : `${m[1]}${eol}enabled: ${enabled}`;
	return raw.slice(0, blockStart) + block + raw.slice(blockEnd);
}

type WatchdogParse = { readonly kind: "ok"; readonly spec: WatchdogSpec } | { readonly kind: "invalid"; readonly reason: string };

/** Parse one `WATCHDOG-*.md` (enabled or not); invalid when unreadable, targetless, or a malformed Jev declaration. */
export function parseWatchdogFile(path: string): WatchdogParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `cannot read: ${errorText(error)}` };
	}
	const { fields, body } = parseFrontmatter(raw) ?? { fields: {}, body: raw };
	const enabled = fields.enabled === undefined || /^(true|yes|on|1)$/i.test(unquote(fields.enabled));
	const targets = fields.target ? toList(fields.target) : [];
	if (targets.length === 0) return { kind: "invalid", reason: "frontmatter has no `target`" };

	const rawTools = fields.tools ? toList(fields.tools) : [...DEFAULT_TOOLS];
	const tools = rawTools.map((t) => t.toLowerCase()).filter((t) => GRANTABLE_TOOLS[t] === true);
	const delivery = normalizeDelivery(fields.delivery);
	const maxPerContext = parsePositiveInt(fields.maxpercontext, DEFAULT_MAX_PER_CONTEXT);
	const fallbackName = basename(path)
		.replace(/^WATCHDOG-/i, "")
		.replace(/\.md$/i, "");

	const common: WatchdogBase = {
		name: fields.name ? unquote(fields.name) : fallbackName || "watchdog",
		targets,
		enabled,
		delivery,
		maxPerContext,
		every: parsePositiveInt(fields.every, DEFAULT_EVERY),
		scope: normalizeScope(fields.scope),
		guidance: body.trim(),
		filePath: path,
	};
	if (Object.keys(fields).some((key) => key.startsWith("option."))) {
		if (fields.model !== undefined || fields.tools !== undefined || fields.note !== undefined || !common.guidance) {
			return {
				kind: "invalid",
				reason: "JUDGE options require a nonempty body; model, tools and note are not allowed",
			};
		}
		const parsed = parseJevOptions(fields, delivery);
		if (parsed.kind === "invalid") return parsed;
		const instructions = unquote(fields.instructions ?? "");
		return {
			kind: "ok",
			spec: {
				...common,
				kind: "jev",
				instructions: instructions || DEFAULT_JEV_INSTRUCTIONS,
				options: parsed.options,
			},
		};
	}
	return {
		kind: "ok",
		spec: {
			...common,
			kind: "chat",
			model: fields.model ? unquote(fields.model) : undefined,
			tools: tools.length > 0 ? tools : [...DEFAULT_TOOLS],
		},
	};
}

type JevOptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JevOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `option.<label>[.prompt|.delivery]` keys into Jev options. */
function parseJevOptions(fields: Record<string, string>, defaultDelivery: DeliverAs): JevOptionsParse {
	const criteria = new Map<string, string | null>();
	const prompts = new Map<string, string>();
	const deliveries = new Map<string, DeliverAs>();
	for (const [key, raw] of Object.entries(fields)) {
		if (!key.startsWith("option.")) continue;
		const m = key.match(JEV_OPTION_KEY);
		if (!m)
			return {
				kind: "invalid",
				reason: `unsupported option key "${key}" (use option.<label>, option.<label>.prompt, option.<label>.delivery)`,
			};
		const [, label, part] = m;
		if (label === undefined) return { kind: "invalid", reason: `unsupported option key "${key}"` };
		if (part !== undefined && part !== "prompt" && part !== "delivery")
			return { kind: "invalid", reason: `unsupported option key "${key}"` };
		const value = unquote(raw);
		switch (part) {
			case undefined:
				criteria.set(label, value || null);
				break;
			case "prompt":
				if (!value) return { kind: "invalid", reason: `option.${label}.prompt is empty (omit it for a silent option)` };
				prompts.set(label, value);
				break;
			case "delivery":
				deliveries.set(label, normalizeDelivery(value));
				break;
			default: {
				const unreachable: never = part;
				return unreachable;
			}
		}
	}
	for (const label of [...prompts.keys(), ...deliveries.keys()]) {
		if (!criteria.has(label)) return { kind: "invalid", reason: `option.${label} is not declared (add option.${label}: <criteria>)` };
	}
	for (const label of deliveries.keys()) {
		if (!prompts.has(label)) return { kind: "invalid", reason: `option.${label}.delivery set on a silent option` };
	}
	if (criteria.size < 2) return { kind: "invalid", reason: "judge requires at least two option.<label> entries" };
	if (prompts.size === 0) return { kind: "invalid", reason: "judge requires at least one option.<label>.prompt" };
	const options: JevOption[] = [];
	for (const [label, rubric] of criteria) {
		const prompt = prompts.get(label);
		options.push({
			label,
			criteria: rubric,
			outcome: prompt === undefined ? { kind: "silent" } : { kind: "inject", prompt, delivery: deliveries.get(label) ?? defaultDelivery },
		});
	}
	return { kind: "ok", options };
}

function normalizeDelivery(value: string | undefined): DeliverAs {
	switch (unquote(value ?? "").toLowerCase()) {
		case "steer":
			return "steer";
		case "nextturn":
			return "nextTurn";
		case "followup":
			return "followUp";
		default:
			return "aside";
	}
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(unquote(value ?? ""), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeScope(value: string | undefined): Scope {
	return unquote(value ?? "").toLowerCase() === "window" ? "window" : "full";
}
