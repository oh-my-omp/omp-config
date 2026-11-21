import { type AgentTelemetry, recordJudgmentTelemetry, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
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
import { type ExtensionContext, logger } from "@oh-my-pi/pi-coding-agent";
import { cfgNoJudge, cfgOffline } from "@oh-my-pi/pi-coding-agent/config/auxiliary-model-policy";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
		costGate: session.costGate,
	};
	const bound = roleModels(ctx, [purpose]);
	if (bound.length > 0) {
		const prompted = allowedCandidates(bound, session.settings, session.model);
		if (prompted.length === 0) return { kind: "inactive" };
		const telemetry = resolveTelemetry(deps.telemetry, deps.sessionId);
		return {
			kind: "ready",
			judge: {
				label: `@${purpose}`,
				judge: <Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}) =>
					judgeWithChat(deps, telemetry, prompted, request, options),
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

// @upstream adapted @oh-my-pi/pi-coding-agent@19.0.0 src/judgment/index.ts#allowedJudgeCandidates
// Filters the @<purpose> role models instead of the host's judge-role chain candidates.
function allowedCandidates(models: readonly RoleModel[], settings: Settings, sessionModel: Model | undefined): RoleModel[] {
	if (!cfgNoJudge.get(settings) && !cfgOffline.get(settings)) return [...models];
	const provider = sessionModel?.provider;
	return provider ? models.filter(({ model }) => model.provider === provider) : [];
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@19.0.0 src/judgment/index.ts#rejectionOf
// Classifies the chat attempt's errorStatus (chatTextBackend's thrown error carries none); rejections live in a module WeakMap per registry (the host's registry key is private); the gateway 502 case is not ported.
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

function rejectionOf(status: number | undefined): { reason: string; cooldownMs: number } | undefined {
	switch (status) {
		case 401:
		case 402:
		case 403:
			return { reason: `rejected the account (${status})`, cooldownMs: Number.POSITIVE_INFINITY };
		case 451:
			return { reason: "is unavailable in this region (451)", cooldownMs: Number.POSITIVE_INFINITY };
		case 404:
			return { reason: "did not serve the model", cooldownMs: CANDIDATE_REJECTION_COOLDOWN_MS };
		default:
			return undefined;
	}
}
// @upstream-end

// Must not become resolveJudge({ leadModel }): the host chain then falls back to the `judge` role after the
// @<purpose> models fail and journals the attempts under role `judge`, so a purpose bound to its own models
// silently spends on the host judge instead of failing to the caller.
// @upstream adapted @oh-my-pi/pi-coding-agent@19.0.0 src/judgment/index.ts#ChainJudge.#withCandidate
// Chat candidates of @<purpose> only: no image, box or native judges, no per-attempt timeout skip, no rejection listeners; a failed @<purpose> chain goes to the caller, not the host judge chain.
async function judgeWithChat<Q extends Questions>(
	deps: JudgeDeps,
	telemetry: AgentTelemetry | undefined,
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
		// Must stay outside the try: a cost-cap refusal caught there would fall through to the next candidate.
		deps.costGate?.admit();
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
					reportAttempt(deps, telemetry, role, attempt);
				},
			});
			return await new TextJudge(backend).judge(request, options);
		} catch (error) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			if (isAbortOrTimeout(error)) throw error;
			lastFailure = error instanceof Error ? error.message : String(error);
			const rejected = rejectionOf(attemptStatus);
			if (rejected !== undefined) {
				rejections.set(identity, { until: Date.now() + rejected.cooldownMs, reason: rejected.reason });
			}
			logger.warn("judgment prompted candidate failed", {
				role,
				candidate: modelLabel(model),
				status: attemptStatus,
				error: lastFailure,
				skippedForMs: rejected === undefined ? undefined : Number.isFinite(rejected.cooldownMs) ? rejected.cooldownMs : "session",
			});
		}
	}
	const roles = [...new Set(models.map((entry) => entry.role))].map((role) => `@${role}`).join(", ");
	const failures = lastFailure === undefined ? skipped : [lastFailure, ...skipped];
	throw new Error(`judgment: every prompted candidate of ${roles} failed: ${failures.join("; ") || "unknown error"}`);
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@19.0.0 src/judgment/index.ts#ChainJudge.#report
// Records every attempt, since a chat attempt is never answered from the judgment cache; the usage entry carries the attempt's role and duration.
function reportAttempt(deps: JudgeDeps, telemetry: AgentTelemetry | undefined, role: string, attempt: AssistantMessage): void {
	deps.costGate?.record(attempt.usage.cost.total);
	deps.onUsage?.({
		purpose: deps.purpose,
		role,
		api: attempt.api,
		provider: attempt.provider,
		model: attempt.model,
		usage: attempt.usage,
		stopReason: attempt.stopReason,
		...(attempt.errorMessage === undefined ? {} : { errorMessage: attempt.errorMessage }),
		...(attempt.duration === undefined ? {} : { duration: attempt.duration }),
	});
	recordJudgmentTelemetry(telemetry, {
		provider: attempt.provider,
		model: attempt.model,
		purpose: deps.purpose,
		usage: attempt.usage,
		stopReason: attempt.stopReason,
		...(attempt.errorMessage === undefined ? {} : { errorMessage: attempt.errorMessage }),
		startTime: attempt.timestamp,
	}).catch((error: unknown) => logger.warn("judgment telemetry failed", { error: String(error) }));
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@19.0.0 src/judgment/index.ts#isAbortOrTimeout
function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
// @upstream-end
