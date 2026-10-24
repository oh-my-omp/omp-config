import { AgentRegistry, type ExtensionContext, type Settings } from "@oh-my-pi/pi-coding-agent";

/** The live settings of the session `ctx` serves, as OMP registered it; undefined before registration. */
export function sessionSettings(ctx: ExtensionContext): Settings | undefined {
	return AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session?.settings;
}
