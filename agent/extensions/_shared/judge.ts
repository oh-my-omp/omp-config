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

/** A fallback role with the chat models its own role chain resolves to, in chain order. */
type Fallback = { readonly role: string; readonly models: readonly RoleModel[] };

/**
 * The calling session's judge. First OMP's own judge-role chain
 * (`modelRoles.judge`, then `retry.fallbackChains.judge` or OMP's built-in
 * defaults), walked in order on missing credentials and provider errors, with
 * OMP's account-rejection cooldown, session usage ledger, pricing and shared
 * answer cache; the session model is never added to it. When that chain fails
 * for any reason but abort or timeout, or resolves no candidate, the
 * `fallbackRole` of the `judge` section of omomp.* answers: the chat models of
 * that role's own chain, in order, as prompted judges (one-hot probabilities).
 * Without that section there is no fallback. Inactive only when neither
 * resolves a model. `purpose` labels ledger entries and telemetry spans.
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
	const chain = resolveJudge(deps);
	const hasChain = chain.primaryModel() !== undefined;
	if (!hasChain && roleFallback(ctx) === null) return { kind: "inactive" };
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
				const fallback = roleFallback(ctx);
				if (fallback === null) throw chainError;
				logger.warn("judgment judge role chain failed; falling back to role", {
					purpose,
					role: fallback.role,
					candidates: fallback.models.map((entry) => modelLabel(entry.model)),
					error: chainError instanceof Error ? chainError.message : String(chainError),
				});
				return judgeWithChat(deps, fallback, request, options);
			},
		},
	};
}

/** The configured fallback role's chat models, or null without a `judge` section or when the role resolves none. */
function roleFallback(ctx: ExtensionContext): Fallback | null {
	const config = loadOmompSection(omompSection, ctx.cwd);
	switch (config.kind) {
		case "none":
			return null;
		case "found": {
			const role = roleName(config.value.fallbackRole);
			const models = roleModels(ctx, [role]);
			return models.length === 0 ? null : { role, models };
		}
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
	fallback: Fallback,
	request: JudgmentRequest<Q>,
	options: JudgeOptions,
): Promise<JudgmentResult<Q>> {
	const { registry, sessionId } = deps;
	const signal = options.signal;
	let lastFailure: string | undefined;
	for (const { model } of fallback.models) {
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
						role: fallback.role,
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
			logger.warn("judgment fallback role candidate failed", { role: fallback.role, candidate: modelLabel(model), error: lastFailure });
		}
	}
	throw new Error(`judgment: every candidate of fallback role ${fallback.role} failed: ${lastFailure ?? "unknown error"}`);
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.12.6 src/judgment/index.ts#isAbortOrTimeout
function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
// @upstream-end
