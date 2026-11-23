import { createHash } from "node:crypto";
import {
	type CredentialRankingContext,
	type CredentialRankingStrategy,
	resolveUsedFraction,
	type UsageHistoryEntry,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import type { Calibration } from "./store.ts";

// @upstream verbatim @oh-my-pi/pi-ai@19.1.0 src/auth/usage-report.ts#reserveUsageLimits
export function reserveUsageLimits(
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

// @upstream adapted @oh-my-pi/pi-ai@19.1.0 src/auth/usage-report.ts#scopedUsageLimits
// Not exported: only reserveUsageLimits in this file calls it.
function scopedUsageLimits(strategy: CredentialRankingStrategy, report: UsageReport, context: CredentialRankingContext): UsageLimit[] {
	return strategy.scopeLimits?.(report, context) ?? report.limits;
}
// @upstream-end

export function limitKey(provider: string, accountKey: string, limit: UsageLimit): string {
	const account = createHash("sha256").update(accountKey).digest("hex").slice(0, 16);
	return `${provider}|${account}|${limit.id}|${limit.window?.id ?? ""}`;
}

export function historyByProvider(history: readonly UsageHistoryEntry[]): ReadonlyMap<string, readonly UsageHistoryEntry[]> {
	const grouped = new Map<string, UsageHistoryEntry[]>();
	for (const entry of history) {
		const rows = grouped.get(entry.provider);
		if (rows === undefined) grouped.set(entry.provider, [entry]);
		else rows.push(entry);
	}
	return grouped;
}

export function accountKeysOf(
	reports: readonly UsageReport[],
	history: ReadonlyMap<string, readonly UsageHistoryEntry[]>,
): ReadonlyMap<UsageReport, string | undefined> {
	const keys = new Map<UsageReport, string | undefined>();
	for (const report of reports) keys.set(report, accountKeyOf(report, history.get(report.provider) ?? []));
	return keys;
}

function onlyAccountKey(rows: readonly UsageHistoryEntry[], test: (entry: UsageHistoryEntry) => boolean): string | undefined {
	let found: string | undefined;
	for (const entry of rows) {
		if (!test(entry)) continue;
		if (found === undefined) found = entry.accountKey;
		else if (found !== entry.accountKey) return undefined;
	}
	return found;
}

function accountKeyOf(report: UsageReport, own: readonly UsageHistoryEntry[]): string | undefined {
	const metadata = report.metadata ?? {};
	const accountId = typeof metadata.accountId === "string" ? metadata.accountId : report.limits[0]?.scope.accountId;
	const email = typeof metadata.email === "string" ? metadata.email : undefined;
	if (accountId !== undefined) {
		const key = onlyAccountKey(own, (entry) => entry.accountId === accountId);
		if (key !== undefined) return key;
	}
	if (email !== undefined) {
		const key = onlyAccountKey(own, (entry) => entry.email === email);
		if (key !== undefined) return key;
	}
	return onlyAccountKey(own, (entry) => entry.recordedAt === report.fetchedAt);
}

export type LimitBinding = { readonly label: string; readonly remainingFraction: number; readonly resetsAt: number | undefined };

export type AccountQuota =
	| { readonly kind: "priced"; readonly usd: number; readonly binding: LimitBinding }
	| { readonly kind: "pending"; readonly reason: string };

type Pool = { readonly kind: "unreported" } | { readonly kind: "accounts"; readonly accounts: readonly AccountQuota[] };

function accountQuota(
	report: UsageReport,
	strategy: CredentialRankingStrategy | undefined,
	modelId: string,
	accountKey: string | undefined,
	quota: Calibration["quota"],
	now: number,
): AccountQuota {
	if (accountKey === undefined) return { kind: "pending", reason: "account not matched to its usage history" };
	let cheapest: { usd: number; binding: LimitBinding } | undefined;
	for (const limit of reserveUsageLimits(strategy, report, { modelId })) {
		const resetsAt = limit.window?.resetsAt;
		if (resetsAt !== undefined && resetsAt <= now && report.fetchedAt < resetsAt) continue;
		const used = resolveUsedFraction(limit);
		if (used === undefined) continue;
		const key = limitKey(report.provider, accountKey, limit);
		const constant = quota.constants[key];
		if (constant === undefined) return { kind: "pending", reason: `${limit.label}: ${quota.missing[key] ?? "not calibrated yet"}` };
		const remainingFraction = Math.max(0, 1 - used);
		const usd = remainingFraction * constant.usdPer100;
		if (cheapest === undefined || usd < cheapest.usd) cheapest = { usd, binding: { label: limit.label, remainingFraction, resetsAt } };
	}
	return cheapest === undefined ? { kind: "pending", reason: "no quota limit applies to this model" } : { kind: "priced", ...cheapest };
}

export function poolFor(
	reports: readonly UsageReport[],
	accountKeys: ReadonlyMap<UsageReport, string | undefined>,
	quota: Calibration["quota"],
	provider: string,
	modelId: string,
	now: number,
): Pool {
	const strategy = defaultRankingStrategy(provider);
	const gate = strategy?.planGate?.({ modelId });
	const own = reports.filter((report) => report.provider === provider && gate?.(report) !== false);
	if (own.length === 0) return { kind: "unreported" };
	return {
		kind: "accounts",
		accounts: own.map((report) => accountQuota(report, strategy, modelId, accountKeys.get(report), quota, now)),
	};
}
