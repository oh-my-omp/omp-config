// Process-wide prototype wrappers are never undone: disabling this extension only takes effect after an omp restart.
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent, ExtensionAPI, SessionContext, SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { type ReplayContext, type ReplayTarget, UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isTaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

type RenderOptions = Parameters<UiHelpers["renderSessionContextIncrementally"]>[1];

const EAGER_RENDERER_TYPE = "mouriya.omp.task-result-guard";

type PatchOutcome =
	| { readonly kind: "installed" }
	| { readonly kind: "missing"; readonly targets: readonly string[] }
	| { readonly kind: "failed"; readonly error: string };

type GuardTargets = {
	readonly uiHelpersProto:
		| Partial<Pick<UiHelpers, "renderSessionContext" | "renderSessionContextIncrementally" | "replaySteps">>
		| undefined;
	readonly eventControllerProto: Partial<Pick<EventController, "handleEvent">> | undefined;
	readonly selectorControllerProto: Partial<Pick<SelectorController, "showUserMessageSelector" | "showCopySelector">> | undefined;
	readonly sessionManagerProto: Partial<Pick<SessionManager, "getTree">> | undefined;
	readonly agentProto: Partial<Pick<Agent, "getPendingToolResults">> | undefined;
	readonly transcriptSource: Partial<Pick<typeof agentTranscriptSource, "parseEntries">> | undefined;
};

type ValidatedTargets = {
	readonly uiHelpersProto: Pick<UiHelpers, "renderSessionContext" | "renderSessionContextIncrementally" | "replaySteps">;
	readonly eventControllerProto: Pick<EventController, "handleEvent">;
	readonly selectorControllerProto: Pick<SelectorController, "showUserMessageSelector" | "showCopySelector">;
	readonly sessionManagerProto: Pick<SessionManager, "getTree">;
	readonly agentProto: Pick<Agent, "getPendingToolResults">;
	readonly transcriptSource: Pick<typeof agentTranscriptSource, "parseEntries">;
};

type PendingToolHandle = {
	updateResult: (result: { content: unknown; details?: unknown; isError?: boolean }, isPartial?: boolean, toolCallId?: string) => void;
};

type BranchProvider = {
	getBranch: (leafId?: string) => SessionEntry[];
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPendingToolHandle(value: unknown): value is PendingToolHandle {
	return isObjectRecord(value) && typeof value.updateResult === "function";
}

function getPendingTool(controller: unknown, toolCallId: string): PendingToolHandle | undefined {
	if (!isObjectRecord(controller) || !isObjectRecord(controller.ctx)) return undefined;
	const map = controller.ctx.pendingTools;
	if (!(map instanceof Map)) return undefined;
	const candidate: unknown = map.get(toolCallId);
	return isPendingToolHandle(candidate) ? candidate : undefined;
}

function isBranchProvider(value: unknown): value is BranchProvider {
	return isObjectRecord(value) && typeof value.getBranch === "function";
}

function getControllerSessionManager(controller: unknown): BranchProvider | undefined {
	if (!isObjectRecord(controller) || !isObjectRecord(controller.ctx)) return undefined;
	return isBranchProvider(controller.ctx.sessionManager) ? controller.ctx.sessionManager : undefined;
}

function getViewSessionManager(controller: unknown): BranchProvider | undefined {
	if (!isObjectRecord(controller) || !isObjectRecord(controller.ctx) || !isObjectRecord(controller.ctx.viewSession)) return undefined;
	return isBranchProvider(controller.ctx.viewSession.sessionManager) ? controller.ctx.viewSession.sessionManager : undefined;
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

function projectSessionEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message") return entry;
	const projected = projectAgentMessage(entry.message);
	return projected === entry.message ? entry : { ...entry, message: projected };
}

function projectSessionEntries(entries: SessionEntry[]): SessionEntry[] {
	let changed = false;
	const next = entries.map((entry) => {
		const projected = projectSessionEntry(entry);
		if (projected !== entry) changed = true;
		return projected;
	});
	return changed ? next : entries;
}

function projectTreeNodes(nodes: SessionTreeNode[]): SessionTreeNode[] {
	let changed = false;
	const next = nodes.map((node) => {
		const entry = projectSessionEntry(node.entry);
		const children = projectTreeNodes(node.children);
		if (entry === node.entry && children === node.children) return node;
		changed = true;
		return { ...node, entry, children };
	});
	return changed ? next : nodes;
}

function withProjectedBranch<T>(manager: BranchProvider | undefined, run: () => T): T {
	if (!manager) return run();
	let hadOwn = false;
	let previousGetBranch: BranchProvider["getBranch"] | undefined;
	let patched = false;
	try {
		hadOwn = Object.hasOwn(manager, "getBranch");
		previousGetBranch = manager.getBranch;
		const orig = previousGetBranch;
		manager.getBranch = function (this: BranchProvider, leafId?: string): SessionEntry[] {
			const entries = orig.call(this, leafId);
			try {
				return projectSessionEntries(entries);
			} catch {
				return entries;
			}
		};
		patched = true;
	} catch {
		return run();
	}
	try {
		return run();
	} finally {
		if (patched) {
			try {
				if (hadOwn && previousGetBranch !== undefined) manager.getBranch = previousGetBranch;
				else Reflect.deleteProperty(manager, "getBranch");
			} catch {}
		}
	}
}

function wrapUiAndSelectors(targets: ValidatedTargets): void {
	const origRenderSessionContext = targets.uiHelpersProto.renderSessionContext;
	targets.uiHelpersProto.renderSessionContext = function (this: UiHelpers, sessionContext: SessionContext, options?: RenderOptions): void {
		let projected = sessionContext;
		try {
			projected = projectReplayContext(sessionContext);
		} catch {}
		origRenderSessionContext.call(this, projected, options);
	};

	const origRenderIncrementally = targets.uiHelpersProto.renderSessionContextIncrementally;
	targets.uiHelpersProto.renderSessionContextIncrementally = function (
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

	const origReplaySteps = targets.uiHelpersProto.replaySteps;
	targets.uiHelpersProto.replaySteps = function (
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

	const origShowUserMessageSelector = targets.selectorControllerProto.showUserMessageSelector;
	targets.selectorControllerProto.showUserMessageSelector = function (this: SelectorController, startAt?: string): void {
		withProjectedBranch(getControllerSessionManager(this), () => origShowUserMessageSelector.call(this, startAt));
	};

	const origShowCopySelector = targets.selectorControllerProto.showCopySelector;
	targets.selectorControllerProto.showCopySelector = function (this: SelectorController): void {
		withProjectedBranch(getViewSessionManager(this), () => origShowCopySelector.call(this));
	};

	const origGetTree = targets.sessionManagerProto.getTree;
	targets.sessionManagerProto.getTree = function (this: SessionManager): SessionTreeNode[] {
		const forest = origGetTree.call(this);
		try {
			return projectTreeNodes(forest);
		} catch {
			return forest;
		}
	};
}

function wrapEventAgentAndHub(targets: ValidatedTargets): void {
	const origHandleEvent = targets.eventControllerProto.handleEvent;
	targets.eventControllerProto.handleEvent = async function (this: EventController, event: AgentSessionEvent): Promise<void> {
		let forwarded = event;
		let restorePending: (() => void) | undefined;
		try {
			if (event.type === "tool_execution_update" && event.toolName === "task" && shouldStripTaskDetails(event.partialResult.details)) {
				forwarded = { ...event, partialResult: { ...event.partialResult, details: undefined } };
			} else if (event.type === "tool_execution_end" && event.toolName === "task" && shouldStripTaskDetails(event.result.details)) {
				// Preserve synthetic stop details on the event passed to #handleToolExecutionEnd so #syntheticFailureCards still evicts the card on auto_retry_start.
				const pending = getPendingTool(this, event.toolCallId);
				if (isSyntheticStop(event.result.details) && pending !== undefined) {
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
					restorePending = () => {
						try {
							if (hadOwn) pending.updateResult = previousUpdateResult;
							else Reflect.deleteProperty(pending, "updateResult");
						} catch {}
					};
				} else {
					forwarded = { ...event, result: { ...event.result, details: undefined } };
				}
			}
		} catch {
			restorePending?.();
			restorePending = undefined;
			forwarded = event;
		}
		try {
			return await origHandleEvent.call(this, forwarded);
		} finally {
			restorePending?.();
		}
	};

	const origGetPendingToolResults = targets.agentProto.getPendingToolResults;
	targets.agentProto.getPendingToolResults = function (this: Agent): readonly ToolResultMessage[] {
		const results = origGetPendingToolResults.call(this);
		try {
			if (!results.some((msg) => msg.toolName === "task" && shouldStripTaskDetails(msg.details))) return results;
			return results.map(projectToolResult);
		} catch {
			return results;
		}
	};

	const origParseEntries = targets.transcriptSource.parseEntries;
	targets.transcriptSource.parseEntries = function (text: string) {
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
}

let cachedOutcome: PatchOutcome | undefined;
let warnedLog = false;
let warnedUi = false;

function resolveHostTargets(): GuardTargets {
	return {
		uiHelpersProto: UiHelpers?.prototype,
		eventControllerProto: EventController?.prototype,
		selectorControllerProto: SelectorController?.prototype,
		sessionManagerProto: SessionManager?.prototype,
		agentProto: Agent?.prototype,
		transcriptSource: agentTranscriptSource,
	};
}

function validateTargets(
	targets: GuardTargets,
): { readonly ok: true; readonly value: ValidatedTargets } | { readonly ok: false; readonly missing: readonly string[] } {
	const missing: string[] = [];
	const ui = targets.uiHelpersProto;
	const ev = targets.eventControllerProto;
	const sel = targets.selectorControllerProto;
	const sm = targets.sessionManagerProto;
	const ag = targets.agentProto;
	const ts = targets.transcriptSource;
	if (typeof ui?.renderSessionContext !== "function") missing.push("UiHelpers.renderSessionContext");
	if (typeof ui?.renderSessionContextIncrementally !== "function") missing.push("UiHelpers.renderSessionContextIncrementally");
	if (typeof ui?.replaySteps !== "function") missing.push("UiHelpers.replaySteps");
	if (typeof sel?.showUserMessageSelector !== "function") missing.push("SelectorController.showUserMessageSelector");
	if (typeof sel?.showCopySelector !== "function") missing.push("SelectorController.showCopySelector");
	if (typeof sm?.getTree !== "function") missing.push("SessionManager.getTree");
	if (typeof ev?.handleEvent !== "function") missing.push("EventController.handleEvent");
	if (typeof ag?.getPendingToolResults !== "function") missing.push("Agent.getPendingToolResults");
	if (typeof ts?.parseEntries !== "function") missing.push("agentTranscriptSource.parseEntries");
	if (
		missing.length > 0 ||
		!ui?.renderSessionContext ||
		!ui.renderSessionContextIncrementally ||
		!ui.replaySteps ||
		!sel?.showUserMessageSelector ||
		!sel.showCopySelector ||
		!sm?.getTree ||
		!ev?.handleEvent ||
		!ag?.getPendingToolResults ||
		!ts?.parseEntries
	) {
		return { ok: false, missing };
	}
	return {
		ok: true,
		value: {
			uiHelpersProto: ui as ValidatedTargets["uiHelpersProto"],
			eventControllerProto: ev as ValidatedTargets["eventControllerProto"],
			selectorControllerProto: sel as ValidatedTargets["selectorControllerProto"],
			sessionManagerProto: sm as ValidatedTargets["sessionManagerProto"],
			agentProto: ag as ValidatedTargets["agentProto"],
			transcriptSource: ts as ValidatedTargets["transcriptSource"],
		},
	};
}

function installOnce(): PatchOutcome {
	if (cachedOutcome !== undefined) return cachedOutcome;

	let targets: GuardTargets;
	try {
		targets = resolveHostTargets();
	} catch (error) {
		cachedOutcome = { kind: "failed", error: errorText(error) };
		return cachedOutcome;
	}

	const checked = validateTargets(targets);
	if (!checked.ok) {
		cachedOutcome = { kind: "missing", targets: checked.missing };
		return cachedOutcome;
	}

	try {
		wrapUiAndSelectors(checked.value);
		wrapEventAgentAndHub(checked.value);
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
		if (!warnedLog) {
			warnedLog = true;
			pi.logger.warn("task-result-guard: non-snapshot task TUI guard inactive", { outcome });
		}
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
