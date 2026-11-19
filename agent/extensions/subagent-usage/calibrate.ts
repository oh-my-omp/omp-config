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
export const QUOTA_WINDOW_MS = 21 * 24 * HOUR_MS;
export const QUOTA_MAX_AGE_MS = 24 * HOUR_MS;
const MAX_PAIR_SPAN_MS = 3 * HOUR_MS;
const MIN_PRIOR_SAMPLES = 3;
const MIN_SIGMA_GROUP = 5;
const MIN_DAY_DELTA = 0.05;
const MIN_QUALIFYING_DAYS = 3;

type CalibrationMode = "full" | "quota";

export type CalibrationOutcome =
	| {
			readonly kind: "ready";
			readonly calibration: Calibration;
			readonly files: number;
			readonly parsed: number;
			readonly scan?: ScanResult;
	  }
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

function lowQuartile(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) * 0.25)] ?? Number.NaN;
}

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
	if (!(await consented())) return { kind: "declined" };
	writeCalibration(calibration);
	return { kind: "ready", calibration, files: scan.files, parsed: scan.parsed, scan };
}

let running: Promise<CalibrationOutcome> | undefined;

export async function calibrate(
	session: AgentSession,
	mode: CalibrationMode,
	consented: () => Promise<boolean>,
): Promise<CalibrationOutcome> {
	if (running) {
		const shared = await running;
		if (mode === "quota") return shared;
	}
	if (running) return running;
	const run = calibrateOnce(session, mode, consented).finally(() => {
		if (running === run) running = undefined;
	});
	running = run;
	return run;
}
