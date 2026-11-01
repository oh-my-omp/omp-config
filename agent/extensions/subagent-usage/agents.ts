// Available subagent definitions and their first bound model, resolved the way the task tool resolves them.
import * as os from "node:os";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentDefinition, AgentSession } from "@oh-my-pi/pi-coding-agent";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type Binding =
	| {
			readonly kind: "resolved";
			readonly agent: string;
			readonly pattern: string;
			readonly model: Model<Api>;
			/** Thinking level the binding or definition fixes; undefined when neither does. */
			readonly thinking: string | undefined;
	  }
	| { readonly kind: "unresolved"; readonly agent: string; readonly pattern: string | undefined };

export async function availableAgents(session: AgentSession, cwd: string): Promise<AgentDefinition[]> {
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

/** The FIRST pattern of the agent's model selection; later comma-separated fallbacks are never considered. */
export function bindAgent(session: AgentSession, agent: AgentDefinition): Binding {
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

/**
 * The top-level session `session` descends from. Its session directory and cwd name the project
 * bucket: a subagent's own directory is its parent's artifact folder, and an isolated one runs in
 * a copy of the checkout whose git metadata does not lead back to the project.
 */
export function rootSession(session: AgentSession): AgentSession {
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
