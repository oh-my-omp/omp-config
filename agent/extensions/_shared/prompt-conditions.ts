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
 * When a system-prompt fragment or rule applies: inclusion keys `target`,
 * `cwd`, `model`, `provider`, `mode`, `delegation`, and the same keys under
 * `exclude.`. `target` / `cwd` / `model` / `provider` follow
 * `session-filter.ts`; `mode` is a comma list of `full` and `light`, the
 * current mode being `light` when `OMOMP_MODE=light` (set by `omp-light`) and
 * `full` otherwise; `delegation` is a comma list of the host's delegation-bias
 * tiers (`eager`, `restrained`, `gated`), tested against the bias OMP resolves
 * for the session's current model, the value that decides which
 * delegation wording OMP renders into the prompt. Inclusion keys must all
 * match; the exclusion, which exists only when an `exclude.*` key is set,
 * excludes when all of its keys match, and without `exclude.target` it covers
 * every session. `model` / `provider` / `delegation` test the session's
 * current model; with none, such a constraint matches on neither side.
 * The default inclusion target belongs to the caller, and so does resolving
 * the delegation bias: host packages are imported here for types only,
 * because the standalone updater (`omp-config-update.ts`, run by plain `bun`
 * outside omp) loads this module through `legacy-system-replacements.ts`, and
 * a runtime host import fails to load there.
 */
type Mode = "full" | "light";

/** Every value a comma-list key accepts; a `Record` over the union, so a value the host adds or drops fails to compile. */
type Choices<T extends string> = Readonly<Record<T, true>>;

const MODES: Choices<Mode> = { full: true, light: true };
const DELEGATION_BIASES: Choices<DelegationBias> = { eager: true, restrained: true, gated: true };

interface Side {
	readonly filter: SessionFilter;
	/** Null: any mode. */
	readonly modes: readonly Mode[] | null;
	/** Null: any delegation bias. */
	readonly delegations: readonly DelegationBias[] | null;
}

type Exclusion = { readonly kind: "none" } | { readonly kind: "side"; readonly side: Side };

export interface SessionConditions {
	readonly include: Side;
	readonly exclusion: Exclusion;
}

/** `badChoice`: a comma-list key (`mode`, `delegation`) named `value`, which is not one of `allowed`. */
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

/** Every condition key, as the caller must accept it beside its own keys. */
export const CONDITION_KEYS: readonly string[] = [...Object.values(INCLUDE_KEYS), ...Object.values(EXCLUDE_KEYS)];

type Parsed<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly problem: ConditionProblem };

function isChoice<T extends string>(choices: Choices<T>, value: string): value is T {
	return Object.hasOwn(choices, value);
}

/** A comma list of `choices`, compared lowercased; absent means any. */
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

/** `fields` maps condition keys (lowercase, as listed in CONDITION_KEYS) to their values, written in `syntax`. */
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

/** `delegation`: the bias OMP resolves for `ctx.model` (`resolveDelegationBias`), undefined without a current model. */
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
