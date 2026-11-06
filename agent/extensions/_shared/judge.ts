import {
	chatTextBackend,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	TextJudge,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AgentRegistry, type ExtensionContext, logger } from "@oh-my-pi/pi-coding-agent";
import { type JudgeDeps, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { modelLabel, type RoleModel, roleModels } from "./roles.ts";

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge } | { readonly kind: "inactive" };

/**
 * The calling session's judge for `purpose`, which is both the ledger and
 * telemetry label and the name of an OMP model role (`@lang-nag`, …).
 *
 * When `@<purpose>` resolves chat models, they answer as prompted judges
 * (one-hot probabilities), in chain order; OMP's judge-role chain is not
 * consulted, so no native or on-device judgment model answers that purpose.
 *
 * Otherwise OMP's own judge-role chain answers (`modelRoles.judge`, then
 * `retry.fallbackChains.judge` or OMP's built-in defaults), walked in order on
 * missing credentials and provider errors, with OMP's account-rejection
 * cooldown, session usage ledger, pricing and shared answer cache; the session
 * model is never added to it.
 *
 * Roles are resolved on every call. Inactive only when `@<purpose>` resolves
 * no chat model and the judge-role chain has no primary model.
 */
export function openJudge(ctx: ExtensionContext, purpose: string): JudgeOpen {
	const session = AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
	if (session == null) throw new Error("JUDGE: current OMP session is not registered");
	const deps: JudgeDeps = {
		settings: session.settings,
		registry: session.modelRegistry,
		sessionId: session.sessionId,
		metadataResolver: (provider) => session.agent.metadataForProvider(provider),
		purpose,
		onUsage: journalJudgmentUsage(session.sessionManager),
		telemetry: session.agent.telemetry,
		cache: sharedJudgmentCache(),
	};
	// `@<purpose>` models answer as prompted judges; the host judge chain is not consulted.
	const prompted = roleModels(ctx, [purpose]);
	if (prompted.length > 0) {
		return {
			kind: "ready",
			judge: {
				label: `@${purpose}`,
				judge: <Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}) =>
					judgeWithChat(deps, prompted, request, options),
			},
		};
	}
	const chain = resolveJudge(deps);
	if (chain.primaryModel() === undefined) return { kind: "inactive" };
	return {
		kind: "ready",
		judge: {
			label: chain.label,
			judge: <Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}) => chain.judge(request, options),
		},
	};
}
// @upstream adapted @oh-my-pi/pi-coding-agent@18.12.6 src/judgment/index.ts#ChainJudge.#withCandidate
// Chat candidates only; no rejection cooldown, image or box handling, or telemetry span.
async function judgeWithChat<Q extends Questions>(
	deps: JudgeDeps,
	models: readonly RoleModel[],
	request: JudgmentRequest<Q>,
	options: JudgeOptions,
): Promise<JudgmentResult<Q>> {
	const { registry, sessionId } = deps;
	const signal = options.signal;
	let lastFailure: string | undefined;
	for (const { role, model } of models) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
		try {
			if (!(await registry.getApiKey(model, sessionId, { signal }))) {
				lastFailure = `no API key for ${modelLabel(model)}`;
				continue;
			}
			const apiKey = registry.resolver(model, sessionId);
			// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
			const metadata = deps.metadataResolver?.(model.provider);
			const backend = chatTextBackend(model, {
				apiKey,
				sessionId,
				metadata,
				// Sole attribution point: TextJudge's result.usage aggregates these same attempts.
				onAttempt: (attempt) =>
					deps.onUsage?.({
						purpose: deps.purpose,
						role,
						api: attempt.api,
						provider: attempt.provider,
						model: attempt.model,
						usage: attempt.usage,
						stopReason: attempt.stopReason,
						...(attempt.errorMessage === undefined ? {} : { errorMessage: attempt.errorMessage }),
					}),
			});
			return await new TextJudge(backend).judge(request, options);
		} catch (error) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			if (isAbortOrTimeout(error)) throw error;
			lastFailure = error instanceof Error ? error.message : String(error);
			logger.warn("judgment prompted candidate failed", { role, candidate: modelLabel(model), error: lastFailure });
		}
	}
	const roles = [...new Set(models.map((entry) => entry.role))].map((role) => `@${role}`).join(", ");
	throw new Error(`judgment: every prompted candidate of ${roles} failed: ${lastFailure ?? "unknown error"}`);
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.12.6 src/judgment/index.ts#isAbortOrTimeout
function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
// @upstream-end
