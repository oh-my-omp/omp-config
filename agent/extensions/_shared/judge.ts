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

const CANDIDATE_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;

interface CandidateRejection {
	until: number;
	reason: string;
}

const rejectionsByRegistry = new WeakMap<JudgeDeps["registry"], Map<string, CandidateRejection>>();

function rejectionsOf(registry: JudgeDeps["registry"]): Map<string, CandidateRejection> {
	const rejections = rejectionsByRegistry.get(registry) ?? new Map<string, CandidateRejection>();
	rejectionsByRegistry.set(registry, rejections);
	return rejections;
}

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

function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
