import { completeSimple } from "@oh-my-pi/pi-ai";
import type { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import { textOf } from "./messages.ts";
import { modelLabel, type RoleModel, roleModels } from "./roles.ts";

/**
 * Outcome of one pass over a role chain. `deadline` means the caller's signal
 * aborted; `aborted` means the provider replied with `stopReason: "aborted"`
 * under the `whole` budget. The caller maps each variant to its own wording and
 * verdict. `failures` holds one `provider/id: reason` line per model that failed
 * before the answer (or, for `all-failed`, every model tried).
 */
export type RoleChainReply =
	| { readonly kind: "text"; readonly text: string; readonly model: RoleModel; readonly failures: readonly string[] }
	| { readonly kind: "no-model" }
	| { readonly kind: "deadline" }
	| { readonly kind: "aborted" }
	| { readonly kind: "all-failed"; readonly failures: readonly string[] }
	| { readonly kind: "error"; readonly error: unknown };

/**
 * How the time of one pass is spent. `whole`: every attempt runs under the
 * caller's signal alone, and a provider `stopReason: "aborted"` ends the pass.
 * `split`: each attempt also gets a timeout of the remaining time to `deadlineAt`
 * divided over the models not yet tried (this one included), so a hanging model
 * costs only its own share; an attempt that times out records a failure line and
 * the chain moves on.
 */
export type AttemptBudget = { readonly kind: "whole" } | { readonly kind: "split"; readonly deadlineAt: number };

/**
 * Ask the chat models of `roles` (resolved via {@link roleModels} at call time)
 * one system prompt and one user prompt, in chain order, and return the first
 * text answer. A provider `stopReason: "error"` or a thrown error that is not
 * the caller's deadline records a failure line and moves to the next model. The
 * signal aborting ends the pass at once; so does a provider `stopReason: "aborted"`
 * under `whole`. A reply that ends `length` or `toolUse` is never parsed as an answer:
 * it records a failure line and moves to the next model, like `error`. `effort` is the reasoning level for chain entries without a
 * `:level` suffix; an entry at level `off` runs with `disableReasoning`.
 */
export async function completeRoleChain(
	ctx: ExtensionContext,
	roles: readonly string[],
	systemPrompt: string,
	prompt: string,
	effort: (typeof THINKING_EFFORTS)[number],
	signal: AbortSignal,
	budget: AttemptBudget,
): Promise<RoleChainReply> {
	const failures: string[] = [];
	try {
		const models = roleModels(ctx, roles);
		if (models.length === 0) return { kind: "no-model" };
		for (const [position, candidate] of models.entries()) {
			const { model, level } = candidate;
			if (signal.aborted) return { kind: "deadline" };
			const attempt = attemptSignal(signal, budget, models.length - position);
			try {
				const reply = await completeSimple(
					model,
					{
						systemPrompt: [systemPrompt],
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					level === "off"
						? { apiKey: ctx.modelRegistry.resolver(model), disableReasoning: true, signal: attempt }
						: { apiKey: ctx.modelRegistry.resolver(model), reasoning: level ?? effort, signal: attempt },
				);
				switch (reply.stopReason) {
					case "stop":
						return { kind: "text", text: textOf(reply.content), model: candidate, failures };
					case "length":
					case "toolUse":
						failures.push(`${modelLabel(model)}: ${reply.stopReason}`);
						continue;
					case "error":
						failures.push(`${modelLabel(model)}: ${reply.errorMessage ?? "error"}`);
						continue;
					case "aborted":
						if (budget.kind === "whole") return { kind: "aborted" };
						if (signal.aborted) return { kind: "deadline" };
						failures.push(`${modelLabel(model)}: attempt timeout`);
						continue;
					default: {
						const unreachable: never = reply.stopReason;
						throw new Error(`unknown stop reason: ${String(unreachable)}`);
					}
				}
			} catch (error) {
				if (signal.aborted) return { kind: "deadline" };
				failures.push(`${modelLabel(model)}: ${errorText(error)}`);
			}
		}
		return { kind: "all-failed", failures };
	} catch (error) {
		return signal.aborted ? { kind: "deadline" } : { kind: "error", error };
	}
}

/** The signal one attempt runs under; `remaining` is the number of models not yet tried, this one included. */
const attemptSignal = (signal: AbortSignal, budget: AttemptBudget, remaining: number): AbortSignal => {
	switch (budget.kind) {
		case "whole":
			return signal;
		case "split":
			return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, (budget.deadlineAt - Date.now()) / remaining))]);
		default: {
			const unreachable: never = budget;
			throw new Error(`unknown attempt budget: ${String(unreachable)}`);
		}
	}
};
