// Per-dispatch estimate and the tool's text. The text is read by models that may be weak and inattentive:
// fixed status words lead every line, shared quota is the grouping itself, and rules come first.
import type { UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai";
import type { Binding } from "./agents.ts";
import type { Channel } from "./channels.ts";
import { type AccountQuota, type Binding as LimitBinding, poolFor } from "./quota.ts";
import type { Calibration } from "./store.ts";

export type Estimate =
	| { readonly kind: "observed"; readonly usd: number; readonly n: number }
	| { readonly kind: "prior"; readonly usd: number; readonly n: number; readonly basis: "agent" | "model" }
	| { readonly kind: "none" };

type Resolved = Extract<Binding, { kind: "resolved" }>;

/**
 * Observed dispatches win from n = 1: the lognormal mean exp(mean ln c + sigma^2 / 2) with this machine's
 * pooled sigma, or the arithmetic mean without one or when a dispatch cost 0. Without observations, this
 * machine's mean for agent+model+thinking, else model+thinking; else no estimate.
 */
export function estimate(binding: Resolved, costs: readonly number[], dispatch: Calibration["dispatch"]): Estimate {
	if (costs.length > 0) {
		const sigma = dispatch.sigma;
		const usd =
			sigma !== null && costs.every((cost) => cost > 0)
				? Math.exp(costs.reduce((sum, cost) => sum + Math.log(cost), 0) / costs.length + sigma ** 2 / 2)
				: costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
		return { kind: "observed", usd, n: costs.length };
	}
	const modelKey = `${binding.model.provider}/${binding.model.id}|${binding.thinking ?? ""}`;
	const byAgent = dispatch.byAgent[`${binding.agent}|${modelKey}`];
	if (byAgent) return { kind: "prior", usd: byAgent.usd, n: byAgent.n, basis: "agent" };
	const byModel = dispatch.byModel[modelKey];
	if (byModel) return { kind: "prior", usd: byModel.usd, n: byModel.n, basis: "model" };
	return { kind: "none" };
}

export type ReportInput = {
	readonly now: number;
	readonly calibration: Calibration;
	readonly bindings: readonly { readonly binding: Binding; readonly channel: Channel | undefined }[];
	readonly costs: ReadonlyMap<string, readonly number[]>;
	readonly reports: readonly UsageReport[];
	readonly history: readonly UsageHistoryEntry[];
};

function money(value: number): string {
	return value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function resetText(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined) return "no reset time";
	const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	return `resets in ${days > 0 ? `${days}d ` : ""}${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function day(at: number): string {
	return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function costText(cost: Exclude<Estimate, { kind: "none" }>): string {
	switch (cost.kind) {
		case "observed":
			return `${money(cost.usd)} per dispatch (from ${cost.n} recent dispatch${cost.n === 1 ? "" : "es"} in this project${cost.n < 3 ? ", low confidence" : ""})`;
		case "prior":
			return `${money(cost.usd)} per dispatch (no dispatch in this project yet; this machine's average over ${cost.n} dispatches of ${cost.basis === "agent" ? "this agent on this model" : "any agent on this model"})`;
		default: {
			const never: never = cost;
			return never;
		}
	}
}

/** The agent's line inside its pool, or why no account of the pool could be priced. */
function pooledLine(
	label: string,
	cost: Estimate,
	accounts: readonly AccountQuota[],
	now: number,
): { readonly line: string } | { readonly pending: string } {
	const priced = accounts.flatMap((account) => (account.kind === "priced" ? [account] : []));
	const pending = accounts.flatMap((account) => (account.kind === "pending" ? [account.reason] : []));
	if (priced.length === 0) return { pending: pending.join("; ") };
	const left = priced.reduce((sum, account) => sum + account.usd, 0);
	const tightest = priced.reduce<LimitBinding | undefined>(
		(lowest, account) => (lowest === undefined || account.binding.remainingFraction < lowest.remainingFraction ? account.binding : lowest),
		undefined,
	);
	const quota = [
		`${money(left)} quota left on ${priced.length} of ${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
		tightest
			? `tightest ${tightest.label} ${(tightest.remainingFraction * 100).toFixed(0)}% left, ${resetText(tightest.resetsAt, now)}`
			: "",
		pending.length > 0 ? `LOWER BOUND: not counted ${pending.join("; ")}` : "",
	]
		.filter((part) => part !== "")
		.join("; ");
	if (cost.kind === "none") return { line: `  - NO ESTIMATE ${label}: no local dispatch on this first model yet. ${quota}.` };
	const count = cost.usd > 0 ? `about ${Math.floor(left / cost.usd)} dispatches` : "zero-priced model, count not computable";
	return { line: `  - ${label}: ${count}. ${costText(cost)}. ${quota}.` };
}

export function formatReport(input: ReportInput): string {
	const { now, calibration } = input;
	const pools = new Map<string, string[]>();
	const pending: string[] = [];
	const untracked: string[] = [];
	for (const { binding, channel } of input.bindings) {
		if (binding.kind === "unresolved") {
			untracked.push(`  - ${binding.agent} (${binding.pattern ?? "no model"}): first model not in the model registry`);
			continue;
		}
		const label = `${binding.agent} (${binding.pattern})`;
		if (channel === undefined || channel.kind === "untracked") {
			untracked.push(`  - ${label}: ${channel?.reason ?? "untracked"}`);
			continue;
		}
		const pool = poolFor(input.reports, input.history, calibration.quota, binding.model.provider, binding.model.id, now);
		if (pool.kind === "unreported") {
			pending.push(`  - ${label}: no live quota report for ${binding.model.provider} right now`);
			continue;
		}
		const cost = estimate(binding, input.costs.get(binding.agent) ?? [], calibration.dispatch);
		const line = pooledLine(label, cost, pool.accounts, now);
		if ("pending" in line) {
			pending.push(`  - ${label}: ${line.pending}`);
			continue;
		}
		pools.set(binding.model.provider, [...(pools.get(binding.model.provider) ?? []), line.line]);
	}
	const sections = [
		`subagent_usage at ${day(now)} UTC. Per-dispatch averages from ${day(calibration.dispatch.generatedAt)}; quota conversion from ${day(calibration.quota.generatedAt)} over the preceding 21 days.`,
		"RULES:",
		"- Agents under one POOL share one quota. Their counts are alternatives: never add them up.",
		"- Each count assumes that pool's whole remaining quota goes to that one agent. Refills at window resets are not counted.",
		"- Only each agent's FIRST bound model is counted. Fallback models are ignored.",
		"- PENDING, NOT TRACKED and NO ESTIMATE mean there is no number. They never mean unlimited.",
		...[...pools].flatMap(([provider, lines]) => ["", `POOL ${provider}: shared quota, do not add these counts`, ...lines]),
		...(pending.length > 0 ? ["", "PENDING (quota exists but cannot be priced yet):", ...pending] : []),
		...(untracked.length > 0 ? ["", "NOT TRACKED (no computable quota; never estimated):", ...untracked] : []),
	];
	return sections.join("\n");
}
