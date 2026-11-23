import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { DAY_MS, modelKey, parseModelKey } from "./keys.ts";
import type { ScannedDispatch } from "./records.ts";

export type Target = {
	readonly agent: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinking: string | undefined;
};

export const OBSERVED_WINDOW_DAYS = 21;
const OBSERVED_WINDOW_MS = OBSERVED_WINDOW_DAYS * DAY_MS;
const SETTLED_MS = 30 * 60 * 1000;
const THINKING = new RegExp(
	`:(${Object.values(ThinkingLevel)
		.filter((level) => level !== ThinkingLevel.Inherit)
		.join("|")})(?=@|$)`,
);

type Eligible = { readonly model: string; readonly provider: string; readonly thinking: string; readonly usd: number };

function parseResolved(resolvedModel: string): { readonly model: string; readonly thinking: string } {
	const matched = THINKING.exec(resolvedModel);
	const thinking = matched?.[1] ?? "";
	const named = resolvedModel.replace(THINKING, "");
	const at = named.indexOf("@");
	return { model: at === -1 ? named : named.slice(0, at), thinking };
}

export function eligible(dispatch: ScannedDispatch, now: number): Eligible | undefined {
	if (dispatch.fallback || (!dispatch.exited && now - dispatch.mtimeMs < SETTLED_MS)) return undefined;
	const { model, thinking } = parseResolved(dispatch.resolvedModel);
	const [only] = dispatch.models;
	const ref = parseModelKey(model);
	if (dispatch.models.length !== 1 || only !== model || ref === undefined) return undefined;
	return { model, provider: ref.provider, thinking, usd: dispatch.costByProvider[ref.provider] ?? 0 };
}

export function observedCosts(
	dispatches: readonly ScannedDispatch[],
	dirs: readonly string[],
	targets: readonly Target[],
	now: number,
): ReadonlyMap<string, readonly number[]> {
	const prefixes = dirs.map((dir) => `${path.resolve(dir)}${path.sep}`);
	const byAgent = new Map(targets.map((target) => [target.agent, target]));
	const costs = new Map<string, number[]>(targets.map((target) => [target.agent, []]));
	for (const dispatch of dispatches) {
		if (now - dispatch.mtimeMs > OBSERVED_WINDOW_MS) continue;
		const target = byAgent.get(dispatch.agent);
		if (!target || !prefixes.some((prefix) => dispatch.file.startsWith(prefix))) continue;
		const counted = eligible(dispatch, now);
		if (!counted || counted.model !== modelKey({ provider: target.provider, id: target.modelId })) continue;
		if (target.thinking !== undefined && counted.thinking !== target.thinking) continue;
		costs.get(dispatch.agent)?.push(counted.usd);
	}
	return costs;
}
