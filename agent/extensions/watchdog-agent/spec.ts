import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type EditToolDetails, type EditToolPerFileResult, type ExtensionAPI, z, type zod } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import {
	type FilterKeys,
	type FilterProblem,
	type InjectMode,
	parseInjectMode,
	parseSessionFilter,
	type SessionFilter,
} from "../_shared/session-filter.ts";
import { discoverSpecFiles, isEnabled, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const WATCHDOG_FILE_PATTERN = /^WATCHDOG-.+\.md$/i;
export const WATCHDOG_FILTER_KEYS: FilterKeys = { target: "target", cwd: "cwd", model: "watchModel", provider: "watchProvider" };
const DEFAULT_TOOLS: readonly string[] = ["read", "grep", "glob"];
const GRANTABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "ast_grep", "web_search", "edit", "write", "bash", "eval"]);

const DEFAULT_MAX_PER_CONTEXT = Number.POSITIVE_INFINITY;
const DEFAULT_EVERY = 30;
const OBSERVE_INJECT = "none";
const OBSERVER_FORBIDDEN_KEYS: readonly string[] = ["delivery", "maxpercontext", "note", "instructions"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUOTED = /^(["'])([\s\S]*)\1$/;

export type Scope = "full" | "window";

export type DeliverAs = NonNullable<NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>["deliverAs"]>;

type WatchdogBase = {
	readonly name: string;
	readonly filter: SessionFilter;
	readonly enabled: boolean;
	readonly every: number;
	readonly scope: Scope;
	readonly guidance: string;
	readonly filePath: string;
};

type NotifyingBase = WatchdogBase & {
	readonly inject: InjectMode;
	readonly delivery: DeliverAs;
	readonly maxPerContext: number;
};

export type ChatWatchdog = NotifyingBase & {
	readonly kind: "chat";
	readonly model?: string;
	readonly tools: readonly string[];
};

export type EnvVar = { readonly name: string; readonly value: string };

export type ObserverWatchdog = WatchdogBase & {
	readonly kind: "observer";
	readonly model?: string;
	readonly tools: readonly string[];
	readonly env: readonly EnvVar[];
};

type JevOutcome = { readonly kind: "silent" } | { readonly kind: "inject"; readonly prompt: string; readonly delivery: DeliverAs };

type JevOption = {
	readonly label: string;
	readonly criteria: string | null;
	readonly outcome: JevOutcome;
};

export type JevWatchdog = NotifyingBase & {
	readonly kind: "jev";
	readonly instructions: string;
	readonly options: readonly JevOption[];
};

export type WatchdogSpec = ChatWatchdog | JevWatchdog | ObserverWatchdog;

export type NotifyingWatchdog = ChatWatchdog | JevWatchdog;

export type Verdict =
	| { readonly kind: "pass" }
	| { readonly kind: "advice"; readonly severity: string; readonly note: string; readonly delivery: DeliverAs };

const DEFAULT_JEV_INSTRUCTIONS =
	"Judge only the latest work in the supplied transcript against the configured guidance. Do not infer facts outside the supplied transcript.";
const JEV_OPTION_KEY = /^option\.([a-z0-9_-]+)(?:\.(prompt|delivery))?$/;

export function injectLabel(spec: WatchdogSpec): string {
	switch (spec.kind) {
		case "chat":
		case "jev":
			return spec.inject;
		case "observer":
			return OBSERVE_INJECT;
		default: {
			const unreachable: never = spec;
			return unreachable;
		}
	}
}

export function discoverWatchdogFiles(cwd: string): string[] {
	return discoverSpecFiles(WATCHDOG_FILE_PATTERN, import.meta.dir, cwd);
}

type EditedPaths = Pick<EditToolDetails, "path" | "sourcePath"> & {
	readonly perFileResults?: readonly Pick<EditToolPerFileResult, "path" | "sourcePath">[];
};

const editedPathsSchema: zod.ZodLikeSchema<EditedPaths> = z.object({
	path: z.string().optional(),
	sourcePath: z.string().optional(),
	perFileResults: z.array(z.object({ path: z.string(), sourcePath: z.string().optional() })).optional(),
});

function editedPaths(details: unknown): string[] {
	const parsed = editedPathsSchema.safeParse(details);
	if (!parsed.success) return [];
	const files = [parsed.data, ...(parsed.data.perFileResults ?? [])];
	return files.flatMap((file) => [file.path, file.sourcePath].filter((path): path is string => path !== undefined));
}

export function touchedWatchdogFiles(toolName: string, input: Record<string, unknown>, details: unknown, cwd: string): string[] {
	const raw = toolName === "write" && typeof input.path === "string" ? [input.path] : toolName === "edit" ? editedPaths(details) : [];
	const files = new Set<string>();
	for (const path of raw) {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) continue;
		const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
		const absolute = resolve(cwd, expanded);
		if (WATCHDOG_FILE_PATTERN.test(basename(absolute))) files.add(absolute);
	}
	return [...files];
}

function toList(value: string): string[] {
	const s = value.trim();
	const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
	return inner
		.split(",")
		.map(unquote)
		.filter((x) => x !== "");
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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

function describeProblem(problem: FilterProblem): string {
	switch (problem.kind) {
		case "missing":
			return `frontmatter has no \`${problem.key}\``;
		case "empty":
			return `frontmatter \`${problem.key}\` lists nothing`;
		case "relative":
			return `frontmatter \`${problem.key}\` pattern "${problem.pattern}" must be absolute or start with ~/`;
		case "badRegex":
			return `frontmatter \`${problem.key}\` is not a valid regex: ${problem.detail}`;
		case "badInject":
			return `frontmatter \`${problem.key}\` must be system, user or none, not "${problem.value}"`;
		default: {
			const unreachable: never = problem;
			return unreachable;
		}
	}
}

export function parseWatchdogFile(path: string): WatchdogParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `cannot read: ${errorText(error)}` };
	}
	const { fields, body } = parseFrontmatter(raw) ?? { fields: {}, body: raw };
	const filter = parseSessionFilter(fields, WATCHDOG_FILTER_KEYS, { kind: "required" }, "frontmatter");
	if (filter.kind === "invalid") return { kind: "invalid", reason: describeProblem(filter.problem) };

	const rawTools = fields.tools ? toList(fields.tools) : DEFAULT_TOOLS;
	const granted = rawTools.map((t) => t.toLowerCase()).filter((t) => GRANTABLE_TOOLS.has(t));
	const tools = granted.length > 0 ? granted : DEFAULT_TOOLS;
	const model = fields.model ? unquote(fields.model) : undefined;
	const fallbackName = basename(path)
		.replace(/^WATCHDOG-/i, "")
		.replace(/\.md$/i, "");
	const base: WatchdogBase = {
		name: fields.name ? unquote(fields.name) : fallbackName || "watchdog",
		filter: filter.value,
		enabled: isEnabled(fields),
		every: parsePositiveInt(fields.every, DEFAULT_EVERY),
		scope: normalizeScope(fields.scope),
		guidance: body.trim(),
		filePath: path,
	};
	const hasOptions = Object.keys(fields).some((key) => key.startsWith("option."));

	if (unquote(fields.inject ?? "").toLowerCase() === OBSERVE_INJECT) {
		const conflicting = OBSERVER_FORBIDDEN_KEYS.filter((key) => fields[key] !== undefined);
		if (hasOptions || conflicting.length > 0) {
			return {
				kind: "invalid",
				reason: `inject: none takes no ${[...conflicting, ...(hasOptions ? ["option.*"] : [])].join(", ")}`,
			};
		}
		if (!base.guidance) return { kind: "invalid", reason: "inject: none requires a nonempty body" };
		const env = parseEnv(fields.env, tools);
		if (env.kind === "invalid") return env;
		return { kind: "ok", spec: { ...base, kind: "observer", model, tools, env: env.env } };
	}

	if (fields.env !== undefined) return { kind: "invalid", reason: "env requires inject: none" };
	const inject = parseInjectMode(fields.inject);
	if (inject.kind === "invalid") return { kind: "invalid", reason: describeProblem(inject.problem) };
	const delivery = normalizeDelivery(fields.delivery);
	const common: NotifyingBase = {
		...base,
		inject: inject.value,
		delivery,
		maxPerContext: parsePositiveInt(fields.maxpercontext, DEFAULT_MAX_PER_CONTEXT),
	};
	if (hasOptions) {
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
	return { kind: "ok", spec: { ...common, kind: "chat", model, tools } };
}

type EnvParse = { readonly kind: "ok"; readonly env: readonly EnvVar[] } | { readonly kind: "invalid"; readonly reason: string };

function parseEnv(value: string | undefined, tools: readonly string[]): EnvParse {
	if (value === undefined) return { kind: "ok", env: [] };
	const env: EnvVar[] = [];
	const list = value.trim();
	const inner = list.startsWith("[") && list.endsWith("]") ? list.slice(1, -1) : list;
	for (const entry of inner.split(",").map((item) => stripQuotes(item.trim()))) {
		if (entry === "") continue;
		const eq = entry.indexOf("=");
		const name = entry.slice(0, eq);
		if (eq < 0 || !ENV_NAME.test(name)) return { kind: "invalid", reason: `env entry "${entry}" is not NAME=value` };
		if (env.some((v) => v.name === name)) return { kind: "invalid", reason: `env sets ${name} twice` };
		env.push({ name, value: stripQuotes(entry.slice(eq + 1)) });
	}
	if (env.length === 0) return { kind: "invalid", reason: "env lists nothing" };
	if (!tools.includes("bash")) return { kind: "invalid", reason: "env requires bash in tools" };
	if (tools.includes("eval")) return { kind: "invalid", reason: "env cannot be combined with eval, whose shell does not receive it" };
	return { kind: "ok", env };
}

function stripQuotes(text: string): string {
	const match = QUOTED.exec(text);
	return match ? (match[2] ?? "") : text;
}

type JevOptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JevOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

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
