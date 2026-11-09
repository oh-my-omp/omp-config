import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, Model, SimpleStreamOptions, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { parkedFilePath, parsePortableSource, readOptional } from "./replica-file.ts";

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
/** Live observed sessions of this thread by session file, for requests from other threads. */
const liveSessions = new Map<string, AgentSession>();

/**
 * What a fork replicates from its source: the latest request, where the
 * source's history continues after it, and the source state read with it.
 */
export type SourceRequest = {
	readonly request: RequestSnapshot;
	readonly response: number | undefined;
	readonly systemPrompt: readonly string[];
	readonly toolNames: readonly string[];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	/** The source's own `ask`, only while it is live. */
	readonly ask: AgentTool | undefined;
};

/** A source request as plain data that crosses threads: without the live `ask`, with the source's cwd. */
export type PortableSource = Omit<SourceRequest, "ask"> & { readonly cwd: string };

/** A source's request kept when its session was disposed, for forking it without reviving it. */
export type ParkedRequest = PortableSource & { readonly response: number };

type SourceRequestResult =
	| { readonly kind: "ready"; readonly source: SourceRequest }
	| { readonly kind: "unavailable"; readonly reason: string };

/** What the thread owning a live source answers another thread with. */
export type SharedSource =
	| { readonly kind: "ready"; readonly source: PortableSource }
	| { readonly kind: "unavailable"; readonly reason: string };

/**
 * The request a parked source sent last, written to `parkedFilePath` when it
 * parked (idle park or teardown) in any thread of this OMP process; undefined
 * when none was kept. A new live generation of the same file deletes it when it
 * starts observing, and it is valid only while the transcript still ends at
 * `response` (the caller checks). The main session's shutdown deletes the
 * process's directory.
 */
export async function parkedRequest(file: string): Promise<ParkedRequest | undefined> {
	const text = await readOptional(parkedFilePath(file));
	if (text === undefined) return undefined;
	const source = parsePortableSource(JSON.parse(text));
	const { response } = source;
	return response === undefined ? undefined : { ...source, response };
}

/** Whether `session` is a live session of this thread, whose requests this module copy observes. */
export function observedHere(session: AgentSession): boolean {
	return observed.has(session);
}

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
 * of a fork has the same source of truth. Disposal (teardown or idle park)
 * writes an answered latest request to the session file's parked record, which
 * every thread of this OMP process reads; the write is synchronous because the
 * session's disposers are, so a fork right after the park finds it.
 */
export function observeRequests(session: AgentSession, warn: (message: string, error: unknown) => void): void {
	if (observed.has(session)) return;
	observed.add(session);
	const file = session.sessionManager.getSessionFile();
	if (file) {
		liveSessions.set(file, session);
		// This generation supersedes what the file's previous one kept at park.
		fs.rmSync(parkedFilePath(file), { force: true });
	}
	session.addDisposer(() => {
		const latest = requests.get(session);
		requests.delete(session);
		const at = session.sessionManager.getSessionFile();
		if (file && liveSessions.get(file) === session) liveSessions.delete(file);
		if (!at || latest?.response === undefined) return;
		const parked: ParkedRequest = {
			request: latest.request,
			response: latest.response,
			systemPrompt: [...session.systemPrompt],
			toolNames: session.agent.state.tools.map((tool) => tool.name),
			thinkingLevel: session.thinkingLevel,
			cwd: session.sessionManager.getCwd(),
		};
		try {
			const target = parkedFilePath(at);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, JSON.stringify(parked));
		} catch (error) {
			warn("fork_task: keeping the parked session's request failed; forking it needs a wake first", error);
		}
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

/** The latest request of a live session in this thread. */
export function liveRequest(session: AgentSession): SourceRequestResult {
	const latest = requests.get(session);
	if (!latest) return { kind: "unavailable", reason: "it has not sent a model request in this OMP process since fork capture loaded" };
	return {
		kind: "ready",
		source: {
			request: latest.request,
			response: latest.response,
			systemPrompt: [...session.systemPrompt],
			toolNames: session.agent.state.tools.map((tool) => tool.name),
			thinkingLevel: session.thinkingLevel,
			ask: session.getToolByName("ask"),
		},
	};
}

/**
 * Answer another thread asking for the live source whose transcript is `file`:
 * undefined when no live session of this thread writes it. A ready answer
 * captures the latest request, then flushes the transcript, so the asker's
 * copy of the transcript holds every replicated message.
 */
export async function shareSource(file: string): Promise<SharedSource | undefined> {
	const session = liveSessions.get(file);
	if (!session) return undefined;
	const live = liveRequest(session);
	if (live.kind === "unavailable") return live;
	await session.sessionManager.ensureOnDisk();
	await session.sessionManager.flush();
	const { ask: _live, ...source } = live.source;
	return { kind: "ready", source: { ...source, cwd: session.sessionManager.getCwd() } };
}

export function captureReplica(
	source: SourceRequest,
	options: { readonly inheritReasoning: boolean; readonly caller: AgentSession },
): Capture {
	const { request, toolNames, thinkingLevel: level } = source;
	return {
		request,
		response: source.response,
		systemPrompt: source.systemPrompt,
		toolNames,
		// The caller outlives the replica, so its `ask` pins no extra session; a live `from` source's own is the fallback.
		ask: toolNames.includes("ask") ? (options.caller.getToolByName("ask") ?? source.ask) : undefined,
		sourceModel: `${request.model.provider}/${request.model.id}${level ? `:${level}` : ""}`,
		inheritReasoning: options.inheritReasoning,
	};
}

type PrefixReplay = Extract<Replay, { kind: "prefix" }>;

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
	// One reverse pass: the fork notice sits near the child's own tail, and every
	// message the source's response can match precedes it. It cannot stop at the
	// notice, because a duplicate notice before it makes the notice ambiguous.
	const noticeTimestamp = replay.notice.timestamp;
	const { response } = replay;
	let notice = -1;
	let anchor = -1;
	let anchors = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		const isNotice = message.role === "developer" && message.timestamp === noticeTimestamp;
		if (notice === -1) {
			if (isNotice) notice = index;
			continue;
		}
		if (isNotice) throw new Error("fork_task: the fork notice is ambiguous in the child context");
		if (message.role !== "assistant" || message.timestamp !== response) continue;
		anchor = index;
		anchors++;
	}
	if (notice === -1) throw new Error("fork_task: the fork notice is missing from the child context");
	if (response === undefined) return notice;
	return anchors === 1 ? anchor : notice;
}

/**
 * The source prefix applies while the child's branch holds the fork notice
 * with no compaction after it. Read from the transcript on every call, so a
 * child revived after it compacted does not resume replay.
 */
function replaysPrefix(session: AgentSession, notice: ForkNotice): boolean {
	const branch = session.sessionManager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction") return false;
		if (entry.id === notice.entryId) return true;
	}
	return false;
}

function replicatedMessages(session: AgentSession, replay: Replay, source: readonly Message[], current: Message[]): Message[] {
	switch (replay.kind) {
		case "own":
			return current;
		case "prefix": {
			if (!replaysPrefix(session, replay.notice)) return current;
			const start = childStart(current, replay);
			// One array: the source prefix, then the child's own tail copied in place.
			const merged: Message[] = new Array(source.length + current.length - start);
			for (let index = 0; index < source.length; index++) merged[index] = source[index]!;
			for (let index = source.length, tail = start; tail < current.length; index++, tail++) merged[index] = current[tail]!;
			return merged;
		}
		default: {
			const unreachable: never = replay;
			return unreachable;
		}
	}
}

/** The model a request runs on, as the provider identifies it. */
type ModelKey = Pick<Model, "provider" | "id">;

export function sameModel(a: ModelKey, b: ModelKey): boolean {
	return a.provider === b.provider && a.id === b.id;
}

/** The source tool whose cells reach the child's own `yield` through the eval bridge. */
const BRIDGE_TOOL = "eval";

/** The tool a forced tool choice names; undefined when the choice forces none in particular. */
function forcedToolName(choice: ToolChoice | undefined): string | undefined {
	if (choice === undefined || typeof choice === "string") return undefined;
	switch (choice.type) {
		case "tool":
			return choice.name;
		case "function":
			return "name" in choice ? choice.name : choice.function.name;
		case "computer":
			return undefined;
		default: {
			const unreachable: never = choice;
			return unreachable;
		}
	}
}

/** `choice` forcing `name` instead, in the same wire shape. */
function forceTool(choice: Exclude<ToolChoice, string>, name: string): ToolChoice {
	switch (choice.type) {
		case "tool":
			return { type: "tool", name };
		case "function":
			return "name" in choice ? { type: "function", name } : { type: "function", function: { name } };
		case "computer":
			return choice;
		default: {
			const unreachable: never = choice;
			return unreachable;
		}
	}
}

/** What one request declares and forces. */
type WireTools = { readonly tools: Tool[] | undefined; readonly toolChoice: ToolChoice | undefined };

/**
 * The tools a request declares. A provider caches tools → system → messages
 * as one prefix, and any declaration the source did not send — deferred or
 * not — invalidates everything after the tools. So on the source's model, when
 * the source declares `eval`, the list stays the source's byte for byte: the
 * child reaches its own tools from an `eval` cell, and a choice forcing one of
 * them forces `eval` instead. Otherwise the child's own tools follow the
 * source's.
 */
function wireTools(source: Tool[] | undefined, current: Context, onSourceModel: boolean, choice: ToolChoice | undefined): WireTools {
	const names = new Set(source?.map((tool) => tool.name));
	const own = current.tools?.filter((tool) => !names.has(tool.name)) ?? [];
	if (own.length === 0) return { tools: source, toolChoice: choice };
	if (!onSourceModel || !names.has(BRIDGE_TOOL)) return { tools: [...(source ?? []), ...own], toolChoice: choice };
	const forced = forcedToolName(choice);
	const forcesOwn = choice !== undefined && typeof choice !== "string" && own.some((tool) => tool.name === forced);
	return { tools: source, toolChoice: forcesOwn ? forceTool(choice, BRIDGE_TOOL) : choice };
}

function replicateContext(session: AgentSession, replica: Replica, current: Context, tools: Tool[] | undefined): Context {
	const source = replica.request.context;
	return {
		...current,
		systemPrompt: source.systemPrompt,
		tools,
		messages: replicatedMessages(session, replica.replay, source.messages, current.messages),
	};
}

/**
 * The child's own `yield` when the source declares `eval` but not `yield`: on
 * the source's model it is not declared (see `wireTools`), so the child learns
 * it from a reminder and calls it from an `eval` cell.
 */
export type OwnYield = { readonly tool: AgentTool; readonly sourceModel: ModelKey };

/**
 * Install once per live generation; disposal releases the per-call hook.
 * Returns the child's own `yield` when it reaches the source's model through `eval`.
 */
export function applyReplica(session: AgentSession, replica: Replica): OwnYield | undefined {
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
	const ownYield = yieldTool && !names.has("yield") ? yieldTool : undefined;
	if (ownYield) tools.push(ownYield);
	// The hook re-installs the source's prompt and tools whenever the host swaps
	// them; one array each is enough, since both setters store what they get.
	const systemPrompt = [...replica.systemPrompt];
	const detach = session.agent.addBeforeModelCallHook(() => {
		session.agent.setSystemPrompt(systemPrompt);
		session.agent.setTools(tools);
	});
	session.addDisposer(detach);

	const stream = session.agent.streamFn;
	const source = replica.request;
	const wrap: StreamFn = (model, context, options) => {
		const onSourceModel = sameModel(model, source.model);
		const wire = wireTools(source.context.tools, context, onSourceModel, options?.toolChoice);
		const replicated = replicateContext(session, replica, context, wire.tools);
		// Request controls belong to the source's model; another model keeps its own.
		if (!onSourceModel) {
			return stream(model, replicated, { ...options, parentSessionId: source.options.sessionId });
		}
		return stream(model, replicated, {
			...options,
			toolChoice: wire.toolChoice,
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
	return ownYield && names.has(BRIDGE_TOOL)
		? { tool: ownYield, sourceModel: { provider: source.model.provider, id: source.model.id } }
		: undefined;
}
