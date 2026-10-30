import { watchedCallOf } from "../_shared/tool-calls.ts";
import { classify } from "./classify.ts";
import type { Dialect, Rule, Verdict } from "./verdict.ts";

/** One guarded tool call, parsed once at the hook boundary. #68 adds the eval entry. */
type Entry = { readonly kind: "bash"; readonly command: string };

/** The bash tool runs in the embedded brush shell on every platform. */
const BRUSH: Dialect = { kind: "posix" };

const FRAGMENT_LIMIT = 300;

/** `bash` calls from the loop, writes to `xd://bash` and the nested `bash` event of such a write; other tools are not guarded. */
function entryOf(toolName: string, input: unknown): Entry | null {
	const call = watchedCallOf(toolName, input);
	if (call === null) return null;
	switch (call.kind) {
		case "shell":
			return call.tool === "bash" ? { kind: "bash", command: call.command } : null;
		case "eval":
			return null;
		default: {
			const unreachable: never = call;
			return unreachable;
		}
	}
}

function judge(entry: Entry): Verdict {
	switch (entry.kind) {
		case "bash":
			return classify(BRUSH, entry.command, 0);
		default: {
			const unreachable: never = entry.kind;
			return unreachable;
		}
	}
}

function reasonFor(rule: Rule, fragment: string, detail: string, deleteAvailable: boolean): string {
	const shown = fragment.length > FRAGMENT_LIMIT ? `${fragment.slice(0, FRAGMENT_LIMIT)}…` : fragment;
	const outlet = deleteAvailable
		? 'To delete files, call the `delete` tool with literal paths (it moves them to the system trash; `mode: "permanent"` deletes for good).'
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
export function guardToolCall(toolName: string, input: unknown, deleteAvailable: () => boolean): GuardResult {
	const entry = entryOf(toolName, input);
	if (entry === null) return undefined;
	const verdict = judge(entry);
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
