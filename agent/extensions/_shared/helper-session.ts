import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type AgentSession, createAgentSession, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { errorText } from "./errors.ts";
import { lastAssistantText } from "./messages.ts";
import type { Model, ThinkingLevel } from "./models.ts";

type PreparedExtension = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["preloadedPreparedExtensions"]>[number];

export type HelperHook = NonNullable<PreparedExtension["factory"]>;

interface HelperPrompt {
	readonly agentId: string;
	readonly model: Model;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly prompt: string;
	readonly cwd?: string;
	readonly toolNames?: readonly string[];
	readonly systemPrompt: "default" | "none";
	readonly signal?: AbortSignal;
	readonly hooks?: readonly HelperHook[];
	/** Must not throw; throttle in the caller. */
	readonly onText?: (partial: string) => void;
}

export type HelperResult =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "canceled" }
	| { readonly kind: "provider-error"; readonly message: string }
	| { readonly kind: "failed"; readonly message: string };

type FinalAnswer = {
	readonly stopReason: AssistantMessage["stopReason"] | undefined;
	readonly errorMessage: string;
	readonly text: string;
};

function finalAnswer(messages: readonly AgentMessage[]): FinalAnswer {
	const last = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	return { stopReason: last?.stopReason, errorMessage: last?.errorMessage ?? "", text: lastAssistantText(messages) };
}

/**
 * The session is classified as a subagent (`taskDepth: 1`):
 * disposing a main-kind session tears down the global AgentLifecycleManager and
 * strands every live subagent.
 */
export async function runHelperPrompt(ctx: ExtensionContext, request: HelperPrompt): Promise<HelperResult> {
	const { signal } = request;
	if (signal?.aborted) return { kind: "canceled" };
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: request.cwd ?? ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			sessionManager: SessionManager.inMemory(),
			toolNames: [...(request.toolNames ?? [])],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			taskDepth: 1,
			agentId: request.agentId,
			preloadedPreparedExtensions: (request.hooks ?? []).map((factory, i) => ({
				path: `<inline-${i}>`,
				resolvedPath: `<inline-${i}>`,
				factory,
				error: null,
			})),
			...(request.systemPrompt === "none" ? { systemPrompt: [] } : {}),
		}));
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}

	let partial = "";
	const final: { answer: FinalAnswer | null } = { answer: null };
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				partial += update.delta;
				if (!signal?.aborted) request.onText?.(partial);
			}
		} else if (event.type === "agent_end") {
			final.answer = finalAnswer(event.messages);
		}
	});

	const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<"canceled">();
	const onAbort = (): void => {
		void session.abort();
		resolveAborted("canceled");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const run = session.prompt(request.prompt).then(
			() => "done" as const,
			(error: unknown) => ({ error }),
		);
		const outcome = await Promise.race([run, aborted]);
		if (outcome === "canceled") return { kind: "canceled" };
		if (outcome !== "done") return { kind: "failed", message: errorText(outcome.error) };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		await session.dispose().catch(() => undefined);
	}
	if (signal?.aborted) return { kind: "canceled" };

	const answer = final.answer;
	if (answer !== null && answer.stopReason === "error") return { kind: "provider-error", message: answer.errorMessage };
	return { kind: "text", text: (answer === null ? "" : answer.text.trim()) || partial.trim() };
}
