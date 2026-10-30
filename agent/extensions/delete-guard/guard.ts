import { watchedCallOf } from "../_shared/tool-calls.ts";
import { classify } from "./classify.ts";
import { classifyJs } from "./eval-js.ts";
import { classifyPy } from "./eval-py.ts";
import type { Dialect, Rule, Verdict } from "./verdict.ts";

/** One guarded tool call, parsed once at the hook boundary. */
type Entry =
	| { readonly kind: "bash"; readonly command: string }
	| { readonly kind: "eval"; readonly language: "py" | "js"; readonly code: string };

/** The bash tool, `Bun.$`, `Bun.spawn` and the `tool.bash` bridge run in the embedded brush shell on every platform. */
const BRUSH: Dialect = { kind: "posix" };

/**
 * The shell an eval cell's `shell=True`, `os.system`, `!cmd` or `child_process.exec` string reaches: `/bin/sh` on
 * macOS and Linux, `cmd.exe` (`ComSpec`) on Windows. `%%bash`, `Bun.$`, `Bun.spawn` and `tool.bash` stay posix.
 */
const SYSTEM_SHELL: Dialect = process.platform === "win32" ? { kind: "cmd" } : { kind: "posix" };

const FRAGMENT_LIMIT = 300;

/** `bash` calls (loop, `xd://bash` writes and their nested `bash` event) and `eval` cells in py or js; other tools are not guarded. */
function entryOf(toolName: string, input: unknown): Entry | null {
	const call = watchedCallOf(toolName, input);
	if (call === null) return null;
	switch (call.kind) {
		case "shell":
			return call.tool === "bash" ? { kind: "bash", command: call.command } : null;
		case "eval":
			return call.language === "py" || call.language === "js" ? { kind: "eval", language: call.language, code: call.code } : null;
		default: {
			const unreachable: never = call;
			return unreachable;
		}
	}
}

async function judge(entry: Entry): Promise<Verdict> {
	switch (entry.kind) {
		case "bash":
			return classify(BRUSH, { kind: "script", text: entry.command }, 0);
		case "eval":
			return entry.language === "py" ? classifyPy(entry.code, SYSTEM_SHELL, BRUSH) : classifyJs(entry.code, SYSTEM_SHELL, BRUSH);
		default: {
			const unreachable: never = entry;
			return unreachable;
		}
	}
}

function reasonFor(rule: Rule, fragment: string, detail: string, deleteAvailable: boolean): string {
	const shown = fragment.length > FRAGMENT_LIMIT ? `${fragment.slice(0, FRAGMENT_LIMIT)}…` : fragment;
	const outlet = deleteAvailable
		? "To delete files, call the `delete` tool with literal paths and leave `mode` unset; the default moves them to the system trash."
		: "This session cannot delete files.";
	switch (rule) {
		case "delete":
			return `delete-guard: deletion commands are disabled; this call did not run. Deletion command: \`${shown}\` (${detail}). ${outlet}`;
		case "nonLiteral":
			return `delete-guard: this call did not run. Non-literal command: \`${shown}\` (${detail}). Commands must be literal: no command name from a variable or substitution, no non-literal nested shell or eval script, no script fed to a shell through stdin; write the command out. ${outlet}`;
		default: {
			const unreachable: never = rule;
			return unreachable;
		}
	}
}

export type GuardResult = { readonly block: true; readonly reason: string } | undefined;

/** The `tool_call` decision: a block with its reason, or undefined to let the call run. */
export async function guardToolCall(toolName: string, input: unknown, deleteAvailable: () => boolean): Promise<GuardResult> {
	const entry = entryOf(toolName, input);
	if (entry === null) return undefined;
	const verdict = await judge(entry);
	switch (verdict.kind) {
		case "allow":
			return undefined;
		case "block":
			return { block: true, reason: reasonFor(verdict.rule, verdict.fragment, verdict.detail, deleteAvailable()) };
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
}
