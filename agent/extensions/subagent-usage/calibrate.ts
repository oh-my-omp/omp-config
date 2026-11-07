// Calibration from this machine's own data, run only with consent. The scan worker reads the transcripts;
// this module turns its aggregates plus usage history and live reports into per-dispatch priors (computed when
// the feature is enabled and on `recalibrate`) and per-account quota constants (a trailing window, refreshed
// daily). Deterministic code only: no model is called.
import type { UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { channelsOf } from "./channels.ts";
import { accountKeysOf, historyByProvider, limitKey, reserveUsageLimits } from "./quota.ts";
import type { ScannedDispatch, ScanRequest, ScanResult } from "./records.ts";
import { eligible } from "./samples.ts";
import { type Calibration, type Prior, readCalibration, scanCachePath, writeCalibration } from "./store.ts";

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
/** Quota constants use this trailing window, so plan or quota changes age out within it. */
export const QUOTA_WINDOW_MS = 21 * 24 * HOUR_MS;
/** Quota constants older than this are refreshed before use. */
export const QUOTA_MAX_AGE_MS = 24 * HOUR_MS;
/** Snapshot pairs further apart than this are not attributed. */
const MAX_PAIR_SPAN_MS = 3 * HOUR_MS;
/** A prior needs this many local dispatches. */
const MIN_PRIOR_SAMPLES = 3;
/** Groups with this many priced dispatches feed the pooled sigma. */
const MIN_SIGMA_GROUP = 5;
/** A day counts toward the low quantile when the account's limit moved at least this much. */
const MIN_DAY_DELTA = 0.05;
const MIN_QUALIFYING_DAYS = 3;

type CalibrationMode = "full" | "quota";

export type CalibrationOutcome =
	| {
			readonly kind: "ready";
			readonly calibration: Calibration;
			readonly files: number;
			readonly parsed: number;
			/** The scan this run used, so a caller that also needs the aggregates does not scan a second time. */
			readonly scan?: ScanResult;
	  }
	/** Consent was off when the run would have started or committed; nothing was written. */
	| { readonly kind: "declined" }
	| { readonly kind: "failed"; readonly reason: string };

/** Running totals of a group's dispatch costs; the per-agent log values feed the pooled spread. */
type Totals = { n: number; total: number };
type Spread = Totals & { logs: number[] };

/**
 * Mean USD per eligible dispatch by agent+model+thinking and model+thinking, and the pooled log spread.
 * Each group accumulates its total in dispatch order, so the means match summing the whole list.
 */
function priorsFrom(dispatches: readonly ScannedDispatch[], trackedModels: ReadonlySet<string>, now: number): Calibration["dispatch"] {
	const byAgent = new Map<string, Spread>();
	const byModel = new Map<string, Totals>();
	for (const dispatch of dispatches) {
		const counted = eligible(dispatch, now);
		if (!counted || !trackedModels.has(counted.model)) continue;
		const agentKey = `${dispatch.agent}|${counted.model}|${counted.thinking}`;
		const agent = byAgent.get(agentKey);
		if (agent === undefined) {
			byAgent.set(agentKey, { n: 1, total: counted.usd, logs: counted.usd > 0 ? [Math.log(counted.usd)] : [] });
		} else {
			agent.n += 1;
			agent.total += counted.usd;
			if (counted.usd > 0) agent.logs.push(Math.log(counted.usd));
		}
		const modelKey = `${counted.model}|${counted.thinking}`;
		const model = byModel.get(modelKey);
		if (model === undefined) byModel.set(modelKey, { n: 1, total: counted.usd });
		else {
			model.n += 1;
			model.total += counted.usd;
		}
	}
	const table = (groups: ReadonlyMap<string, Totals>): Record<string, Prior> => {
		const out: Record<string, Prior> = {};
		for (const [key, totals] of groups) {
			if (totals.n >= MIN_PRIOR_SAMPLES) out[key] = { usd: totals.total / totals.n, n: totals.n };
		}
		return out;
	};
	let squares = 0;
	let freedom = 0;
	for (const { logs } of byAgent.values()) {
		if (logs.length < MIN_SIGMA_GROUP) continue;
		const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
		squares += logs.reduce((sum, value) => sum + (value - mean) ** 2, 0);
		freedom += logs.length - 1;
	}
	return { generatedAt: now, sigma: freedom >= 10 ? Math.sqrt(squares / freedom) : null, byAgent: table(byAgent), byModel: table(byModel) };
}

type Series = { readonly delta: Map<number, number>; readonly covered: Set<number>; readonly active: Set<number> };
type AccountActivity = { readonly active: Set<number>; readonly covered: Set<number>; readonly moved: Map<number, number> };

/**
 * Hourly increase of one limit's used fraction from same-reset snapshot pairs at most 3 h apart, plus the hours
 * near its snapshots and the hours its pairs cover. One call per limit feeds both the account's activity and the
 * constant, which read the same series twice before.
 */
function seriesOf(entries: readonly UsageHistoryEntry[]): Series {
	const delta = new Map<number, number>();
	const covered = new Set<number>();
	const active = new Set<number>();
	for (const entry of entries) {
		const hour = Math.floor(entry.recordedAt / HOUR_MS);
		for (let offset = -3; offset <= 3; offset++) active.add(hour + offset);
	}
	for (let index = 1; index < entries.length; index++) {
		const before = entries[index - 1];
		const after = entries[index];
		if (!before || !after || before.usedFraction === undefined || after.usedFraction === undefined) continue;
		const sameWindow =
			before.resetsAt !== undefined && after.resetsAt !== undefined
				? Math.abs(before.resetsAt - after.resetsAt) < HOUR_MS
				: before.resetsAt === after.resetsAt;
		const moved = after.usedFraction - before.usedFraction;
		const span = after.recordedAt - before.recordedAt;
		if (!sameWindow || moved < 0 || span <= 0 || span > MAX_PAIR_SPAN_MS) continue;
		const first = Math.floor(before.recordedAt / HOUR_MS);
		const last = Math.floor(after.recordedAt / HOUR_MS);
		for (let hour = first; hour <= last; hour++) {
			delta.set(hour, (delta.get(hour) ?? 0) + moved / (last - first + 1));
			covered.add(hour);
		}
	}
	return { delta, covered, active };
}

/** Per account: hours near any snapshot, hours covered by some limit's pairs, and summed movement per hour. */
function activityOf(limits: Iterable<Series>): AccountActivity {
	const active = new Set<number>();
	const covered = new Set<number>();
	const moved = new Map<number, number>();
	for (const limit of limits) {
		for (const hour of limit.active) active.add(hour);
		for (const hour of limit.covered) covered.add(hour);
		for (const [hour, value] of limit.delta) moved.set(hour, (moved.get(hour) ?? 0) + value);
	}
	return { active, covered, moved };
}

/** 25th percentile by nearest rank. */
function lowQuartile(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) * 0.25)] ?? Number.NaN;
}

/**
 * USD of local spend per 100% of each account's limit. An hour counts when the account's limit has a pair
 * covering it and every other account of the provider is covered and idle then; its spend is this machine's
 * spend on the models the provider strategy scopes to that limit for that account. The constant is the smaller
 * of the overall ratio and the 25th percentile of daily ratios (days moving at least 5%, three or more).
 */
function quotaFrom(
	spend: Readonly<Record<string, Readonly<Record<string, number>>>>,
	reports: readonly UsageReport[],
	history: ReadonlyMap<string, readonly UsageHistoryEntry[]>,
	accountKeys: ReadonlyMap<UsageReport, string | undefined>,
	trackedProviders: ReadonlySet<string>,
	trackedModels: ReadonlySet<string>,
	sinceMs: number,
	now: number,
): Calibration["quota"] {
	const constants: Calibration["quota"]["constants"] = {};
	const missing: Record<string, string> = {};
	for (const provider of trackedProviders) {
		const own = reports.filter((report) => report.provider === provider);
		if (own.length === 0) continue;
		const strategy = defaultRankingStrategy(provider);
		const limitsByAccount = new Map<string, Map<string, UsageHistoryEntry[]>>();
		for (const entry of history.get(provider) ?? []) {
			if (entry.usedFraction === undefined) continue;
			const limits = limitsByAccount.get(entry.accountKey) ?? new Map<string, UsageHistoryEntry[]>();
			const id = `${entry.limitId}|${entry.windowLabel ?? ""}`;
			const entries = limits.get(id) ?? [];
			entries.push(entry);
			limits.set(id, entries);
			limitsByAccount.set(entry.accountKey, limits);
		}
		// One series per limit, shared by the account's activity and by the constant computed from it.
		const series = new Map<string, Map<string, Series>>();
		const activity = new Map<string, AccountActivity>();
		for (const [account, limits] of limitsByAccount) {
			for (const entries of limits.values()) entries.sort((a, b) => a.recordedAt - b.recordedAt);
			const computed = new Map<string, Series>();
			for (const [id, entries] of limits) computed.set(id, seriesOf(entries));
			series.set(account, computed);
			activity.set(account, activityOf(computed.values()));
		}
		const models = Object.keys(spend)
			.filter((key) => key.startsWith(`${provider}/`) && trackedModels.has(key))
			.map((key) => key.slice(provider.length + 1));
		for (const report of own) {
			const account = accountKeys.get(report);
			if (account === undefined) continue;
			const others = [...activity].filter(([key]) => key !== account).map(([, value]) => value);
			for (const limit of report.limits) {
				if (!limit.window) continue;
				const key = limitKey(provider, account, limit);
				const limitSeries = series.get(account)?.get(`${limit.id}|${limit.window.label}`);
				if (!limitSeries) {
					missing[key] = "no usage history for this limit in the window";
					continue;
				}
				const covers = models.filter((modelId) =>
					reserveUsageLimits(strategy, report, { modelId }).some(
						(scoped) => scoped.id === limit.id && scoped.window?.id === limit.window?.id,
					),
				);
				let usd = 0;
				let moved = 0;
				let hours = 0;
				const days = new Map<number, { usd: number; moved: number }>();
				for (const hour of limitSeries.covered) {
					if (hour * HOUR_MS < sinceMs) continue;
					const othersIdle = others.every(
						(other) => !other.active.has(hour) || (other.covered.has(hour) && (other.moved.get(hour) ?? 0) === 0),
					);
					if (!othersIdle) continue;
					const hourUsd = covers.reduce((sum, modelId) => sum + (spend[`${provider}/${modelId}`]?.[String(hour)] ?? 0), 0);
					const hourMoved = limitSeries.delta.get(hour) ?? 0;
					usd += hourUsd;
					moved += hourMoved;
					hours++;
					const day = Math.floor(hour / DAY_HOURS);
					const total = days.get(day) ?? { usd: 0, moved: 0 };
					days.set(day, { usd: total.usd + hourUsd, moved: total.moved + hourMoved });
				}
				const daily = [...days.values()].filter((day) => day.moved >= MIN_DAY_DELTA).map((day) => day.usd / day.moved);
				if (daily.length < MIN_QUALIFYING_DAYS) {
					missing[key] = `insufficient history: ${daily.length} of ${MIN_QUALIFYING_DAYS} days with attributable movement`;
					continue;
				}
				const usdPer100 = Math.min(usd / moved, lowQuartile(daily));
				if (!(usdPer100 > 0)) {
					missing[key] = "no local spend matched this limit's movement";
					continue;
				}
				constants[key] = { usdPer100, hours, days: daily.length };
			}
		}
	}
	return { generatedAt: now, sinceMs, constants, missing };
}

let worker: Worker | undefined;
let scanning: Promise<ScanResult> | undefined;

function runScan(): Promise<ScanResult> {
	const { promise, resolve } = Promise.withResolvers<ScanResult>();
	const scanner = new Worker(new URL("./worker.ts", import.meta.url).href);
	worker = scanner;
	const finish = (result: ScanResult): void => {
		if (worker === scanner) worker = undefined;
		scanner.terminate();
		resolve(result);
	};
	scanner.onmessage = (event: MessageEvent<ScanResult>) => finish(event.data);
	scanner.onerror = (event) => finish({ kind: "failed", reason: event.message });
	// Terminated by stopCalibration before it answered.
	scanner.addEventListener("close", () => finish({ kind: "failed", reason: "scan stopped" }));
	const request: ScanRequest = { sessionsRoot: getSessionsDir(), cachePath: scanCachePath() };
	scanner.postMessage(request);
	return promise;
}

/**
 * Every transcript's aggregate, reading only the bytes appended since the cached scan. One scan per process at
 * a time: callers arriving mid-scan share it, so two workers never write the cache together.
 */
export function scanTranscripts(): Promise<ScanResult> {
	if (scanning) return scanning;
	const run = runScan().finally(() => {
		if (scanning === run) scanning = undefined;
	});
	scanning = run;
	return run;
}

/** Stops a running scan; its run then commits nothing. `/subagent-usage off` and `reset`. */
export function stopCalibration(): void {
	worker?.terminate();
	worker = undefined;
}

async function calibrateOnce(session: AgentSession, mode: CalibrationMode, consented: () => Promise<boolean>): Promise<CalibrationOutcome> {
	if (!(await consented())) return { kind: "declined" };
	const scan = await scanTranscripts();
	if (scan.kind === "failed") return { kind: "failed", reason: scan.reason };
	const now = Date.now();
	const sinceMs = now - QUOTA_WINDOW_MS;
	const reports = (await session.fetchUsageReports()) ?? [];
	const history = session.modelRegistry.authStorage.usage.history({ sinceMs });
	const index = historyByProvider(history);
	const accountKeys = accountKeysOf(reports, index);
	const channels = channelsOf(session);
	const providers = new Set([
		...reports.map((report) => report.provider),
		...Object.keys(scan.spend).map((key) => key.split("/")[0] ?? ""),
	]);
	const tracked = new Set([...providers].filter((provider) => provider && channels.provider(provider).kind === "tracked"));
	const models = new Set([...scan.dispatches.flatMap((dispatch) => dispatch.models), ...Object.keys(scan.spend)]);
	const trackedModels = new Set(
		[...models].filter((model) => {
			const separator = model.indexOf("/");
			return channels.model({ provider: model.slice(0, separator), id: model.slice(separator + 1) }).kind === "tracked";
		}),
	);
	const stored = readCalibration();
	const dispatch =
		mode === "quota" && stored.kind === "ready" ? stored.calibration.dispatch : priorsFrom(scan.dispatches, trackedModels, now);
	const calibration: Calibration = {
		schema: 1,
		dispatch,
		quota: quotaFrom(scan.spend, reports, index, accountKeys, tracked, trackedModels, sinceMs, now),
	};
	// Consent is re-read at commit: an `off` during the scan discards the result.
	if (!(await consented())) return { kind: "declined" };
	writeCalibration(calibration);
	// The scan rides along so the tool call that triggered this calibration does not read the transcripts again.
	return { kind: "ready", calibration, files: scan.files, parsed: scan.parsed, scan };
}

let running: Promise<CalibrationOutcome> | undefined;

/**
 * One calibration per process at a time; a caller arriving mid-run shares it. A `full` request that arrives
 * during a `quota` run runs again afterwards, so its priors are recomputed.
 */
export async function calibrate(
	session: AgentSession,
	mode: CalibrationMode,
	consented: () => Promise<boolean>,
): Promise<CalibrationOutcome> {
	if (running) {
		const shared = await running;
		if (mode === "quota") return shared;
	}
	// Another full run may have started while this caller waited.
	if (running) return running;
	const run = calibrateOnce(session, mode, consented).finally(() => {
		if (running === run) running = undefined;
	});
	running = run;
	return run;
}
