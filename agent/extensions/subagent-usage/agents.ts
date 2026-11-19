import * as os from "node:os";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentDefinition, AgentSession } from "@oh-my-pi/pi-coding-agent";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type Binding =
	| {
			readonly kind: "resolved";
			readonly agent: string;
			readonly pattern: string;
			readonly model: Model<Api>;
			readonly thinking: string | undefined;
	  }
	| { readonly kind: "unresolved"; readonly agent: string; readonly pattern: string | undefined };

export async function availableAgents(session: AgentSession, cwd: string): Promise<AgentDefinition[]> {
	const disabled = new Set(cfgTaskDisabledAgents.get(session.settings));
	const { agents } = await discoverAgents(cwd, os.homedir(), session.effectiveExtensionRoots);
	const seen = new Set<string>();
	const out: AgentDefinition[] = [];
	for (const agent of [...agents, ...session.getSessionAgents()]) {
		if (disabled.has(agent.name) || seen.has(agent.name)) continue;
		seen.add(agent.name);
		out.push(agent);
	}
	return out;
}

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

export function rootSession(session: AgentSession): AgentSessionHandle {
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
