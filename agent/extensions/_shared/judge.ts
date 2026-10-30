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
import { AgentRegistry, type ExtensionContext, logger, z } from "@oh-my-pi/pi-coding-agent";
import { type JudgeDeps, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { defineSharedOmompSection, loadOmompSection } from "./omomp.ts";
import { modelLabel, type RoleModel, roleModels, roleName } from "./roles.ts";

const configSchema = z.object({
	/** OMP model role (`tiny`, `smol`, … or `@tiny`) whose model chain answers when the judge role chain cannot. */
	fallbackRole: z.string().min(1),
});

const omompSection = defineSharedOmompSection(import.meta.path, configSchema);

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge } | { readonly kind: "inactive" };

/**
 * The calling session's judge for `purpose`, which is both the ledger and
 * telemetry label and the name of an OMP model role (`@lang-nag`, …).
 *
 * When `@<purpose>` resolves chat models, they answer as prompted judges
 * (one-hot probabilities), in chain order, followed by the chat models of the
 * `fallbackRole` of the `judge` section of omomp.*; OMP's judge-role chain is
 * not consulted, so no native or on-device judgment model answers that purpose.
 *
 * Otherwise first OMP's own judge-role chain (`modelRoles.judge`, then
 * `retry.fallbackChains.judge` or OMP's built-in defaults), walked in order on
 * missing credentials and provider errors, with OMP's account-rejection
 * cooldown, session usage ledger, pricing and shared answer cache; the session
 * model is never added to it. When that chain fails for any reason but abort or
 * timeout, or resolves no candidate, the `fallbackRole` chat models answer as
 * prompted judges. Without a `judge` section there is no fallback.
 *
 * Roles and the `judge` section are resolved on every call. Inactive only when
 * no path resolves a model.
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
	const fallbackRole = configuredFallbackRole(ctx);
	const prompted = roleModels(ctx, fallbackRole === null ? [purpose] : [purpose, fallbackRole]);
	if (prompted.some((entry) => entry.role === purpose)) {
		return {
			kind: "ready",
			judge: {
				label: `@${purpose}`,
				judge: <Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}) =>
					judgeWithChat(deps, prompted, request, options),
			},
		};
	}
	// `@<purpose>` resolved nothing, so `prompted` holds only the fallback role's models.
	const chain = resolveJudge(deps);
	const hasChain = chain.primaryModel() !== undefined;
	if (!hasChain && prompted.length === 0) return { kind: "inactive" };
	return {
		kind: "ready",
		judge: {
			label: chain.label,
			async judge<Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}): Promise<JudgmentResult<Q>> {
				let chainError: unknown = new Error("judgment: judge role chain resolves no candidate");
				if (hasChain) {
					try {
						return await chain.judge(request, options);
					} catch (error) {
						if (options.signal?.aborted || isAbortOrTimeout(error)) throw error;
						chainError = error;
					}
				}
				if (prompted.length === 0) throw chainError;
				logger.warn("judgment judge role chain failed; falling back to role", {
					purpose,
					role: fallbackRole,
					candidates: prompted.map((entry) => modelLabel(entry.model)),
					error: chainError instanceof Error ? chainError.message : String(chainError),
				});
				return judgeWithChat(deps, prompted, request, options);
			},
		},
	};
}

/** The `fallbackRole` of the `judge` section, or null without one. */
function configuredFallbackRole(ctx: ExtensionContext): string | null {
	const config = loadOmompSection(omompSection, ctx.cwd);
	switch (config.kind) {
		case "none":
			return null;
		case "found":
			return roleName(config.value.fallbackRole);
		default: {
			const exhaustive: never = config;
			return exhaustive;
		}
	}
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
