import { type AgentSession, createAgentSession, type ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import { lastAssistantText } from "./messages.ts";
import type { Model, ThinkingLevel } from "./models.ts";

interface HelperPrompt {
	/** Session id shown in logs; also the helper's agent name. */
	readonly agentId: string;
	readonly model: Model;
	/** Undefined keeps the session default. */
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly prompt: string;
	/** Defaults to `ctx.cwd`. */
	readonly cwd?: string;
	/** Tools the helper may call; none by default. */
	readonly toolNames?: readonly string[];
	/** `none` sends no system prompt, for self-contained prompts that must not wear the coding-agent persona. */
	readonly systemPrompt: "default" | "none";
	/** Aborting cancels the request and resolves `canceled` at once. */
	readonly signal?: AbortSignal;
	/** Called with the accumulated reply text after every streamed delta. Must not throw; throttle in the caller. */
	readonly onText?: (partial: string) => void;
}

type HelperResult =
	/** Trimmed reply text, possibly empty. */
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "canceled" }
	/** The provider answered with `stopReason: "error"` (403, rate limit, …); `message` is its `errorMessage`, possibly empty — the caller words the fallback. */
	| { readonly kind: "provider-error"; readonly message: string }
	/** Session creation or the prompt itself threw. */
	| { readonly kind: "failed"; readonly message: string };

/** What a finished helper run leaves behind: the last assistant turn's failure, and the last assistant text. */
type FinalAnswer = { readonly stopReason: unknown; readonly errorMessage: string; readonly text: string };

/** The judged parts of a finished run; the message list itself is not retained. */
function finalAnswer(messages: unknown): FinalAnswer {
	let stopReason: unknown;
	let errorMessage = "";
	if (Array.isArray(messages)) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message: unknown = messages[i];
			if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") continue;
			stopReason = "stopReason" in message ? message.stopReason : undefined;
			errorMessage = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
			break;
		}
	}
	return { stopReason, errorMessage, text: lastAssistantText(messages) };
}

/**
 * Run one prompt in a fresh, restricted, in-memory helper session and dispose
 * it. Never throws. The session is classified as a subagent (`taskDepth: 1`):
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
			...(request.systemPrompt === "none" ? { systemPrompt: [] } : {}),
		}));
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}

	let partial = "";
	/** Set by the terminal `agent_end`; held as a property so the subscription's assignment is seen after it. */
	const final: { answer: FinalAnswer | null } = { answer: null };
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				partial += update.delta;
				if (!signal?.aborted) request.onText?.(partial);
			}
		} else if (event.type === "agent_end" && event.isTerminal !== false) {
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

	// A provider failure does not reject prompt(); it lands as an assistant turn with stopReason "error".
	const answer = final.answer;
	if (answer !== null && answer.stopReason === "error") return { kind: "provider-error", message: answer.errorMessage };
	return { kind: "text", text: partial.trim() || (answer === null ? "" : answer.text.trim()) };
}
