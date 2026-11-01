// ============================================================================
// subagent-usage — the agent-side `/usage`: `subagent_usage` estimates how many
// more dispatches each available subagent definition can make before its first
// model's provider quota runs out.
//
// Registers the read-only tool `subagent_usage` in main and sub sessions; no
// hooks, commands or config. Per call it:
//   1. discovers agents like the task tool (`discoverAgents` + session agents,
//      minus `task.disabledAgents`) and resolves each one's model selection with
//      `resolveAgentModelPatterns`, keeping only the FIRST pattern: later
//      comma-separated fallbacks never enter any number;
//   2. reads finished subagent transcripts of the project's session bucket
//      (the session directory and cwd of the top-level session the caller
//      descends from, found through AgentRegistry parent links) plus
//      its git and agent-managed worktrees (`worktreeSessionDirs`), newest first
//      until each agent holds its newest 20 dispatches that ran wholly on that
//      first model with no fallback (samples.ts);
//   3. estimates USD per dispatch: with n >= 1 observed dispatches, the
//      lognormal mean exp(mean(ln cost) + sigma^2/2) with the hardcoded spread
//      sigma; with none, the hardcoded per-dispatch USD for agent+model+thinking,
//      else model+thinking, else the global mean (calibration.ts);
//   4. prices the remaining provider quota (`AgentSession.fetchUsageReports`,
//      the human `/usage` source) per account with the hardcoded USD-per-limit
//      constants, the smallest applicable limit per account, summed over
//      accounts (quota.ts), and divides.
// Reads session JSONL files and live usage reports; writes nothing.
// Failures are returned to the agent as tool errors.
// ============================================================================
import * as os from "node:os";
import type { Api, Model, UsageReport } from "@oh-my-pi/pi-ai";
import { type AgentDefinition, type AgentSession, type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { worktreeSessionDirs } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { CALIBRATED_AT, DISPATCH_USD_BY_AGENT, DISPATCH_USD_BY_MODEL, GLOBAL_DISPATCH_USD, LOG_COST_SIGMA } from "./calibration.ts";
import { type Quota, quotaFor } from "./quota.ts";
import { collectSamples, MAX_SAMPLES_PER_AGENT, type SampleScan, type Target } from "./samples.ts";

const TOOL = "subagent_usage";
const DESCRIPTION = [
	"Estimate how many more dispatches each available subagent can make before the provider quota of its first bound model runs out (the agent-side /usage).",
	"Per agent: first model of its binding (fallback models are ignored), USD per dispatch (observed from finished dispatches in this directory and its worktrees, or the built-in fallback), remaining quota priced in USD, the estimated count and the binding quota window.",
	"Counts read the current quota snapshot: refills at window resets are not counted, and agents on one provider share its quota.",
].join("\n");

const params = z.object({});
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type Binding =
	| {
			readonly kind: "resolved";
			readonly agent: string;
			readonly pattern: string;
			readonly model: Model<Api>;
			readonly thinking: string | undefined;
	  }
	| { readonly kind: "unresolved"; readonly agent: string; readonly pattern: string | undefined };

type Estimate =
	| { readonly kind: "observed"; readonly usd: number; readonly n: number }
	| { readonly kind: "fallback"; readonly usd: number; readonly basis: "agent" | "model" | "global" };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

async function availableAgents(session: AgentSession, cwd: string): Promise<AgentDefinition[]> {
	const disabled = new Set(cfgTaskDisabledAgents.get(session.settings));
	const { agents } = await discoverAgents(cwd, os.homedir(), session.effectiveExtensionRoots);
	const seen = new Set<string>();
	const out: AgentDefinition[] = [];
	// The task tool resolves a name to its first definition; later duplicates are shadowed.
	for (const agent of [...agents, ...session.getSessionAgents()]) {
		if (disabled.has(agent.name) || seen.has(agent.name)) continue;
		seen.add(agent.name);
		out.push(agent);
	}
	return out;
}

function bindAgent(session: AgentSession, agent: AgentDefinition): Binding {
	const model = session.model;
	const thinkingLevel = session.thinkingLevel;
	const activeModelPattern = model ? `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}` : undefined;
	const [pattern] = resolveAgentModelPatterns({
		settingsOverride: cfgTaskAgentModelOverrides.get(session.settings)[agent.name],
		agentModel: agent.model,
		settings: session.settings,
		activeModelPattern,
	});
	if (pattern === undefined) return { kind: "unresolved", agent: agent.name, pattern };
	// The executor resolves each pattern alone against the registry, so the first one resolves the same way here.
	const parsed = resolveModelOverride([pattern], session.modelRegistry, session.settings);
	if (!parsed.model) return { kind: "unresolved", agent: agent.name, pattern };
	const thinking = parsed.explicitThinkingLevel ? parsed.thinkingLevel : agent.thinkingLevel;
	return {
		kind: "resolved",
		agent: agent.name,
		pattern,
		model: parsed.model,
		thinking: thinking !== undefined && THINKING_LEVELS.has(thinking) ? thinking : undefined,
	};
}

function estimate(binding: Extract<Binding, { kind: "resolved" }>, costs: readonly number[]): Estimate {
	if (costs.length > 0) {
		// Zero-cost dispatches have no logarithm; their arithmetic mean is the expected cost.
		const usd = costs.every((cost) => cost > 0)
			? Math.exp(costs.reduce((sum, cost) => sum + Math.log(cost), 0) / costs.length + LOG_COST_SIGMA ** 2 / 2)
			: costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
		return { kind: "observed", usd, n: costs.length };
	}
	const modelKey = `${binding.model.provider}/${binding.model.id}|${binding.thinking ?? ""}`;
	const byAgent = DISPATCH_USD_BY_AGENT[`${binding.agent}|${modelKey}`];
	if (byAgent !== undefined) return { kind: "fallback", usd: byAgent, basis: "agent" };
	const byModel = DISPATCH_USD_BY_MODEL[modelKey];
	if (byModel !== undefined) return { kind: "fallback", usd: byModel, basis: "model" };
	return { kind: "fallback", usd: GLOBAL_DISPATCH_USD, basis: "global" };
}

function usd(value: number): string {
	return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4);
}

function resetText(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined) return "no reset time";
	const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	return `resets in ${days > 0 ? `${days}d ` : ""}${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function basisText(cost: Estimate): string {
	switch (cost.kind) {
		case "observed":
			return `observed n=${cost.n}`;
		case "fallback":
			return `fallback (${cost.basis})`;
		default: {
			const never: never = cost;
			return never;
		}
	}
}

/** Quota-left cell, estimated-count cell and binding-limit cell for one resolved agent. */
function quotaCells(quota: Quota, cost: Estimate, provider: string, now: number): [string, string, string] {
	switch (quota.kind) {
		case "unreported":
			return ["—", `n/a: no ${provider} quota report`, "—"];
		case "uncalibrated":
			return ["—", "n/a: no USD calibration", quota.limits.join(", ")];
		case "calibrated": {
			const left = `${usd(quota.usd)} (${quota.accounts} account${quota.accounts === 1 ? "" : "s"})`;
			const count = cost.usd > 0 ? String(Math.floor(quota.usd / cost.usd)) : "n/a: zero-priced model";
			const bindings = quota.bindings
				.map((binding) => `${binding.label} ${(binding.remainingFraction * 100).toFixed(0)}% left, ${resetText(binding.resetsAt, now)}`)
				.join("; ");
			const skipped = quota.uncalibrated.length > 0 ? ` (no calibration: ${quota.uncalibrated.join(", ")})` : "";
			return [left, count, `${bindings}${skipped}`];
		}
		default: {
			const never: never = quota;
			return never;
		}
	}
}

function row(binding: Binding, scan: SampleScan, reports: readonly UsageReport[], now: number): string {
	switch (binding.kind) {
		case "unresolved":
			return `| ${binding.agent} | ${binding.pattern ?? "(none)"} | — | — | — | n/a: first model not in the model registry (fallback models are not considered) | — |`;
		case "resolved": {
			const cost = estimate(binding, scan.costs.get(binding.agent) ?? []);
			const quota = quotaFor(reports, binding.model.provider, binding.model.id, now);
			const [left, count, limit] = quotaCells(quota, cost, binding.model.provider, now);
			return `| ${binding.agent} | ${binding.pattern} | ${usd(cost.usd)} | ${basisText(cost)} | ${left} | ${count} | ${limit} |`;
		}
		default: {
			const never: never = binding;
			return never;
		}
	}
}

/**
 * The top-level session `session` descends from. Its session directory and cwd name the project
 * bucket: a subagent's own directory is its parent's artifact folder, and an isolated one runs in
 * a copy of the checkout whose git metadata does not lead back to the project.
 */
function rootSession(session: AgentSession): AgentSession {
	const registry = AgentRegistry.global();
	let ref = registry.list().find((candidate) => candidate.session === session);
	const visited = new Set<string>();
	while (ref?.parentId !== undefined && !visited.has(ref.id)) {
		visited.add(ref.id);
		const parent = registry.get(ref.parentId);
		if (!parent?.session) break;
		ref = parent;
	}
	return ref?.session ?? session;
}

async function report(ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<ToolResult> {
	const session = callerSession(ctx);
	if (!session)
		return {
			content: [{ type: "text", text: "subagent_usage: could not resolve the calling session in the agent registry." }],
			isError: true,
		};
	const cwd = ctx.sessionManager.getCwd();
	const root = rootSession(session).sessionManager;
	const projectCwd = root.getCwd();
	const sessionDir = root.getSessionDir();
	await session.modelRegistry.awaitBackgroundRefresh();
	const bindings = (await availableAgents(session, cwd)).map((agent) => bindAgent(session, agent));
	const targets: Target[] = bindings.flatMap((binding) =>
		binding.kind === "resolved"
			? [{ agent: binding.agent, provider: binding.model.provider, modelId: binding.model.id, thinking: binding.thinking }]
			: [],
	);
	const now = Date.now();
	const dirs = [sessionDir, ...(await worktreeSessionDirs(projectCwd, sessionDir))];
	const [scan, reports] = await Promise.all([collectSamples(dirs, targets, now), session.fetchUsageReports(signal)]);
	const lines = [
		`Subagent dispatch budget at ${new Date(now).toISOString()}.`,
		`Observed dispatches: the newest ${MAX_SAMPLES_PER_AGENT} per agent that ran wholly on its first model, pooled over every session in ${dirs.length} session dir(s) (this directory and its worktrees); ${scan.inspected} transcript(s) inspected.`,
		`Fallback USD per dispatch and USD per quota window: built-in constants calibrated ${CALIBRATED_AT}.`,
		"Each count assumes the provider's whole remaining quota goes to that agent; agents on one provider share it, and refills at window resets are not counted.",
		...(reports === null ? ["Usage reporting is not configured for this session: no quota data."] : []),
		"",
		"| agent | first model | USD/dispatch | basis | quota left (USD) | est. dispatches | binding limit per account |",
		"|---|---|---|---|---|---|---|",
		...bindings.map((binding) => row(binding, scan, reports ?? [], now)),
	];
	return { content: [{ type: "text", text: lines.join("\n") }] };
}

export default function subagentUsage(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL,
		label: tr("Subagent Usage", "子代理用量"),
		description: DESCRIPTION,
		approval: "read",
		loadMode: "essential",
		parameters: params,
		async execute(_toolCallId, _rawParams, signal, _onUpdate, ctx) {
			try {
				return await report(ctx, signal);
			} catch (error) {
				pi.logger.warn("subagent-usage: tool failed", { error: errorText(error) });
				return { content: [{ type: "text", text: `subagent_usage failed: ${errorText(error)}` }], isError: true };
			}
		},
	});
}
