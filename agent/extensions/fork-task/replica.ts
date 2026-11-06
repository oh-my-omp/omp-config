import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

/**
 * The last request at the common Context boundary, after all SDK context
 * transforms. Plain data only: the agent loop hands providers spread copies of
 * the live AgentTools, whose execute closures and session fields would keep a
 * disposed session reachable for as long as the snapshot lives.
 */
type RequestSnapshot = {
	readonly model: Model;
	readonly context: Pick<Context, "systemPrompt" | "messages" | "tools">;
	readonly options: Pick<
		SimpleStreamOptions,
		"reasoning" | "disableReasoning" | "serviceTier" | "temperature" | "maxTokens" | "cacheRetention" | "sessionId" | "promptCacheKey"
	>;
};

/**
 * A session's latest request and the timestamp of the assistant message it
 * produced, set once that request's stream completes. The persisted copy of
 * that assistant message keeps the timestamp, so it marks where the source's
 * history continues after the request.
 */
type ObservedRequest = { readonly request: RequestSnapshot; response: number | undefined };

const requests = new WeakMap<AgentSession, ObservedRequest>();
const observed = new WeakSet<AgentSession>();

/** The provider-facing fields of a tool (pi-ai `Tool`), without the AgentTool runtime it was spread from. */
function wireTool(tool: Tool): Tool {
	const { name, description, parameters, strict, deferLoading, customFormat, customWireName, native, examples } = tool;
	return {
		name,
		description,
		parameters,
		...(strict !== undefined ? { strict } : {}),
		...(deferLoading !== undefined ? { deferLoading } : {}),
		...(customFormat !== undefined ? { customFormat } : {}),
		...(customWireName !== undefined ? { customWireName } : {}),
		...(native !== undefined ? { native } : {}),
		...(examples !== undefined ? { examples } : {}),
	};
}

/**
 * Capture the actual provider-neutral input, not a separately rendered prompt.
 * Contexts are per-call values; retain only the latest one, without duplicating
 * the transcript. Child wrappers capture their replicated input too, so a fork
 * of a fork has the same source of truth. The snapshot ends with the session:
 * disposal (teardown or idle park) drops it.
 */
export function observeRequests(session: AgentSession): void {
	if (observed.has(session)) return;
	observed.add(session);
	session.addDisposer(() => {
		requests.delete(session);
	});
	const stream = session.agent.streamFn;
	session.agent.streamFn = (model, context, options) => {
		const latest: ObservedRequest = {
			request: {
				model,
				context: {
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools?.map(wireTool),
				},
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
			},
			response: undefined,
		};
		requests.set(session, latest);
		const events = stream(model, context, options);
		Promise.resolve(events)
			.then((started) => started.result())
			.then(
				(message) => {
					latest.response = message.timestamp;
				},
				() => {
					// The caller handles a failed stream; it leaves no response to anchor on.
				},
			);
		return events;
	};
}

/** The fork notice `stageFork` appends to the child transcript: its entry id and message timestamp. */
export type ForkNotice = { readonly entryId: string; readonly timestamp: number };

/**
 * How the child's requests reuse the source's message prefix. `prefix` sends
 * the source's messages verbatim, followed by the child's own context from
 * the source's response (when it reached the child) or from the fork notice.
 * `own` sends the child's context unchanged: explicit shake rewrote it.
 */
type Replay = { readonly kind: "prefix"; readonly response: number | undefined; readonly notice: ForkNotice } | { readonly kind: "own" };

/**
 * What a fork child replicates from its source's latest request. Lives as long
 * as the child stays revivable, so it holds plain data and no source session:
 * tool names instead of the source's AgentTools.
 */
export type Replica = {
	readonly request: RequestSnapshot;
	readonly systemPrompt: readonly string[];
	readonly toolNames: readonly string[];
	/** The `ask` tool a headless child borrows when it has none of its own: the caller's, else the source's. */
	readonly ask: AgentTool | undefined;
	/** The source's model and thinking level as a spawn selector. */
	readonly sourceModel: string;
	readonly replay: Replay;
	/** Copy the source's reasoning controls when the child runs the source's model. */
	readonly inheritReasoning: boolean;
};

/** A replica before staging: the replay mode needs the staged fork notice. */
type Capture = Omit<Replica, "replay"> & { readonly response: number | undefined };

type CaptureResult = { readonly kind: "ready"; readonly capture: Capture } | { readonly kind: "unavailable"; readonly reason: string };

export function captureReplica(
	session: AgentSession,
	options: { readonly inheritReasoning: boolean; readonly caller: AgentSession },
): CaptureResult {
	const latest = requests.get(session);
	if (!latest) {
		// Every session of this thread is observed at its first prompt; an unobserved one runs in a subagent worker thread, whose requests stay there.
		if (!observed.has(session))
			return {
				kind: "unavailable",
				reason: "it runs in a subagent worker thread, where its requests are captured; message it to fork itself",
			};
		return { kind: "unavailable", reason: "it has not sent a model request in this OMP process since fork capture loaded" };
	}
	const { request } = latest;
	const level = session.thinkingLevel;
	const toolNames = session.agent.state.tools.map((tool) => tool.name);
	return {
		kind: "ready",
		capture: {
			request,
			response: latest.response,
			systemPrompt: [...session.systemPrompt],
			toolNames,
			// The caller outlives the replica, so its `ask` pins no extra session; a `from` source's own is the fallback.
			ask: toolNames.includes("ask") ? (options.caller.getToolByName("ask") ?? session.getToolByName("ask")) : undefined,
			sourceModel: `${request.model.provider}/${request.model.id}${level ? `:${level}` : ""}`,
			inheritReasoning: options.inheritReasoning,
		},
	};
}

type PrefixReplay = Extract<Replay, { kind: "prefix" }>;

type Match = { readonly kind: "one"; readonly index: number } | { readonly kind: "none" } | { readonly kind: "many" };

/** The only message in `messages[0, end)` that `matches` accepts. */
function findOnly(messages: readonly Message[], end: number, matches: (message: Message) => boolean): Match {
	let found: Match = { kind: "none" };
	for (const [index, message] of messages.entries()) {
		if (index >= end) break;
		if (!matches(message)) continue;
		if (found.kind === "one") return { kind: "many" };
		found = { kind: "one", index };
	}
	return found;
}

/**
 * Where the child's own context starts. Everything before it is the child's
 * rebuild of the inherited transcript; the source's request messages replace
 * it verbatim and are never compared with it, because the host does not keep a
 * persisted transcript identical to the live request it was sent from
 * (unpersisted eval snapshots, restamped custom messages, injector-only
 * reminders). The source's response, when it reached the child's transcript,
 * keeps the source's history after that request; otherwise the fork notice
 * starts the child's part.
 */
function childStart(messages: readonly Message[], replay: PrefixReplay): number {
	const notice = findOnly(
		messages,
		messages.length,
		(message) => message.role === "developer" && message.timestamp === replay.notice.timestamp,
	);
	switch (notice.kind) {
		case "one":
			break;
		case "none":
		case "many":
			throw new Error(`fork_task: the fork notice is ${notice.kind === "none" ? "missing from" : "ambiguous in"} the child context`);
		default: {
			const unreachable: never = notice;
			return unreachable;
		}
	}
	const { response } = replay;
	if (response === undefined) return notice.index;
	const anchor = findOnly(messages, notice.index, (message) => message.role === "assistant" && message.timestamp === response);
	return anchor.kind === "one" ? anchor.index : notice.index;
}

/**
 * The source prefix applies while the child's branch holds the fork notice
 * with no compaction after it. Read from the transcript on every call, so a
 * child revived after it compacted does not resume replay.
 */
function replaysPrefix(session: AgentSession, notice: ForkNotice): boolean {
	const branch = session.sessionManager.getBranchView();
	const at = branch.findIndex((entry) => entry.id === notice.entryId);
	return at >= 0 && branch.findLastIndex((entry) => entry.type === "compaction") < at;
}

function replicatedMessages(session: AgentSession, replay: Replay, source: readonly Message[], current: Message[]): Message[] {
	switch (replay.kind) {
		case "own":
			return current;
		case "prefix":
			return replaysPrefix(session, replay.notice) ? [...source, ...current.slice(childStart(current, replay))] : current;
		default: {
			const unreachable: never = replay;
			return unreachable;
		}
	}
}

function replicateContext(session: AgentSession, replica: Replica, current: Context): Context {
	const source = replica.request.context;
	const tools = source.tools ?? [];
	const names = new Set(tools.map((tool) => tool.name));
	const extra = current.tools?.filter((tool) => !names.has(tool.name)) ?? [];
	return {
		...current,
		systemPrompt: source.systemPrompt,
		tools: extra.length > 0 ? [...tools, ...extra] : source.tools,
		messages: replicatedMessages(session, replica.replay, source.messages, current.messages),
	};
}

/** Install once per live generation; disposal releases the per-call hook. */
export function applyReplica(session: AgentSession, replica: Replica): void {
	const own = new Map(session.agent.state.tools.map((tool) => [tool.name, tool]));
	const names = new Set(replica.toolNames);
	const tools = replica.toolNames.map((name) => {
		const local = own.get(name) ?? session.getToolByName(name);
		if (local) return local;
		// AskTool's real implementation uses the supplied execution context. In
		// a headless child it takes its existing headless handoff path; never
		// fabricate a same-schema tool that always returns an error.
		if (name === "ask" && replica.ask) return replica.ask;
		throw new Error(`fork_task: cannot clone source tool \`${name}\` into this child`);
	});
	// Only completion extends the source's capability surface. Do not expose
	// other tools admitted by the unrestricted internal agent definition.
	const yieldTool = own.get("yield") ?? session.getToolByName("yield");
	if (yieldTool && !names.has("yield")) tools.push(yieldTool);
	const detach = session.agent.addBeforeModelCallHook(() => {
		session.agent.setSystemPrompt([...replica.systemPrompt]);
		session.agent.setTools(tools);
	});
	session.addDisposer(detach);

	const stream = session.agent.streamFn;
	const source = replica.request;
	const wrap: StreamFn = (model, context, options) => {
		const replicated = replicateContext(session, replica, context);
		// Request controls belong to the source's model; another model keeps its own.
		if (model.provider !== source.model.provider || model.id !== source.model.id) {
			return stream(model, replicated, { ...options, parentSessionId: source.options.sessionId });
		}
		return stream(model, replicated, {
			...options,
			...(replica.inheritReasoning ? { reasoning: source.options.reasoning, disableReasoning: source.options.disableReasoning } : {}),
			serviceTier: source.options.serviceTier,
			temperature: source.options.temperature,
			maxTokens: source.options.maxTokens,
			cacheRetention: source.options.cacheRetention,
			promptCacheKey: source.options.promptCacheKey ?? source.options.sessionId,
			parentSessionId: source.options.sessionId,
		});
	};
	session.agent.streamFn = wrap;
}
