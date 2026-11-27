// Process-wide prototype wrappers are never undone: disabling this extension only takes effect after an omp restart.
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent, ExtensionAPI, SessionContext } from "@oh-my-pi/pi-coding-agent";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { type ReplayContext, type ReplayTarget, UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { isTaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

type RenderOptions = Parameters<UiHelpers["renderSessionContextIncrementally"]>[1];

const EAGER_RENDERER_TYPE = "mouriya.omp.task-result-guard";

type PatchOutcome =
	| { readonly kind: "installed" }
	| { readonly kind: "missing"; readonly targets: readonly string[] }
	| { readonly kind: "failed"; readonly error: string };

type PendingToolHandle = {
	updateResult: (result: { content: unknown; details?: unknown; isError?: boolean }, isPartial?: boolean, toolCallId?: string) => void;
};

type ControllerWithPendingTools = {
	readonly ctx?: {
		readonly pendingTools?: ReadonlyMap<string, PendingToolHandle>;
	};
};

let cachedOutcome: PatchOutcome | undefined;
let warnedUi = false;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// Keep interrupt_skipped intact: tool-block switches to defaultPresenter and renders "cancelled" only when source === "interrupt_skipped".
function isInterruptSkipped(details: unknown): boolean {
	return isObjectRecord(details) && details.source === "interrupt_skipped";
}

function isSyntheticStop(details: unknown): boolean {
	return (
		isObjectRecord(details) &&
		details.__synthetic === true &&
		(details.source === "assistant_stop_error" || details.source === "assistant_stop_aborted")
	);
}

function shouldStripTaskDetails(details: unknown): boolean {
	return details !== undefined && !isTaskToolDetails(details) && !isInterruptSkipped(details);
}

// Never mutate messages or entries in place: SessionManager and Agent share references with persisted transcript entries.
function projectToolResult(message: ToolResultMessage): ToolResultMessage {
	if (message.toolName !== "task" || !shouldStripTaskDetails(message.details)) return message;
	return { ...message, details: undefined };
}

function projectAgentMessage(message: AgentMessage): AgentMessage {
	if (message.role !== "toolResult" || message.toolName !== "task" || !shouldStripTaskDetails(message.details)) return message;
	return { ...message, details: undefined };
}

function projectReplayContext<T extends ReplayContext>(context: T): T {
	const needsProjection = context.messages.some(
		(msg) => msg.role === "toolResult" && msg.toolName === "task" && shouldStripTaskDetails(msg.details),
	);
	if (!needsProjection) return context;
	return { ...context, messages: context.messages.map(projectAgentMessage) };
}

function installOnce(): PatchOutcome {
	if (cachedOutcome !== undefined) return cachedOutcome;

	const missing: string[] = [];
	if (typeof UiHelpers?.prototype?.renderSessionContext !== "function") missing.push("UiHelpers.renderSessionContext");
	if (typeof UiHelpers?.prototype?.renderSessionContextIncrementally !== "function")
		missing.push("UiHelpers.renderSessionContextIncrementally");
	if (typeof UiHelpers?.prototype?.replaySteps !== "function") missing.push("UiHelpers.replaySteps");
	if (typeof EventController?.prototype?.handleEvent !== "function") missing.push("EventController.handleEvent");
	if (typeof Agent?.prototype?.getPendingToolResults !== "function") missing.push("Agent.getPendingToolResults");
	if (typeof agentTranscriptSource?.parseEntries !== "function") missing.push("agentTranscriptSource.parseEntries");
	if (missing.length > 0) {
		cachedOutcome = { kind: "missing", targets: missing };
		return cachedOutcome;
	}

	try {
		const origRenderSessionContext = UiHelpers.prototype.renderSessionContext;
		UiHelpers.prototype.renderSessionContext = function (this: UiHelpers, sessionContext: SessionContext, options?: RenderOptions): void {
			let projected = sessionContext;
			try {
				projected = projectReplayContext(sessionContext);
			} catch {}
			origRenderSessionContext.call(this, projected, options);
		};

		const origRenderIncrementally = UiHelpers.prototype.renderSessionContextIncrementally;
		UiHelpers.prototype.renderSessionContextIncrementally = function (
			this: UiHelpers,
			sessionContext: SessionContext,
			options: RenderOptions,
			renderChunk?: () => void,
		): Promise<void> {
			let projected = sessionContext;
			try {
				projected = projectReplayContext(sessionContext);
			} catch {}
			return origRenderIncrementally.call(this, projected, options, renderChunk);
		};

		const origReplaySteps = UiHelpers.prototype.replaySteps;
		UiHelpers.prototype.replaySteps = function (
			this: UiHelpers,
			target: ReplayTarget,
			sessionContext: ReplayContext,
		): Generator<void, void, void> {
			let projected = sessionContext;
			try {
				projected = projectReplayContext(sessionContext);
			} catch {}
			return origReplaySteps.call(this, target, projected);
		};

		const origHandleEvent = EventController.prototype.handleEvent;
		EventController.prototype.handleEvent = async function (this: EventController, event: AgentSessionEvent): Promise<void> {
			if (event.type === "tool_execution_update" && event.toolName === "task" && shouldStripTaskDetails(event.partialResult.details)) {
				return origHandleEvent.call(this, {
					...event,
					partialResult: { ...event.partialResult, details: undefined },
				});
			}
			if (event.type === "tool_execution_end" && event.toolName === "task" && shouldStripTaskDetails(event.result.details)) {
				// Preserve synthetic stop details on the event passed to #handleToolExecutionEnd so #syntheticFailureCards still evicts the card on auto_retry_start.
				const pending = (this as unknown as ControllerWithPendingTools).ctx?.pendingTools?.get(event.toolCallId);
				if (isSyntheticStop(event.result.details) && pending !== undefined && typeof pending.updateResult === "function") {
					const hadOwn = Object.hasOwn(pending, "updateResult");
					const previousUpdateResult = pending.updateResult;
					let consumed = false;
					pending.updateResult = function (result, isPartial, toolCallId) {
						if (!consumed && shouldStripTaskDetails(result.details)) {
							consumed = true;
							previousUpdateResult.call(this, { ...result, details: undefined }, isPartial, toolCallId);
							return;
						}
						previousUpdateResult.call(this, result, isPartial, toolCallId);
					};
					try {
						return await origHandleEvent.call(this, event);
					} finally {
						if (hadOwn) pending.updateResult = previousUpdateResult;
						else Reflect.deleteProperty(pending, "updateResult");
					}
				}
				return origHandleEvent.call(this, {
					...event,
					result: { ...event.result, details: undefined },
				});
			}
			return origHandleEvent.call(this, event);
		};

		const origGetPendingToolResults = Agent.prototype.getPendingToolResults;
		Agent.prototype.getPendingToolResults = function (this: Agent): readonly ToolResultMessage[] {
			const results = origGetPendingToolResults.call(this);
			try {
				if (!results.some((msg) => msg.toolName === "task" && shouldStripTaskDetails(msg.details))) return results;
				return results.map(projectToolResult);
			} catch {
				return results;
			}
		};

		const origParseEntries = agentTranscriptSource.parseEntries;
		agentTranscriptSource.parseEntries = function (text: string) {
			const entries = origParseEntries.call(this, text);
			try {
				const needsProjection = entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "task" &&
						shouldStripTaskDetails(entry.message.details),
				);
				if (!needsProjection) return entries;
				return entries.map((entry) => {
					if (
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "task" &&
						shouldStripTaskDetails(entry.message.details)
					) {
						return { ...entry, message: { ...entry.message, details: undefined } };
					}
					return entry;
				});
			} catch {
				return entries;
			}
		};

		cachedOutcome = { kind: "installed" };
		return cachedOutcome;
	} catch (error) {
		cachedOutcome = { kind: "failed", error: errorText(error) };
		return cachedOutcome;
	}
}

function warningText(outcome: Exclude<PatchOutcome, { readonly kind: "installed" }>): string {
	switch (outcome.kind) {
		case "missing":
			return tr(
				`task-result-guard: OMP UI entrypoints moved (${outcome.targets.join(", ")}); non-snapshot task results are unguarded`,
				`task-result-guard：OMP 界面入口已变更（${outcome.targets.join(", ")}），非快照 task 结果未受保护`,
			);
		case "failed":
			return tr(
				`task-result-guard: installing TUI task guard failed (${outcome.error})`,
				`task-result-guard：安装 TUI task 结果保护失败（${outcome.error}）`,
			);
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

export default function taskResultGuard(pi: ExtensionAPI): void {
	// Never remove registerMessageRenderer: startup-deferral caches extensions without pre-first-frame registrations as deferrable in agent.db, loading them after renderInitialMessages on later starts.
	pi.registerMessageRenderer(EAGER_RENDERER_TYPE, () => undefined);

	const outcome = installOnce();
	if (outcome.kind !== "installed") {
		pi.logger.warn("task-result-guard: non-snapshot task TUI guard inactive", { outcome });
		pi.on("session_start", (_event, ctx) => {
			try {
				if (warnedUi || ctx.agent.kind !== "main" || !ctx.hasUI) return;
				warnedUi = true;
				ctx.ui.notify(warningText(outcome), "warning");
			} catch (error) {
				pi.logger.warn("task-result-guard: session_start warning failed", { error: errorText(error) });
			}
		});
	}
}
