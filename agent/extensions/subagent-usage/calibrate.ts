import type { UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { channelsOf } from "./channels.ts";
import { DAY_MS, HOUR_MS, modelKey, parseModelKey, priorAgentKey, priorModelKey } from "./keys.ts";
import { accountKeysOf, historyByProvider, limitKey, reserveUsageLimits } from "./quota.ts";
import type { ScannedDispatch, ScanRequest, ScanResult } from "./records.ts";
import { eligible } from "./samples.ts";
import { type Calibration, type Prior, readCalibration, scanCachePath, writeCalibration } from "./store.ts";

export const QUOTA_WINDOW_DAYS = 21;
export const QUOTA_WINDOW_MS = QUOTA_WINDOW_DAYS * DAY_MS;
export const QUOTA_MAX_AGE_MS = DAY_MS;
const DAY_HOURS = DAY_MS / HOUR_MS;
const MAX_PAIR_SPAN_MS = 3 * HOUR_MS;
const ACTIVE_SPREAD_HOURS = 3;
const MIN_PRIOR_SAMPLES = 3;
const MIN_SIGMA_GROUP = 5;
const MIN_SIGMA_FREEDOM = 10;
const MIN_DAY_DELTA = 0.05;
const MIN_QUALIFYING_DAYS = 3;

type CalibrationMode = "full" | "quota";
type ScanDone = Extract<ScanResult, { kind: "done" }>;
type HourlySpend = Readonly<Record<string, number>>;
type QuotaConstant = Calibration["quota"]["constants"][string];

export type CalibrationOutcome =
	| { readonly kind: "ready"; readonly calibration: Calibration; readonly scan: ScanDone }
	| { readonly kind: "declined" }
	| { readonly kind: "failed"; readonly reason: string };

type Totals = { n: number; total: number };
type Spread = Totals & { logs: number[] };

function priorsFrom(dispatches: readonly ScannedDispatch[], trackedModels: ReadonlySet<string>, now: number): Calibration["dispatch"] {
	const byAgent = new Map<string, Spread>();
	const byModel = new Map<string, Totals>();
	for (const dispatch of dispatches) {
		const counted = eligible(dispatch, now);
		if (!counted || !trackedModels.has(counted.model)) continue;
		const agentKey = priorAgentKey(dispatch.agent, counted.model, counted.thinking);
		const agent = byAgent.get(agentKey) ?? { n: 0, total: 0, logs: [] };
		agent.n += 1;
		agent.total += counted.usd;
		if (counted.usd > 0) agent.logs.push(Math.log(counted.usd));
		byAgent.set(agentKey, agent);
		const priorKey = priorModelKey(counted.model, counted.thinking);
		const model = byModel.get(priorKey) ?? { n: 0, total: 0 };
		model.n += 1;
		model.total += counted.usd;
		byModel.set(priorKey, model);
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
	return {
		generatedAt: now,
		sigma: freedom >= MIN_SIGMA_FREEDOM ? Math.sqrt(squares / freedom) : null,
		byAgent: table(byAgent),
		byModel: table(byModel),
	};
}

type Series = { readonly delta: Map<number, number>; readonly covered: Set<number>; readonly active: Set<number> };
type AccountActivity = { readonly active: Set<number>; readonly covered: Set<number>; readonly moved: Map<number, number> };

function seriesOf(entries: readonly UsageHistoryEntry[]): Series {
	const delta = new Map<number, number>();
	const covered = new Set<number>();
	const active = new Set<number>();
	for (const entry of entries) {
		const hour = Math.floor(entry.recordedAt / HOUR_MS);
		for (let offset = -ACTIVE_SPREAD_HOURS; offset <= ACTIVE_SPREAD_HOURS; offset++) active.add(hour + offset);
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

function seriesId(limitId: string, windowLabel: string | undefined): string {
	return `${limitId}|${windowLabel ?? ""}`;
}

function limitSeriesByAccount(entries: readonly UsageHistoryEntry[]): ReadonlyMap<string, ReadonlyMap<string, Series>> {
	const grouped = new Map<string, Map<string, UsageHistoryEntry[]>>();
	for (const entry of entries) {
		if (entry.usedFraction === undefined) continue;
		const limits = grouped.get(entry.accountKey) ?? new Map<string, UsageHistoryEntry[]>();
		grouped.set(entry.accountKey, limits);
		const id = seriesId(entry.limitId, entry.windowLabel);
		const rows = limits.get(id) ?? [];
		rows.push(entry);
		limits.set(id, rows);
	}
	const bySeries = new Map<string, ReadonlyMap<string, Series>>();
	for (const [account, limits] of grouped) {
		const series = new Map<string, Series>();
		for (const [id, rows] of limits) series.set(id, seriesOf(rows.sort((a, b) => a.recordedAt - b.recordedAt)));
		bySeries.set(account, series);
	}
	return bySeries;
}

function lowQuartile(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) * 0.25)] ?? Number.NaN;
}

type LimitPrice = { readonly kind: "priced"; readonly constant: QuotaConstant } | { readonly kind: "missing"; readonly reason: string };

function priceLimit(series: Series, others: readonly AccountActivity[], spend: readonly HourlySpend[], sinceMs: number): LimitPrice {
	let usd = 0;
	let moved = 0;
	let hours = 0;
	const days = new Map<number, { usd: number; moved: number }>();
	for (const hour of series.covered) {
		if (hour * HOUR_MS < sinceMs) continue;
		const othersIdle = others.every((other) => !other.active.has(hour) || (other.covered.has(hour) && (other.moved.get(hour) ?? 0) === 0));
		if (!othersIdle) continue;
		const slot = String(hour);
		const hourUsd = spend.reduce((sum, model) => sum + (model[slot] ?? 0), 0);
		const hourMoved = series.delta.get(hour) ?? 0;
		usd += hourUsd;
		moved += hourMoved;
		hours++;
		const day = Math.floor(hour / DAY_HOURS);
		const total = days.get(day) ?? { usd: 0, moved: 0 };
		days.set(day, { usd: total.usd + hourUsd, moved: total.moved + hourMoved });
	}
	const daily = [...days.values()].filter((day) => day.moved >= MIN_DAY_DELTA).map((day) => day.usd / day.moved);
	if (daily.length < MIN_QUALIFYING_DAYS) {
		return {
			kind: "missing",
			reason: `insufficient history: ${daily.length} of ${MIN_QUALIFYING_DAYS} days with attributable movement`,
		};
	}
	const usdPer100 = Math.min(usd / moved, lowQuartile(daily));
	if (!(usdPer100 > 0)) return { kind: "missing", reason: "no local spend matched this limit's movement" };
	return { kind: "priced", constant: { usdPer100, hours, days: daily.length } };
}

type QuotaInput = {
	readonly spend: ScanDone["spend"];
	readonly reports: readonly UsageReport[];
	readonly history: ReadonlyMap<string, readonly UsageHistoryEntry[]>;
	readonly accountKeys: ReadonlyMap<UsageReport, string | undefined>;
	readonly trackedProviders: ReadonlySet<string>;
	readonly trackedModels: ReadonlySet<string>;
	readonly sinceMs: number;
	readonly now: number;
};

function quotaFrom(input: QuotaInput): Calibration["quota"] {
	const { spend, sinceMs, now } = input;
	const constants: Record<string, QuotaConstant> = {};
	const missing: Record<string, string> = {};
	for (const provider of input.trackedProviders) {
		const own = input.reports.filter((report) => report.provider === provider);
		if (own.length === 0) continue;
		const strategy = defaultRankingStrategy(provider);
		const series = limitSeriesByAccount(input.history.get(provider) ?? []);
		const activity = [...series].map(([account, limits]) => ({ account, activity: activityOf(limits.values()) }));
		const models = Object.keys(spend).flatMap((key) => {
			const ref = parseModelKey(key);
			return ref?.provider === provider && input.trackedModels.has(key) ? [ref.id] : [];
		});
		for (const report of own) {
			const account = input.accountKeys.get(report);
			if (account === undefined) continue;
			const others = activity.flatMap((entry) => (entry.account === account ? [] : [entry.activity]));
			for (const limit of report.limits) {
				const window = limit.window;
				if (!window) continue;
				const key = limitKey(provider, account, limit);
				const limitSeries = series.get(account)?.get(seriesId(limit.id, window.label));
				if (!limitSeries) {
					missing[key] = "no usage history for this limit in the window";
					continue;
				}
				const covered = models.flatMap((modelId) =>
					reserveUsageLimits(strategy, report, { modelId }).some((scoped) => scoped.id === limit.id && scoped.window?.id === window.id)
						? [spend[modelKey({ provider, id: modelId })] ?? {}]
						: [],
				);
				const price = priceLimit(limitSeries, others, covered, sinceMs);
				switch (price.kind) {
					case "priced":
						constants[key] = price.constant;
						break;
					case "missing":
						missing[key] = price.reason;
						break;
					default: {
						const never: never = price;
						return never;
					}
				}
			}
		}
	}
	return { generatedAt: now, sinceMs, constants, missing };
}

let worker: Worker | undefined;
let scanning: Promise<ScanResult> | undefined;
let running: { readonly mode: CalibrationMode; readonly outcome: Promise<CalibrationOutcome> } | undefined;

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
	scanner.addEventListener("close", () => finish({ kind: "failed", reason: "scan stopped" }));
	const request: ScanRequest = { sessionsRoot: getSessionsDir(), cachePath: scanCachePath() };
	scanner.postMessage(request);
	return promise;
}

export function scanTranscripts(): Promise<ScanResult> {
	if (scanning) return scanning;
	const run = runScan().finally(() => {
		if (scanning === run) scanning = undefined;
	});
	scanning = run;
	return run;
}

export function stopCalibration(): void {
	worker?.terminate();
	worker = undefined;
	scanning = undefined;
	running = undefined;
}

async function calibrateOnce(session: AgentSession, mode: CalibrationMode, consented: () => Promise<boolean>): Promise<CalibrationOutcome> {
	if (!(await consented())) return { kind: "declined" };
	const scan = await scanTranscripts();
	if (scan.kind === "failed") return { kind: "failed", reason: scan.reason };
	const now = Date.now();
	const sinceMs = now - QUOTA_WINDOW_MS;
	const reports = (await session.fetchUsageReports()) ?? [];
	const history = historyByProvider(session.modelRegistry.authStorage.usage.history({ sinceMs }));
	const channels = channelsOf(session);
	const providers = new Set([
		...reports.map((report) => report.provider),
		...Object.keys(scan.spend).flatMap((key) => parseModelKey(key)?.provider ?? []),
	]);
	const trackedProviders = new Set([...providers].filter((provider) => channels.provider(provider).kind === "tracked"));
	const models = new Set([...scan.dispatches.flatMap((dispatch) => dispatch.models), ...Object.keys(scan.spend)]);
	const trackedModels = new Set(
		[...models].filter((model) => {
			const ref = parseModelKey(model);
			return ref !== undefined && channels.model(ref).kind === "tracked";
		}),
	);
	const stored = readCalibration();
	const calibration: Calibration = {
		schema: 1,
		dispatch: mode === "quota" && stored.kind === "ready" ? stored.calibration.dispatch : priorsFrom(scan.dispatches, trackedModels, now),
		quota: quotaFrom({
			spend: scan.spend,
			reports,
			history,
			accountKeys: accountKeysOf(reports, history),
			trackedProviders,
			trackedModels,
			sinceMs,
			now,
		}),
	};
	if (!(await consented())) return { kind: "declined" };
	writeCalibration(calibration);
	return { kind: "ready", calibration, scan };
}

export async function calibrate(
	session: AgentSession,
	mode: CalibrationMode,
	consented: () => Promise<boolean>,
): Promise<CalibrationOutcome> {
	for (let current = running; current !== undefined; current = running) {
		if (current.mode === "full" || mode === "quota") return current.outcome;
		await Promise.allSettled([current.outcome]);
	}
	const outcome = calibrateOnce(session, mode, consented).finally(() => {
		if (running?.outcome === outcome) running = undefined;
	});
	running = { mode, outcome };
	return outcome;
}
