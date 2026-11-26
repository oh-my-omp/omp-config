import { type ExtensionAPI, type ToolCallEventResult, z } from "@oh-my-pi/pi-coding-agent";
import type { HelperHook } from "../_shared/helper-session.ts";

const bashInput = z.object({ command: z.string() });

const REFUSAL =
	"watchdog-agent: this exact command already failed in this observer run, so it did not run again; a failed command may still have taken effect. End with STATUS: failed.";

export function failedCommandGuard(): HelperHook {
	return (pi: ExtensionAPI) => {
		const pending = new Map<string, string>();
		const failed = new Set<string>();
		pi.on("tool_call", (event): ToolCallEventResult | undefined => {
			if (event.toolName !== "bash") return undefined;
			const parsed = bashInput.safeParse(event.input);
			if (!parsed.success) return undefined;
			if (failed.has(parsed.data.command)) return { block: true, reason: REFUSAL };
			pending.set(event.toolCallId, parsed.data.command);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			if (event.toolName !== "bash") return undefined;
			const command = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			if (command !== undefined && event.isError) failed.add(command);
			return undefined;
		});
	};
}
