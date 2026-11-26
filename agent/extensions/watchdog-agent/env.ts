import { type ExtensionAPI, type ToolCallEventResult, z } from "@oh-my-pi/pi-coding-agent";
import type { HelperHook } from "../_shared/helper-session.ts";
import type { EnvVar } from "./spec.ts";

const bashInput = z.object({ command: z.string() });

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function bashEnvHook(env: readonly EnvVar[]): HelperHook {
	const prefix = env.map(({ name, value }) => `export ${name}=${quote(value)}\n`).join("");
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", (event): ToolCallEventResult | undefined => {
			if (event.toolName !== "bash") return undefined;
			const parsed = bashInput.safeParse(event.input);
			if (!parsed.success)
				return {
					block: true,
					reason: "watchdog-agent: this bash call has no command string, so its env could not be set; it did not run.",
				};
			return { input: { ...event.input, command: `${prefix}${parsed.data.command}` } };
		});
	};
}
