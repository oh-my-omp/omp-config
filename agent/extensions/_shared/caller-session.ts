import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

export function callerSession(ctx: ExtensionContext): AgentSession | undefined {
	const file = ctx.sessionManager.getSessionFile();
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session || !isLocalAgentSession(session)) continue;
		if (session.sessionManager === ctx.sessionManager) return session;
		if (file && session.sessionManager.getSessionFile() === file) return session;
	}
	return undefined;
}
