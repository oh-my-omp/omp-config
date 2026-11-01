// Which scanned dispatches count, shared by the machine-wide averages (calibrate.ts) and the per-project
// estimate (index.ts): both read the scan worker's records, so one rule decides eligibility.
import * as path from "node:path";
import type { ScannedDispatch } from "./records.ts";

/** One agent's first model: the only model whose dispatches count. */
export type Target = {
	readonly agent: string;
	readonly provider: string;
	readonly modelId: string;
	/** Thinking level the binding or definition fixes; undefined matches any. */
	readonly thinking: string | undefined;
};

/** The per-project estimate uses every eligible dispatch whose transcript changed within this many days. */
export const OBSERVED_WINDOW_DAYS = 21;
const OBSERVED_WINDOW_MS = OBSERVED_WINDOW_DAYS * 24 * 3_600_000;
/** A transcript without `session_exit` counts as settled once untouched this long. */
const SETTLED_MS = 30 * 60 * 1000;
const THINKING = /:(off|minimal|low|medium|high|xhigh|max)(?=@|$)/;

/** A dispatch that ran wholly on the model its `session_init` resolved, with no fallback, and has ended. */
export type Eligible = { readonly model: string; readonly provider: string; readonly thinking: string; readonly usd: number };

/** Splits `openai-codex/gpt-5.6-sol:high@route` into `openai-codex/gpt-5.6-sol` and `high`. */
function parseResolved(resolvedModel: string): { readonly model: string; readonly thinking: string } {
	const thinking = THINKING.exec(resolvedModel)?.[1] ?? "";
	const model = resolvedModel.replace(THINKING, "").split("@")[0] ?? "";
	return { model, thinking };
}

export function eligible(dispatch: ScannedDispatch, now: number): Eligible | undefined {
	if (dispatch.fallback || (!dispatch.exited && now - dispatch.mtimeMs < SETTLED_MS)) return undefined;
	const { model, thinking } = parseResolved(dispatch.resolvedModel);
	const [only] = dispatch.models;
	if (dispatch.models.length !== 1 || only !== model) return undefined;
	const provider = model.slice(0, model.indexOf("/"));
	return { model, provider, thinking, usd: dispatch.costByProvider[provider] ?? 0 };
}

/**
 * USD of every eligible dispatch per target agent, from transcripts under the pooled session directories
 * that changed within OBSERVED_WINDOW_DAYS.
 */
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
		if (!counted || counted.model !== `${target.provider}/${target.modelId}`) continue;
		if (target.thinking !== undefined && counted.thinking !== target.thinking) continue;
		costs.get(dispatch.agent)?.push(counted.usd);
	}
	return costs;
}
