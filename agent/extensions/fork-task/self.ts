import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

/** The last request at the common Context boundary, after all SDK context transforms. */
type RequestSnapshot = {
	readonly model: Model;
	readonly context: Context;
	readonly options: Pick<
		SimpleStreamOptions,
		"reasoning" | "disableReasoning" | "serviceTier" | "temperature" | "maxTokens" | "cacheRetention" | "sessionId" | "promptCacheKey"
	>;
};

const requests = new WeakMap<AgentSession, RequestSnapshot>();
const observed = new WeakSet<AgentSession>();

/**
 * Capture the actual provider-neutral input, not a separately rendered prompt.
 * Contexts are per-call values; retain only the latest one, without duplicating
 * the transcript. Child wrappers capture their replicated input too, so a fork
 * of a fork has the same source of truth.
 */
export function observeRequests(session: AgentSession): void {
	if (observed.has(session)) return;
	observed.add(session);
	const stream = session.agent.streamFn;
	session.agent.streamFn = (model, context, options) => {
		requests.set(session, {
			model,
			context,
			options: {
				reasoning: options?.reasoning,
				disableReasoning: options?.disableReasoning,
				serviceTier: options?.serviceTier,
				temperature: options?.temperature,
				maxTokens: options?.maxTokens,
				cacheRetention: options?.cacheRetention,
				sessionId: options?.sessionId,
				promptCacheKey: options?.promptCacheKey,
			},
		});
		return stream(model, context, options);
	};
}

export type SelfFork = {
	readonly request: RequestSnapshot;
	readonly systemPrompt: readonly string[];
	readonly tools: readonly AgentTool[];
	readonly model: string;
	readonly replayPrefix: boolean;
	readonly inheritReasoning: boolean;
};

type CaptureResult = { readonly kind: "ready"; readonly fork: SelfFork } | { readonly kind: "unavailable"; readonly reason: string };

export function captureSelf(session: AgentSession, shake: boolean, overrideEffort: boolean): CaptureResult {
	const request = requests.get(session);
	if (!request)
		return { kind: "unavailable", reason: "the caller has not sent a request with self-fork capture loaded; restart OMP first" };
	const level = session.thinkingLevel;
	return {
		kind: "ready",
		fork: {
			request,
			systemPrompt: [...session.systemPrompt],
			tools: [...session.agent.state.tools],
			model: `${request.model.provider}/${request.model.id}${level ? `:${level}` : ""}`,
			replayPrefix: !shake,
			inheritReasoning: !overrideEffort,
		},
	};
}

/**
 * Replace the inherited prefix through its last original message. SDK-only
 * reminders may have been inserted in either session, so indices are not fork
 * identities. Timestamps and roles survive SessionManager.forkFrom. After
 * compaction removes the anchor, the child owns its new context and no old
 * prefix is reintroduced. Explicit shake also opts out of message replay.
 */
function replicateContext(source: Context, current: Context, replayPrefix: boolean): Context {
	const last = source.messages.at(-1);
	let end = -1;
	if (replayPrefix && last) {
		for (const [index, message] of current.messages.entries()) {
			if (message.role !== last.role || message.timestamp !== last.timestamp) continue;
			if (message.role === "toolResult" && last.role === "toolResult" && message.toolCallId !== last.toolCallId) continue;
			// Disambiguate same-millisecond messages by the complete preceding
			// identity sequence. Do not discard a child tail on a guessed match.
			if (index + 1 < source.messages.length) continue;
			const start = index + 1 - source.messages.length;
			const matches = source.messages.every((original, offset) => {
				const candidate = current.messages[start + offset];
				return candidate?.role === original.role && candidate.timestamp === original.timestamp;
			});
			if (!matches) continue;
			if (end !== -1) throw new Error("fork_task: inherited message boundary is ambiguous");
			end = index;
		}
	}
	if (replayPrefix && last && end < 0) throw new Error("fork_task: inherited request prefix no longer matches the child context");
	const tools = source.tools ?? [];
	const names = new Set(tools.map((tool) => tool.name));
	const extra = current.tools?.filter((tool) => !names.has(tool.name)) ?? [];
	return {
		...current,
		systemPrompt: source.systemPrompt,
		tools: extra.length > 0 ? [...tools, ...extra] : source.tools,
		messages: end >= 0 ? [...source.messages, ...current.messages.slice(end + 1)] : current.messages,
	};
}

/** Install once per live generation; disposal releases the per-call hook. */
export function applySelf(session: AgentSession, fork: SelfFork): void {
	const own = new Map(session.agent.state.tools.map((tool) => [tool.name, tool]));
	const names = new Set(fork.tools.map((tool) => tool.name));
	const tools = fork.tools.map((tool) => {
		const local = own.get(tool.name) ?? session.getToolByName(tool.name);
		if (local) return local;
		// AskTool's real implementation uses the supplied execution context. In
		// a headless child it takes its existing headless handoff path; never
		// fabricate a same-schema tool that always returns an error.
		if (tool.name === "ask") return tool;
		throw new Error(`fork_task: cannot clone caller tool \`${tool.name}\` into this child`);
	});
	// Only completion extends the caller's capability surface. Do not expose
	// other tools admitted by the unrestricted internal agent definition.
	const yieldTool = own.get("yield") ?? session.getToolByName("yield");
	if (yieldTool && !names.has("yield")) tools.push(yieldTool);
	const detach = session.agent.addBeforeModelCallHook(() => {
		session.agent.setSystemPrompt([...fork.systemPrompt]);
		session.agent.setTools(tools);
	});
	session.addDisposer(detach);

	const stream = session.agent.streamFn;
	const parent = fork.request;
	const initialCompaction = session.sessionManager.getBranchView().findLast((entry) => entry.type === "compaction")?.id;
	let replayPrefix = fork.replayPrefix;
	const wrap: StreamFn = (model, context, options) => {
		if (model.provider !== parent.model.provider || model.id !== parent.model.id) {
			throw new Error("fork_task: self fork changed models; use an explicit agent for a different-model continuation");
		}
		if (replayPrefix && session.sessionManager.getBranchView().findLast((entry) => entry.type === "compaction")?.id !== initialCompaction) {
			replayPrefix = false;
		}
		return stream(model, replicateContext(parent.context, context, replayPrefix), {
			...options,
			...(fork.inheritReasoning ? { reasoning: parent.options.reasoning, disableReasoning: parent.options.disableReasoning } : {}),
			serviceTier: parent.options.serviceTier,
			temperature: parent.options.temperature,
			maxTokens: parent.options.maxTokens,
			cacheRetention: parent.options.cacheRetention,
			promptCacheKey: parent.options.promptCacheKey ?? parent.options.sessionId,
			parentSessionId: parent.options.sessionId,
		});
	};
	session.agent.streamFn = wrap;
}
