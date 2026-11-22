import { z, type zod } from "@oh-my-pi/pi-coding-agent";
import type { BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { EvalToolParams } from "@oh-my-pi/pi-coding-agent/tools/eval";

export type WatchedCall =
	| { readonly kind: "shell"; readonly tool: ShellTool; readonly command: string }
	| { readonly kind: "eval"; readonly language: string; readonly code: string; readonly reset: boolean };

const shellSchema: zod.ZodLikeSchema<BashToolInput> = z.object({ command: z.string() });
type EvalCallInput = Pick<EvalToolParams, "code" | "reset"> & { language: string };
const evalSchema: zod.ZodLikeSchema<EvalCallInput> = z.object({
	language: z.string(),
	code: z.string(),
	reset: z.boolean().optional(),
});

type ShellTool = "bash";

function shellCall(tool: ShellTool, input: unknown): WatchedCall | null {
	const parsed = shellSchema.safeParse(input);
	return parsed.success ? { kind: "shell", tool, command: parsed.data.command } : null;
}

export function watchedCallOf(toolName: string, input: unknown): WatchedCall | null {
	switch (toolName) {
		case "bash":
			return shellCall(toolName, input);
		case "eval": {
			const parsed = evalSchema.safeParse(input);
			return parsed.success
				? { kind: "eval", language: parsed.data.language, code: parsed.data.code, reset: parsed.data.reset === true }
				: null;
		}
		default:
			return null;
	}
}
