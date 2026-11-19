import { EMPTY_CARRY, type JsCarry } from "../_shared/eval-js-launches.ts";
import { watchedCallOf } from "../_shared/tool-calls.ts";
import { classify } from "./classify.ts";
import { classifyJs } from "./eval-js.ts";
import { classifyPy } from "./eval-py.ts";
import { ALLOW, BRUSH, type Rule, SYSTEM_SHELL, type Verdict } from "./verdict.ts";

type Entry =
	| { readonly kind: "bash"; readonly command: string }
	| { readonly kind: "eval"; readonly language: "py" | "js"; readonly code: string; readonly reset: boolean };

export type EvalSession = { carry: JsCarry };

export const newEvalSession = (): EvalSession => ({ carry: EMPTY_CARRY });

export function resetEvalSession(session: EvalSession): void {
	session.carry = EMPTY_CARRY;
}

function isStandalonePercentCommand(code: string): boolean {
	const command = /^%(load|pip|bun|environment)(?:[ \t]+([\s\S]*))?$/.exec(code.trim());
	return command !== null && !/[\r\n]/.test(command[2] ?? "");
}

const FRAGMENT_LIMIT = 300;

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

function judge(entry: Entry, session: EvalSession): Verdict {
	switch (entry.kind) {
		case "bash":
			return classify(BRUSH, { kind: "script", text: entry.command }, 0);
		case "eval": {
			if (entry.language === "py") return classifyPy(entry.code, SYSTEM_SHELL, BRUSH);
			if (isStandalonePercentCommand(entry.code)) {
				if (entry.reset) session.carry = EMPTY_CARRY;
				return ALLOW;
			}
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
