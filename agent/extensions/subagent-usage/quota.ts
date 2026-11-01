// Remaining provider quota for one model, converted to USD with the hardcoded per-limit constants.
import {
	type CredentialRankingContext,
	type CredentialRankingStrategy,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import { USD_PER_LIMIT } from "./calibration.ts";

// The binary maps `@oh-my-pi/pi-ai/usage/*` for extensions but not `@oh-my-pi/pi-ai/auth/*`.
// @upstream adapted @oh-my-pi/pi-ai@18.13.2 src/auth/usage-report.ts#reserveUsageLimits
/** Select usage limits for account reserve evaluation. */
function reserveUsageLimits(
	strategy: CredentialRankingStrategy | undefined,
	report: UsageReport,
	rankingContext: CredentialRankingContext,
): UsageLimit[] {
	if (strategy) {
		return strategy.scopeLimitsForReserve?.(report, rankingContext) ?? scopedUsageLimits(strategy, report, rankingContext);
	}
	return report.limits.filter((limit) => {
		const modelId = limit.scope.modelId;
		return modelId === undefined || rankingContext.modelId === undefined || modelId === rankingContext.modelId;
	});
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-ai@18.13.2 src/auth/usage-report.ts#scopedUsageLimits
/** Return the usage limits that apply to the requested model for this strategy. */
function scopedUsageLimits(strategy: CredentialRankingStrategy, report: UsageReport, context: CredentialRankingContext): UsageLimit[] {
	return strategy.scopeLimits?.(report, context) ?? report.limits;
}
// @upstream-end

/** The applicable limit that leaves an account the least USD. */
export type Binding = { readonly label: string; readonly remainingFraction: number; readonly resetsAt: number | undefined };

export type Quota =
	/** No report for the provider: no usage endpoint, or every fetch failed. */
	| { readonly kind: "unreported" }
	/** Reports exist but no applicable limit has a calibration constant. */
	| { readonly kind: "uncalibrated"; readonly limits: readonly string[] }
	| {
			readonly kind: "calibrated";
			/** Sum over accounts of each account's smallest applicable remaining USD. */
			readonly usd: number;
			readonly accounts: number;
			/** Binding limit per account, account order. */
			readonly bindings: readonly Binding[];
			/** Applicable limits skipped for lack of a constant. */
			readonly uncalibrated: readonly string[];
	  };

/**
 * Per account (one report each): keep the limits the provider strategy applies to `modelId` for
 * reserve checks, drop windows whose reset already passed, and price each limit's remaining
 * fraction with its constant; the account contributes its smallest one. Accounts the strategy's
 * plan gate rejects for the model are skipped. Accounts are summed because omp routes each
 * request to an account with headroom.
 */
export function quotaFor(reports: readonly UsageReport[], provider: string, modelId: string, now: number): Quota {
	const strategy = defaultRankingStrategy(provider);
	const gate = strategy?.planGate?.({ modelId });
	const own = reports.filter((report) => report.provider === provider && gate?.(report) !== false);
	if (own.length === 0) return { kind: "unreported" };
	const uncalibrated = new Set<string>();
	const bindings: Binding[] = [];
	let usd = 0;
	for (const report of own) {
		let account: { usd: number; binding: Binding } | undefined;
		for (const limit of reserveUsageLimits(strategy, report, { modelId })) {
			const resetsAt = limit.window?.resetsAt;
			if (resetsAt !== undefined && resetsAt <= now && report.fetchedAt < resetsAt) continue;
			const used = resolveUsedFraction(limit);
			if (used === undefined) continue;
			const key = `${provider}|${limit.id}|${limit.window?.id ?? ""}`;
			const perWindow = USD_PER_LIMIT[key];
			if (perWindow === undefined) {
				uncalibrated.add(key);
				continue;
			}
			const remainingFraction = Math.max(0, 1 - used);
			const remaining = remainingFraction * perWindow;
			if (account === undefined || remaining < account.usd) {
				account = { usd: remaining, binding: { label: limit.label, remainingFraction, resetsAt } };
			}
		}
		if (account === undefined) continue;
		usd += account.usd;
		bindings.push(account.binding);
	}
	if (bindings.length === 0) return { kind: "uncalibrated", limits: [...uncalibrated] };
	return { kind: "calibrated", usd, accounts: bindings.length, bindings, uncalibrated: [...uncalibrated] };
}
