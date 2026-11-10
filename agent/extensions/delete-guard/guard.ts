import { EMPTY_CARRY, type JsCarry } from "../_shared/eval-js-launches.ts";
import { watchedCallOf } from "../_shared/tool-calls.ts";
import { classify } from "./classify.ts";
import { classifyJs } from "./eval-js.ts";
import { classifyPy } from "./eval-py.ts";
import { ALLOW, BRUSH, type Rule, SYSTEM_SHELL, type Verdict } from "./verdict.ts";

/** One guarded tool call, parsed once at the hook boundary. */
type Entry =
	| { readonly kind: "bash"; readonly command: string }
	| { readonly kind: "eval"; readonly language: "py" | "js"; readonly code: string; readonly reset: boolean };

/**
 * One omp session's js kernel as the guard sees it: the module and launcher names
 * its allowed cells left behind. The kernel is the source of truth; this record is
 * derived from the cells judged allowed, and a `reset` cell replaces it.
 */
export type EvalSession = { carry: JsCarry };

export const newEvalSession = (): EvalSession => ({ carry: EMPTY_CARRY });

/** A new or switched omp session has a new kernel: the names of the old one no longer bind. */
export function resetEvalSession(session: EvalSession): void {
	session.carry = EMPTY_CARRY;
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.17.0 src/eval/input.ts#prepareEvalSource
/**
 * A cell omp itself rewrites before any JavaScript runs: one `%load`, `%pip`,
 * `%bun` or `%environment` command with its arguments on the same line. omp
 * rejects the command when its arguments span lines, so only one-line forms count.
 */
function isStandalonePercentCommand(code: string): boolean {
	const command = /^%(load|pip|bun|environment)(?:[ \t]+([\s\S]*))?$/.exec(code.trim());
	return command !== null && !/[\r\n]/.test(command[2] ?? "");
}
// @upstream-end

const FRAGMENT_LIMIT = 300;

/** `bash` calls (loop, `xd://bash` writes and their nested `bash` event) and `eval` cells in py or js; other tools are not guarded. */
function entryOf(toolName: string, input: unknown): Entry | null {
	const call = watchedCallOf(toolName, input);
	if (call === null) return null;
	switch (call.kind) {
		case "shell":
			return call.tool === "bash" ? { kind: "bash", command: call.command } : null;
		case "eval":
			return call.language === "py" || call.language === "js"
				? { kind: "eval", language: call.language, code: call.code, reset: call.reset }
				: null;
		default: {
			const unreachable: never = call;
			return unreachable;
		}
	}
}

/** Judges one entry against the session. An allowed js cell's names become the session's carry; a reset cell replaces it. */
function judge(entry: Entry, session: EvalSession): Verdict {
	switch (entry.kind) {
		case "bash":
			return classify(BRUSH, { kind: "script", text: entry.command }, 0);
		case "eval": {
			if (entry.language === "py") return classifyPy(entry.code, SYSTEM_SHELL, BRUSH);
			// omp turns these into a file read, an install or an environment choice; a loaded script's text is not judged.
			if (isStandalonePercentCommand(entry.code)) {
				if (entry.reset) session.carry = EMPTY_CARRY;
				return ALLOW;
			}
			// A reset cell runs in a fresh kernel, so the session's earlier names do not reach it.
			const judgement = classifyJs(entry.code, SYSTEM_SHELL, BRUSH, entry.reset ? EMPTY_CARRY : session.carry);
			if (judgement.verdict.kind === "allow") session.carry = judgement.carry;
			return judgement.verdict;
		}
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

type GuardResult = { readonly block: true; readonly reason: string } | undefined;

/** The `tool_call` decision: a block with its reason, or undefined to let the call run. */
export async function guardToolCall(
	toolName: string,
	input: unknown,
	deleteAvailable: () => boolean,
	session: EvalSession,
): Promise<GuardResult> {
	const entry = entryOf(toolName, input);
	if (entry === null) return undefined;
	const verdict = judge(entry, session);
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
