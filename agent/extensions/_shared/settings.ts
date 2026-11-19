import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { callerSession } from "./caller-session.ts";

export function sessionSettings(ctx: ExtensionContext): Settings | undefined {
	return callerSession(ctx)?.settings;
}
