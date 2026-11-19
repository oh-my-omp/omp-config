import type { DelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type FilterKeys,
	type FilterProblem,
	parseSessionFilter,
	producerMatches,
	type SessionFilter,
	type TargetDefault,
	targetsSession,
	type ValueSyntax,
} from "./session-filter.ts";
import { unquote } from "./spec-files.ts";

/**
 * The default inclusion target belongs to the caller, and so does resolving
 * the delegation bias: host packages are imported here for types only,
 * because the standalone updater (`omp-config-update.ts`, run by plain `bun`
 * outside omp) loads this module through `legacy-system-replacements.ts`, and
 * a runtime host import fails to load there.
 */
type Mode = "full" | "light";

type Choices<T extends string> = Readonly<Record<T, true>>;

const MODES: Choices<Mode> = { full: true, light: true };
const DELEGATION_BIASES: Choices<DelegationBias> = { eager: true, balanced: true, restrained: true, gated: true };

interface Side {
	readonly filter: SessionFilter;
	readonly modes: readonly Mode[] | null;
	readonly delegations: readonly DelegationBias[] | null;
}

type Exclusion = { readonly kind: "none" } | { readonly kind: "side"; readonly side: Side };

export interface SessionConditions {
	readonly include: Side;
	readonly exclusion: Exclusion;
}

export type ConditionProblem =
	| FilterProblem
	| { readonly kind: "badChoice"; readonly key: string; readonly value: string; readonly allowed: readonly string[] };

type SideKeys = FilterKeys & { readonly mode: string; readonly delegation: string };

const INCLUDE_KEYS: SideKeys = {
	target: "target",
	cwd: "cwd",
	model: "model",
	provider: "provider",
	mode: "mode",
	delegation: "delegation",
};
const EXCLUDE_KEYS: SideKeys = {
	target: "exclude.target",
	cwd: "exclude.cwd",
	model: "exclude.model",
	provider: "exclude.provider",
	mode: "exclude.mode",
	delegation: "exclude.delegation",
};

export const CONDITION_KEYS: readonly string[] = [...Object.values(INCLUDE_KEYS), ...Object.values(EXCLUDE_KEYS)];

type Parsed<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly problem: ConditionProblem };

function isChoice<T extends string>(choices: Choices<T>, value: string): value is T {
	return Object.hasOwn(choices, value);
}

function parseChoices<T extends string>(raw: string | undefined, key: string, choices: Choices<T>): Parsed<readonly T[] | null> {
	if (raw === undefined) return { kind: "ok", value: null };
	const chosen: T[] = [];
	for (const item of unquote(raw).split(",")) {
		const value = unquote(item).toLowerCase();
		if (!isChoice(choices, value)) {
			return { kind: "invalid", problem: { kind: "badChoice", key, value, allowed: Object.keys(choices) } };
		}
		chosen.push(value);
	}
	return { kind: "ok", value: chosen };
}

function parseSide(fields: Readonly<Record<string, string>>, keys: SideKeys, fallback: TargetDefault, syntax: ValueSyntax): Parsed<Side> {
	const filter = parseSessionFilter(fields, keys, fallback, syntax);
	if (filter.kind === "invalid") return filter;
	const modes = parseChoices(fields[keys.mode], keys.mode, MODES);
	if (modes.kind === "invalid") return modes;
	const delegations = parseChoices(fields[keys.delegation], keys.delegation, DELEGATION_BIASES);
	if (delegations.kind === "invalid") return delegations;
	return { kind: "ok", value: { filter: filter.value, modes: modes.value, delegations: delegations.value } };
}

export function parseSessionConditions(
	fields: Readonly<Record<string, string>>,
	includeDefault: TargetDefault,
	syntax: ValueSyntax,
): Parsed<SessionConditions> {
	const include = parseSide(fields, INCLUDE_KEYS, includeDefault, syntax);
	if (include.kind === "invalid") return include;
	if (!Object.values(EXCLUDE_KEYS).some((key) => fields[key] !== undefined)) {
		return { kind: "ok", value: { include: include.value, exclusion: { kind: "none" } } };
	}
	const exclude = parseSide(fields, EXCLUDE_KEYS, { kind: "default", targets: [{ kind: "all" }] }, syntax);
	if (exclude.kind === "invalid") return exclude;
	return { kind: "ok", value: { include: include.value, exclusion: { kind: "side", side: exclude.value } } };
}

function sideMatches(side: Side, ctx: ExtensionContext, mode: Mode, delegation: DelegationBias | undefined): boolean {
	if (side.modes !== null && !side.modes.includes(mode)) return false;
	if (!targetsSession(side.filter, ctx.agent, ctx.cwd)) return false;
	if (side.delegations !== null && (delegation === undefined || !side.delegations.includes(delegation))) return false;
	if (side.filter.models.length === 0) return true;
	const model = ctx.model;
	if (model === undefined) return false;
	return producerMatches(side.filter, { model: model.id, provider: model.provider });
}

export function conditionsApply(conditions: SessionConditions, ctx: ExtensionContext, delegation: DelegationBias | undefined): boolean {
	const mode: Mode = process.env.OMOMP_MODE === "light" ? "light" : "full";
	if (!sideMatches(conditions.include, ctx, mode, delegation)) return false;
	switch (conditions.exclusion.kind) {
		case "none":
			return true;
		case "side":
			return !sideMatches(conditions.exclusion.side, ctx, mode, delegation);
		default: {
			const unreachable: never = conditions.exclusion;
			return unreachable;
		}
	}
}
