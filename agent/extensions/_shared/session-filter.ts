import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { unquote } from "./spec-files.ts";

type Target =
	| { readonly kind: "all" }
	| { readonly kind: "main" }
	| { readonly kind: "subagents" }
	| { readonly kind: "agent"; readonly name: string };

export type TargetDefault = { readonly kind: "required" } | { readonly kind: "default"; readonly targets: readonly Target[] };

type CwdPattern = { readonly source: string; readonly glob: Bun.Glob };

type ModelField = "model" | "provider";

type ModelConstraint = { readonly field: ModelField; readonly source: string; readonly pattern: RegExp };

export type SessionFilter = {
	readonly targets: readonly Target[];
	readonly cwds: readonly CwdPattern[];
	readonly models: readonly ModelConstraint[];
};

export type FilterKeys = { readonly target: string; readonly cwd: string; readonly model: string; readonly provider: string };

export type InjectMode = "system" | "user";

export type FilterProblem =
	| { readonly kind: "missing"; readonly key: string }
	| { readonly kind: "empty"; readonly key: string }
	| { readonly kind: "relative"; readonly key: string; readonly pattern: string }
	| { readonly kind: "badRegex"; readonly key: string; readonly detail: string }
	| { readonly kind: "badInject"; readonly key: string; readonly value: string };

type Parsed<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly problem: FilterProblem };

export type Producer = { readonly model: string; readonly provider: string };

function listItems(raw: string): string[] {
	let value = raw.trim();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "{") depth += 1;
		else if (char === "}") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			items.push(value.slice(start, i));
			start = i + 1;
		}
	}
	items.push(value.slice(start));
	return items.map((item) => unquote(item)).filter((item) => item !== "");
}

function toTarget(item: string): Target {
	switch (item) {
		case "*":
		case "all":
		case "any":
			return { kind: "all" };
		case "main":
			return { kind: "main" };
		case "subagents":
		case "subagent":
		case "sub":
		case "subs":
			return { kind: "subagents" };
		default:
			return { kind: "agent", name: item };
	}
}

function parseTargets(raw: string | undefined, key: string, fallback: TargetDefault): Parsed<readonly Target[]> {
	if (raw === undefined) {
		switch (fallback.kind) {
			case "required":
				return { kind: "invalid", problem: { kind: "missing", key } };
			case "default":
				return { kind: "ok", value: fallback.targets };
			default: {
				const unreachable: never = fallback;
				return unreachable;
			}
		}
	}
	const items = listItems(raw).map((item) => item.toLowerCase());
	if (items.length === 0) return { kind: "invalid", problem: { kind: "empty", key } };
	return { kind: "ok", value: items.map(toTarget) };
}

function parseCwds(raw: string | undefined, key: string): Parsed<readonly CwdPattern[]> {
	if (raw === undefined) return { kind: "ok", value: [] };
	const items = listItems(raw);
	if (items.length === 0) return { kind: "invalid", problem: { kind: "empty", key } };
	const patterns: CwdPattern[] = [];
	for (const source of items) {
		// Bun.Glob patterns are `/`-separated on every platform; on win32 a `\` in the pattern matches nothing.
		const expanded = source === "~" || source.startsWith("~/") ? join(homedir(), source.slice(1)).split(sep).join("/") : source;
		if (!isAbsolute(expanded)) return { kind: "invalid", problem: { kind: "relative", key, pattern: source } };
		patterns.push({ source, glob: new Bun.Glob(expanded) });
	}
	return { kind: "ok", value: patterns };
}

export type ValueSyntax = "frontmatter" | "yaml";

function parseModels(fields: Readonly<Record<string, string>>, keys: FilterKeys, syntax: ValueSyntax): Parsed<readonly ModelConstraint[]> {
	const constraints: ModelConstraint[] = [];
	for (const field of ["model", "provider"] as const) {
		const key = keys[field];
		const raw = fields[key.toLowerCase()];
		if (raw === undefined) continue;
		const source = syntax === "yaml" ? raw : unquote(raw);
		if (source === "") return { kind: "invalid", problem: { kind: "empty", key } };
		try {
			constraints.push({ field, source, pattern: new RegExp(source) });
		} catch (error) {
			return { kind: "invalid", problem: { kind: "badRegex", key, detail: error instanceof Error ? error.message : String(error) } };
		}
	}
	return { kind: "ok", value: constraints };
}

export function parseSessionFilter(
	fields: Readonly<Record<string, string>>,
	keys: FilterKeys,
	fallback: TargetDefault,
	syntax: ValueSyntax,
): Parsed<SessionFilter> {
	const targets = parseTargets(fields[keys.target.toLowerCase()], keys.target, fallback);
	if (targets.kind === "invalid") return targets;
	const cwds = parseCwds(fields[keys.cwd.toLowerCase()], keys.cwd);
	if (cwds.kind === "invalid") return cwds;
	const models = parseModels(fields, keys, syntax);
	if (models.kind === "invalid") return models;
	return { kind: "ok", value: { targets: targets.value, cwds: cwds.value, models: models.value } };
}

export function parseInjectMode(raw: string | undefined): Parsed<InjectMode> {
	if (raw === undefined) return { kind: "ok", value: "system" };
	const value = unquote(raw).toLowerCase();
	switch (value) {
		case "system":
		case "user":
			return { kind: "ok", value };
		default:
			return { kind: "invalid", problem: { kind: "badInject", key: "inject", value: unquote(raw) } };
	}
}

export function targetsSession(filter: SessionFilter, agent: ExtensionContext["agent"], cwd: string): boolean {
	const identityMatches = filter.targets.some((target) => {
		switch (target.kind) {
			case "all":
				return true;
			case "main":
				return agent.kind === "main";
			case "subagents":
				return agent.kind === "sub";
			case "agent":
				return agent.kind === "sub" && (target.name === agent.name.toLowerCase() || target.name === agent.id.toLowerCase());
			default: {
				const unreachable: never = target;
				return unreachable;
			}
		}
	});
	if (!identityMatches) return false;
	if (filter.cwds.length === 0) return true;
	const normalized = resolve(cwd);
	return filter.cwds.some((pattern) => pattern.glob.match(normalized));
}

export function producerMatches(filter: SessionFilter, producer: Producer): boolean {
	return filter.models.every((constraint) => constraint.pattern.test(producer[constraint.field]));
}

function targetLabel(target: Target): string {
	switch (target.kind) {
		case "all":
			return "*";
		case "main":
			return "main";
		case "subagents":
			return "subagents";
		case "agent":
			return target.name;
		default: {
			const unreachable: never = target;
			return unreachable;
		}
	}
}

export function describeFilter(filter: SessionFilter, keys: FilterKeys, anyCwd: string): string {
	const parts = [`target ${filter.targets.map(targetLabel).join(",")}`, `cwd ${filter.cwds.map((c) => c.source).join(",") || anyCwd}`];
	for (const constraint of filter.models) parts.push(`${keys[constraint.field]} /${constraint.source}/`);
	return parts.join(" · ");
}
