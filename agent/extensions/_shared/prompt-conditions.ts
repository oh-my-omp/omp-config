import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type FilterKeys,
	type FilterProblem,
	parseSessionFilter,
	producerMatches,
	type SessionFilter,
	type TargetDefault,
	targetsSession,
} from "./session-filter.ts";
import { unquote } from "./spec-files.ts";

/**
 * When a system-prompt fragment or rule applies: inclusion keys `target`,
 * `cwd`, `model`, `provider`, `mode`, and the same keys under `exclude.`.
 * `target` / `cwd` / `model` / `provider` follow `session-filter.ts`; `mode`
 * is a comma list of `full` and `light`, the current mode being `light` when
 * `OMOMP_MODE=light` (set by `omp-light`) and `full` otherwise. Inclusion keys
 * must all match; the exclusion, which exists only when an `exclude.*` key is
 * set, excludes when all of its keys match, and without `exclude.target` it
 * covers every session. `model` / `provider` test the session's current model;
 * with none, a model or provider constraint matches on neither side.
 * The default inclusion target belongs to the caller.
 */
export type Mode = "full" | "light";

interface Side {
	readonly filter: SessionFilter;
	/** Null: any mode. */
	readonly modes: readonly Mode[] | null;
}

type Exclusion = { readonly kind: "none" } | { readonly kind: "side"; readonly side: Side };

export interface SessionConditions {
	readonly include: Side;
	readonly exclusion: Exclusion;
}

export type ConditionProblem = FilterProblem | { readonly kind: "badMode"; readonly key: string; readonly value: string };

type SideKeys = FilterKeys & { readonly mode: string };

const INCLUDE_KEYS: SideKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider", mode: "mode" };
const EXCLUDE_KEYS: SideKeys = {
	target: "exclude.target",
	cwd: "exclude.cwd",
	model: "exclude.model",
	provider: "exclude.provider",
	mode: "exclude.mode",
};

/** Every condition key, as the caller must accept it beside its own keys. */
export const CONDITION_KEYS: readonly string[] = [...Object.values(INCLUDE_KEYS), ...Object.values(EXCLUDE_KEYS)];

type Parsed<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly problem: ConditionProblem };

function parseModes(raw: string | undefined, key: string): Parsed<readonly Mode[] | null> {
	if (raw === undefined) return { kind: "ok", value: null };
	const modes: Mode[] = [];
	for (const item of unquote(raw).split(",")) {
		const value = unquote(item).toLowerCase();
		switch (value) {
			case "full":
			case "light":
				modes.push(value);
				break;
			default:
				return { kind: "invalid", problem: { kind: "badMode", key, value } };
		}
	}
	return { kind: "ok", value: modes };
}

function parseSide(fields: Readonly<Record<string, string>>, keys: SideKeys, fallback: TargetDefault): Parsed<Side> {
	const filter = parseSessionFilter(fields, keys, fallback);
	if (filter.kind === "invalid") return filter;
	const modes = parseModes(fields[keys.mode], keys.mode);
	if (modes.kind === "invalid") return modes;
	return { kind: "ok", value: { filter: filter.value, modes: modes.value } };
}

/** `fields` maps condition keys (lowercase, as listed in CONDITION_KEYS) to their raw string values. */
export function parseSessionConditions(fields: Readonly<Record<string, string>>, includeDefault: TargetDefault): Parsed<SessionConditions> {
	const include = parseSide(fields, INCLUDE_KEYS, includeDefault);
	if (include.kind === "invalid") return include;
	if (!Object.values(EXCLUDE_KEYS).some((key) => fields[key] !== undefined)) {
		return { kind: "ok", value: { include: include.value, exclusion: { kind: "none" } } };
	}
	const exclude = parseSide(fields, EXCLUDE_KEYS, { kind: "default", targets: [{ kind: "all" }] });
	if (exclude.kind === "invalid") return exclude;
	return { kind: "ok", value: { include: include.value, exclusion: { kind: "side", side: exclude.value } } };
}

function sideMatches(side: Side, ctx: ExtensionContext, mode: Mode): boolean {
	if (side.modes !== null && !side.modes.includes(mode)) return false;
	if (!targetsSession(side.filter, ctx.agent, ctx.cwd)) return false;
	if (side.filter.models.length === 0) return true;
	const model = ctx.model;
	if (model === undefined) return false;
	return producerMatches(side.filter, { model: model.id, provider: model.provider });
}

export function conditionsApply(conditions: SessionConditions, ctx: ExtensionContext): boolean {
	const mode: Mode = process.env.OMOMP_MODE === "light" ? "light" : "full";
	if (!sideMatches(conditions.include, ctx, mode)) return false;
	switch (conditions.exclusion.kind) {
		case "none":
			return true;
		case "side":
			return !sideMatches(conditions.exclusion.side, ctx, mode);
		default: {
			const unreachable: never = conditions.exclusion;
			return unreachable;
		}
	}
}
