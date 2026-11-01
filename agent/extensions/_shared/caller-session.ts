import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** The live AgentSession `ctx` serves, matched by session manager or session file; undefined before registration. */
export function callerSession(ctx: ExtensionContext): AgentSession | undefined {
	const file = ctx.sessionManager.getSessionFile();
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session) continue;
		if (session.sessionManager === ctx.sessionManager) return session;
		if (file && session.sessionManager.getSessionFile() === file) return session;
	}
	return undefined;
}
