import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { StopReason } from "@oh-my-pi/pi-ai";
import type { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { journalCompletion } from "@oh-my-pi/pi-coding-agent/session/model-usage-journal";
import { callerSession } from "./caller-session.ts";
import { errorText } from "./errors.ts";
import { textOf } from "./messages.ts";
import { modelLabel, type RoleModel, roleModels, roleName } from "./roles.ts";

export type AnswerStopReason = Extract<StopReason, "stop" | "length" | "toolUse">;

export type RoleChainReply =
	| {
			readonly kind: "text";
			readonly text: string;
			readonly stopReason: AnswerStopReason;
			readonly model: RoleModel;
			readonly failures: readonly string[];
	  }
	| { readonly kind: "no-model" }
	| { readonly kind: "deadline" }
	| { readonly kind: "aborted" }
	| { readonly kind: "all-failed"; readonly failures: readonly string[] }
	| { readonly kind: "error"; readonly error: unknown };

export type AttemptBudget = { readonly kind: "whole" } | { readonly kind: "split"; readonly deadlineAt: number };

export async function completeRoleChain(
	ctx: ExtensionContext,
	roles: readonly string[],
	systemPrompt: string,
	prompt: string,
	effort: (typeof THINKING_EFFORTS)[number],
	signal: AbortSignal,
	budget: AttemptBudget,
	accepts: (stopReason: AnswerStopReason) => boolean,
): Promise<RoleChainReply> {
	const failures: string[] = [];
	try {
		const session = callerSession(ctx);
		if (session === undefined) throw new Error("role chain: current OMP session is not registered");
		const models = roleModels(ctx, roles);
		if (models.length === 0) return { kind: "no-model" };
		const purpose = roleName(roles[0] ?? "");
		const registry = session.modelRegistry;
		const sessionId = session.sessionId;
		const telemetry = resolveTelemetry(session.agent.telemetry, sessionId);
		for (const [position, candidate] of models.entries()) {
			const { model, level } = candidate;
			if (signal.aborted) return { kind: "deadline" };
			const isLast = models.length - position === 1;
			const attempt = attemptSignal(signal, budget, models.length - position);
			try {
				if (!(await registry.getApiKey(model, sessionId, { signal: attempt }))) {
					failures.push(`${modelLabel(model)}: no API key`);
					continue;
				}
				try {
					session.costGate.admit();
				} catch (error) {
					return { kind: "error", error };
				}
				const journal = journalCompletion(session.sessionManager, { purpose, role: candidate.role });
				const apiKey = registry.resolver(model, sessionId);
				// Must follow getApiKey: earlier metadata misses the session-sticky credential getApiKey records.
				const metadata = session.agent.metadataForProvider(model.provider);
				const reply = await instrumentedCompleteSimple(
					model,
					{
						systemPrompt: [systemPrompt],
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					level === "off"
						? { apiKey, metadata, disableReasoning: true, signal: attempt }
						: { apiKey, metadata, reasoning: level ?? effort, signal: attempt },
					{ telemetry, oneshotKind: purpose },
				);
				session.costGate.record(reply.usage.cost.total);
				journal?.(reply, prompt);
				switch (reply.stopReason) {
					case "stop":
					case "length":
					case "toolUse":
						if (accepts(reply.stopReason)) {
							return {
								kind: "text",
								text: textOf(reply.content),
								stopReason: reply.stopReason,
								model: candidate,
								failures,
							};
						}
						failures.push(`${modelLabel(model)}: ${reply.stopReason}`);
						continue;
					case "error":
						failures.push(`${modelLabel(model)}: ${reply.errorMessage ?? "error"}`);
						continue;
					case "aborted":
						if (budget.kind === "whole") return { kind: "aborted" };
						if (signal.aborted || (isLast && attempt.aborted)) return { kind: "deadline" };
						failures.push(`${modelLabel(model)}: attempt timeout`);
						continue;
					default: {
						const unreachable: never = reply.stopReason;
						throw new Error(`unknown stop reason: ${String(unreachable)}`);
					}
				}
			} catch (error) {
				if (signal.aborted || (isLast && attempt.aborted)) return { kind: "deadline" };
				failures.push(`${modelLabel(model)}: ${errorText(error)}`);
			}
		}
		return { kind: "all-failed", failures };
	} catch (error) {
		return signal.aborted ? { kind: "deadline" } : { kind: "error", error };
	}
}

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
