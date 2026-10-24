import {
	chatTextBackend,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	TextJudge,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AgentRegistry, type AgentSession, type ExtensionContext, logger } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { type JudgeDeps, journalJudgmentUsage, kindOf, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge } | { readonly kind: "inactive" };

/**
 * The calling session's judge: OMP's own judge-role chain (`modelRoles.judge`,
 * then `retry.fallbackChains.judge` or OMP's built-in defaults), walked in
 * order on missing credentials and provider errors, with OMP's
 * account-rejection cooldown, session usage ledger, pricing and shared answer
 * cache. OMP drops every chat model listed after the first native judgment
 * model; when that native chain fails for any reason but abort or timeout,
 * those chat models answer as prompted judges, in chain order, then the
 * session model. Prompted answers are one-hot (probability 1 for the chosen
 * option). Inactive only when the chain resolves no candidate at all.
 * `purpose` labels ledger entries and telemetry spans.
 */
export function openJudge(ctx: ExtensionContext, purpose: string): JudgeOpen {
	const session = AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
	if (session == null) throw new Error("JUDGE: current OMP session is not registered");
	const deps: JudgeDeps = {
		settings: session.settings,
		registry: session.modelRegistry,
		sessionModel: session.model,
		sessionId: session.sessionId,
		metadataResolver: (provider) => session.agent.metadataForProvider(provider),
		purpose,
		onUsage: journalJudgmentUsage(session.sessionManager),
		telemetry: session.agent.telemetry,
		cache: sharedJudgmentCache(),
	};
	const chain = resolveJudge(deps);
	if (chain.primaryModel() === undefined) return { kind: "inactive" };
	return {
		kind: "ready",
		judge: {
			label: chain.label,
			async judge<Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}): Promise<JudgmentResult<Q>> {
				try {
					return await chain.judge(request, options);
				} catch (error) {
					if (options.signal?.aborted || isAbortOrTimeout(error)) throw error;
					const fallback = chatFallback(session);
					if (fallback.length === 0) throw error;
					logger.warn("judgment native chain failed; trying chat fallback", {
						purpose,
						candidates: fallback.map(identity),
						error: error instanceof Error ? error.message : String(error),
					});
					return judgeWithChat(deps, fallback, request, options);
				}
			},
		},
	};
}

const identity = (model: Model): string => `${model.provider}/${model.id}`;

/**
 * Chat models of the judge role chain that OMP's text chain drops: those after
 * its first native candidate, then the session model. Empty when the chain has
 * no native candidate, since OMP's chain then already tried them all.
 */
function chatFallback(session: AgentSession): Model[] {
	const { settings, modelRegistry } = session;
	const roleChain = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, modelRegistry));
	const firstNative = roleChain.findIndex((candidate) => kindOf(candidate) === "native");
	if (firstNative < 0) return [];
	const models = roleChain
		.slice(firstNative + 1)
		.filter((candidate) => kindOf(candidate) === "online")
		.map((candidate) => candidate.model);
	const sessionModel = session.model;
	if (
		sessionModel !== undefined &&
		kindOf(sessionModel) === "online" &&
		!models.some((model) => identity(model) === identity(sessionModel))
	) {
		models.push(sessionModel);
	}
	return models;
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.12.6 src/judgment/index.ts#ChainJudge.#withCandidate
// Chat candidates only; no rejection cooldown, image or box handling, or telemetry span.
async function judgeWithChat<Q extends Questions>(
	deps: JudgeDeps,
	models: readonly Model[],
	request: JudgmentRequest<Q>,
	options: JudgeOptions,
): Promise<JudgmentResult<Q>> {
	const { registry, sessionId } = deps;
	const signal = options.signal;
	let lastFailure: string | undefined;
	for (const model of models) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
		try {
			if (!(await registry.getApiKey(model, sessionId, { signal }))) {
				lastFailure = `no API key for ${identity(model)}`;
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
						role: "judge",
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
			logger.warn("judgment chat fallback candidate failed", { candidate: identity(model), error: lastFailure });
		}
	}
	throw new Error(`judgment: every chat fallback candidate failed: ${lastFailure ?? "unknown error"}`);
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.12.6 src/judgment/index.ts#isAbortOrTimeout
function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
// @upstream-end
