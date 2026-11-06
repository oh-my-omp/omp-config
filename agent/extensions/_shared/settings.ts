import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { callerSession } from "./caller-session.ts";

/** The live settings of the session `ctx` serves, as OMP registered it; undefined before registration. */
export function sessionSettings(ctx: ExtensionContext): Settings | undefined {
	return callerSession(ctx)?.settings;
}
