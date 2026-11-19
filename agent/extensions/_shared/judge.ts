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
import { type ExtensionContext, logger } from "@oh-my-pi/pi-coding-agent";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { type JudgeDeps, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { callerSession } from "./caller-session.ts";
import { modelLabel, type RoleModel, roleModels } from "./roles.ts";

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge } | { readonly kind: "inactive" };

/**
 * The calling session's judge for `purpose`, which is both the ledger and
 * telemetry label and the name of an OMP model role (`@lang-nag`, …).
 *
 * When `@<purpose>` resolves chat models, they answer as prompted judges
 * (one-hot probabilities), in chain order, and a chat model that answers
 * 401/402/403/404 is skipped for five minutes; OMP's judge-role chain is not
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
	const session = callerSession(ctx);
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

// @upstream adapted @oh-my-pi/pi-coding-agent@18.22.0 src/judgment/index.ts#CANDIDATE_REJECTION_COOLDOWN_MS
/**
 * How long a candidate stays skipped after a rejection that persists until
 * something changes out of band: 401/403 credential, 402 billing cap, or 404
 * for a model the route no longer serves. Every judgment rebuilds the chain,
 * so without this each call re-pays the rejected request before reaching the
 * next candidate.
 */
const CANDIDATE_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;
// @upstream-end

/** Why a candidate is skipped until {@link CandidateRejection.until}; rendered as `<identity> <reason> recently`. */
interface CandidateRejection {
	until: number;
	reason: string;
}

/** Skip-until timestamps keyed by routed model identity, one table per registry. */
const rejectionsByRegistry = new WeakMap<JudgeDeps["registry"], Map<string, CandidateRejection>>();

function rejectionsOf(registry: JudgeDeps["registry"]): Map<string, CandidateRejection> {
	const rejections = rejectionsByRegistry.get(registry) ?? new Map<string, CandidateRejection>();
	rejectionsByRegistry.set(registry, rejections);
	return rejections;
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.22.0 src/judgment/index.ts#rejectionReason
// Takes the chat attempt's HTTP status, since the backend's thrown error carries none. The host's gateway 502 case is not ported: 5xx never cools down here.
/**
 * Reason for a rejection the route keeps answering until something changes out of band — a credential or
 * billing rejection of the account, or a 404 for a model the route does not serve — else `undefined`.
 */
function rejectionReason(status: number | undefined): string | undefined {
	switch (status) {
		case 401:
		case 402:
		case 403:
			return "rejected the account";
		case 404:
			return "did not serve the model";
		default:
			return undefined;
	}
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.22.0 src/judgment/index.ts#ChainJudge.#withCandidate
// Chat candidates only; the cooldown reads the chat attempt's status. No image or box handling, or telemetry span.
async function judgeWithChat<Q extends Questions>(
	deps: JudgeDeps,
	models: readonly RoleModel[],
	request: JudgmentRequest<Q>,
	options: JudgeOptions,
): Promise<JudgmentResult<Q>> {
	const { registry, sessionId } = deps;
	const signal = options.signal;
	const rejections = rejectionsOf(registry);
	const skipped: string[] = [];
	let lastFailure: string | undefined;
	for (const { role, model } of models) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
		const identity = formatModelStringWithRouting(model);
		const rejection = rejections.get(identity);
		if (rejection !== undefined) {
			if (rejection.until > Date.now()) {
				skipped.push(`${identity} ${rejection.reason} recently`);
				continue;
			}
			rejections.delete(identity);
		}
		// Status of this candidate's latest chat attempt; set only when that attempt failed.
		let attemptStatus: number | undefined;
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
				onAttempt: (attempt) => {
					attemptStatus = attempt.stopReason === "error" ? attempt.errorStatus : undefined;
					deps.onUsage?.({
						purpose: deps.purpose,
						role,
						api: attempt.api,
						provider: attempt.provider,
						model: attempt.model,
						usage: attempt.usage,
						stopReason: attempt.stopReason,
						...(attempt.errorMessage === undefined ? {} : { errorMessage: attempt.errorMessage }),
					});
				},
			});
			return await new TextJudge(backend).judge(request, options);
		} catch (error) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			if (isAbortOrTimeout(error)) throw error;
			lastFailure = error instanceof Error ? error.message : String(error);
			const reason = rejectionReason(attemptStatus);
			if (reason !== undefined) {
				rejections.set(identity, { until: Date.now() + CANDIDATE_REJECTION_COOLDOWN_MS, reason });
			}
			logger.warn("judgment prompted candidate failed", {
				role,
				candidate: modelLabel(model),
				error: lastFailure,
				skippedForMs: reason === undefined ? undefined : CANDIDATE_REJECTION_COOLDOWN_MS,
			});
		}
	}
	const roles = [...new Set(models.map((entry) => entry.role))].map((role) => `@${role}`).join(", ");
	const failures = lastFailure === undefined ? skipped : [lastFailure, ...skipped];
	throw new Error(`judgment: every prompted candidate of ${roles} failed: ${failures.join("; ") || "unknown error"}`);
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.22.0 src/judgment/index.ts#isAbortOrTimeout
function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
// @upstream-end
