import { z } from "@oh-my-pi/pi-coding-agent";

/** A tool call that runs shell text or eval code, read from a `tool_call` event of any extension. */
export type WatchedCall =
	| { readonly kind: "shell"; readonly tool: string; readonly command: string }
	| { readonly kind: "eval"; readonly language: string; readonly code: string };

const shellSchema = z.object({ command: z.string() });
const execSchema = z.object({ cmd: z.string() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const evalSchema = z.object({ language: z.string(), code: z.string() });

type DeviceTool = "bash" | "bash_bg" | "exec_command";

/** Device paths that carry a shell command, mapped to the tool the payload runs. */
const DEVICE_TOOLS: Record<string, DeviceTool> = {
	"xd://bash": "bash",
	"xd://bash_bg": "bash_bg",
	"xd://exec_command": "exec_command",
};

/** Device JSON is untrusted; malformed or non-shell payloads are intentionally ignored. */
function deviceShellCall(path: string, content: string): WatchedCall | null {
	const tool = DEVICE_TOOLS[path];
	if (tool === undefined) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(content);
	} catch {
		// Invalid device JSON is an expected non-shell payload.
		return null;
	}
	// Name the tool the payload runs, not the device path: the judge and the nag
	// then describe the same operation the same way whichever lane called it.
	return shellCall(tool, payload);
}
function shellCall(tool: string, input: unknown): WatchedCall | null {
	if (tool === "exec_command") {
		const parsed = execSchema.safeParse(input);
		return parsed.success ? { kind: "shell", tool, command: parsed.data.cmd } : null;
	}
	const parsed = shellSchema.safeParse(input);
	return parsed.success ? { kind: "shell", tool, command: parsed.data.command } : null;
}

export function watchedCallOf(toolName: string, input: unknown): WatchedCall | null {
	switch (toolName) {
		case "bash":
		case "bash_bg":
		case "exec_command":
			return shellCall(toolName, input);
		case "write": {
			const parsed = writeSchema.safeParse(input);
			return parsed.success ? deviceShellCall(parsed.data.path, parsed.data.content) : null;
		}
		case "eval": {
			const parsed = evalSchema.safeParse(input);
			return parsed.success ? { kind: "eval", language: parsed.data.language, code: parsed.data.code } : null;
		}
		default:
			return null;
	}
}
