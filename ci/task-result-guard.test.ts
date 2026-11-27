import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent, Extension, ExtensionAPI, SessionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canBindAfterStartup } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { type ReplayContext, type ReplayTarget, UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import taskResultGuard, { createTaskResultGuard } from "../agent/extensions/task-result-guard/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function makeApi() {
	const renderers = new Map<string, unknown>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const warnings: Array<{ message: string; data?: unknown }> = [];
	const pi = {
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			renderers.set(customType, renderer);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		logger: {
			warn: (message: string, data?: unknown) => {
				warnings.push({ message, data });
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, renderers, handlers, warnings };
}

function taskResult(id: string, details: unknown, isError = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "task",
		content: [{ type: "text", text: "task outcome" }],
		details,
		isError,
		timestamp: 1_700_000_000_000,
	};
}

function bashResult(id: string, details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "bash outcome" }],
		details,
		isError: false,
		timestamp: 1_700_000_000_000,
	};
}

const VALID_TASK_DETAILS: TaskToolDetails = {
	projectAgentsDir: null,
	results: [
		{
			index: 0,
			id: "Alpha",
			agent: "task:low",
			agentSource: "user",
			task: "check",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 50,
			tokens: 0,
			requests: 1,
		},
	],
	totalDurationMs: 50,
};

describe("task-result-guard", () => {
	test("registers a message renderer so startup-deferral keeps it eager and light mode does not disable it", () => {
		const { pi, renderers, warnings } = makeApi();
		taskResultGuard(pi);
		expect(warnings).toEqual([]);
		expect(renderers.has("mouriya.omp.task-result-guard")).toBe(true);

		const extensionStub = {
			registersProviders: false,
			shortcuts: new Map(),
			composerShapes: new Map(),
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			assistantTextRenderers: [],
			assistantThinkingRenderers: [],
			linkSchemes: [],
			messageRenderers: renderers,
		} as unknown as Extension;
		expect(canBindAfterStartup(extensionStub)).toBe(false);

		const lightConfig = readFileSync(resolve(REPO_ROOT, "agent/config-light.yml"), "utf8");
		expect(lightConfig).not.toContain("task-result-guard");
	});

	test("is idempotent across multiple extension loads in the same process", () => {
		const first = makeApi();
		taskResultGuard(first.pi);
		const renderFn = UiHelpers.prototype.renderSessionContext;
		const handleFn = EventController.prototype.handleEvent;
		const pendingFn = Agent.prototype.getPendingToolResults;
		const parseFn = agentTranscriptSource.parseEntries;

		const second = makeApi();
		taskResultGuard(second.pi);
		expect(UiHelpers.prototype.renderSessionContext).toBe(renderFn);
		expect(EventController.prototype.handleEvent).toBe(handleFn);
		expect(Agent.prototype.getPendingToolResults).toBe(pendingFn);
		expect(agentTranscriptSource.parseEntries).toBe(parseFn);
	});

	test("projects non-snapshot task details to undefined across UiHelpers replay methods without mutating inputs", async () => {
		await Settings.init({ inMemory: true });
		const isolatedSettings = Settings.isolated();
		const { pi } = makeApi();
		taskResultGuard(pi);

		const blocked = taskResult("tc-blocked", {});
		const aborted = taskResult("tc-aborted", { __synthetic: true, source: "assistant_stop_aborted" });
		const errored = taskResult("tc-errored", { __synthetic: true, source: "assistant_stop_error" });
		const skipped = taskResult("tc-skipped", { __synthetic: true, source: "interrupt_skipped" });
		const valid = taskResult("tc-valid", VALID_TASK_DETAILS, false);
		const bash = bashResult("tc-bash", {});

		const seenContexts: ReplayContext[] = [];
		const origRender = Object.getPrototypeOf(UiHelpers.prototype);
		expect(origRender).toBeDefined();

		const makeTarget = (): ReplayTarget => {
			const presentedResults: Array<{ id: string; details: unknown }> = [];
			return {
				pendingTools: new Map(),
				viewSession: {
					activeToolExecutionUpdates: () => [],
					getAsyncJobSnapshot: () => ({ running: [] }),
					getToolByName: () => undefined,
					sessionManager: { getCwd: () => "/tmp", getConversationTip: () => undefined },
					isStreaming: false,
				} as unknown as ReplayTarget["viewSession"],
				lastAssistantUsage: undefined,
				servedModelTracker: undefined as unknown as ReplayTarget["servedModelTracker"],
				statusLine: { refresh: () => {} } as unknown as ReplayTarget["statusLine"],
				updateEditorBorderColor: () => {},
				settings: isolatedSettings,
				hideToolActivity: false,
				transcriptBlocks: new WeakMap(),
				present: (() => ({ id: "b" })) as unknown as ReplayTarget["present"],
				presentAssistant: (() => ({
					block: { id: "a" },
					finalized: { set: () => {} },
					cacheInvalidation: { set: () => {} },
					servedModelMismatch: { set: () => {} },
					turnStats: { set: () => {} },
					suppressedError: { set: () => {} },
				})) as unknown as ReplayTarget["presentAssistant"],
				presentMessage: (() => ({ id: "m" })) as unknown as ReplayTarget["presentMessage"],
				presentToolCall: ((call: { id: string }) => {
					const card = {
						updateResult: (res: { details?: unknown }) => {
							presentedResults.push({ id: call.id, details: res.details });
						},
						seal: () => {},
						parkAsBackground: () => {},
						block: { id: call.id },
					};
					return card;
				}) as unknown as ReplayTarget["presentToolCall"],
				presentReadGroup: (() => ({ seal: () => {} })) as unknown as ReplayTarget["presentReadGroup"],
				presentExecRun: (() => {}) as unknown as ReplayTarget["presentExecRun"],
				shell: {
					native: () => true,
					transcript: {
						blocks: () => [],
						retired: () => false,
						remove: () => {},
						settle: () => {},
					} as unknown as ReplayTarget["shell"]["transcript"],
				},
				__seen: presentedResults,
			} as unknown as ReplayTarget & { __seen: Array<{ id: string; details: unknown }> };
		};

		const assistantCalls: AgentMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "dummy",
			model: "test",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1_700_000_000_000,
			content: [
				{ type: "toolCall", id: "tc-blocked", name: "task", arguments: { task: "a", solutionSpace: "s" } },
				{ type: "toolCall", id: "tc-aborted", name: "task", arguments: { task: "b", solutionSpace: "s" } },
				{ type: "toolCall", id: "tc-errored", name: "task", arguments: { task: "c", solutionSpace: "s" } },
				{ type: "toolCall", id: "tc-skipped", name: "task", arguments: { task: "d", solutionSpace: "s" } },
				{ type: "toolCall", id: "tc-valid", name: "task", arguments: { task: "e", solutionSpace: "s" } },
				{ type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: "echo hi" } },
			],
		};

		const ctxObj: SessionContext = {
			messages: [assistantCalls, blocked, aborted, errored, skipped, valid, bash],
			thinkingLevel: "medium",
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};

		for (const method of ["renderSessionContext", "renderSessionContextIncrementally", "replaySteps"] as const) {
			const target = makeTarget() as ReplayTarget & { __seen: Array<{ id: string; details: unknown }> };
			const helpers = new UiHelpers(target as never);
			if (method === "renderSessionContext") {
				helpers.renderSessionContext(ctxObj);
			} else if (method === "renderSessionContextIncrementally") {
				await helpers.renderSessionContextIncrementally(ctxObj, {});
			} else {
				const gen = helpers.replaySteps(target, ctxObj);
				while (!gen.next().done) {}
			}
			seenContexts.push(ctxObj);
			expect(target.__seen).toEqual([
				{ id: "tc-blocked", details: undefined },
				{ id: "tc-aborted", details: undefined },
				{ id: "tc-errored", details: undefined },
				{ id: "tc-skipped", details: { __synthetic: true, source: "interrupt_skipped" } },
				{ id: "tc-valid", details: VALID_TASK_DETAILS },
				{ id: "tc-bash", details: {} },
			]);
		}

		expect(blocked.details).toEqual({});
		expect(aborted.details).toEqual({ __synthetic: true, source: "assistant_stop_aborted" });
		expect(errored.details).toEqual({ __synthetic: true, source: "assistant_stop_error" });
	});

	test("strips non-snapshot task details in EventController.handleEvent while preserving #syntheticFailureCards cleanup on auto_retry_start", async () => {
		const { pi } = makeApi();
		taskResultGuard(pi);

		const receivedUpdates: Array<{ kind: string; id: string; details: unknown }> = [];
		const removedBlocks: unknown[] = [];
		const pendingTools = new Map<string, unknown>();

		const makeCard = (id: string) => ({
			block: { id },
			call: { facts: { result: () => undefined, partial: () => false, sealed: () => true } },
			updateResult: (res: { details?: unknown }, isPartial?: boolean) => {
				receivedUpdates.push({ kind: isPartial ? "partial" : "final", id, details: res.details });
			},
			parkAsBackground: () => {},
			seal: () => {},
		});

		pendingTools.set("tc-live-block", makeCard("tc-live-block"));
		pendingTools.set("tc-synth-stop", makeCard("tc-synth-stop"));
		pendingTools.set("tc-live-valid", makeCard("tc-live-valid"));

		const controller = new EventController({
			isInitialized: true,
			pendingTools,
			isBackgrounded: false,
			shell: {
				native: () => true,
				transcript: {
					blocks: () => [],
					retired: () => false,
					remove: (b: unknown) => {
						removedBlocks.push(b);
					},
					settle: () => {},
				},
			},
			viewSession: {
				isStreaming: false,
				agent: { state: { streamMessage: undefined } },
			},
			transcriptEntry: () => undefined,
			ensureWorkingLoader: () => {},
			stopWorking: () => {},
			clearPinnedError: () => {},
			showWorking: () => {},
			maintenanceInterruptKey: () => "Esc",
			statusLine: { refresh: () => {} },
			updateEditorBorderColor: () => {},
		} as never);

		const updateEvent: AgentSessionEvent = {
			type: "tool_execution_update",
			toolCallId: "tc-live-block",
			toolName: "task",
			args: {},
			partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
		};
		await controller.handleEvent(updateEvent);
		expect((updateEvent as Extract<AgentSessionEvent, { type: "tool_execution_update" }>).partialResult.details).toEqual({});

		const blockedEnd: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-live-block",
			toolName: "task",
			result: { content: [{ type: "text", text: "blocked" }], details: {} },
			isError: true,
		};
		await controller.handleEvent(blockedEnd);
		expect((blockedEnd as Extract<AgentSessionEvent, { type: "tool_execution_end" }>).result.details).toEqual({});

		const synthDetails = { __synthetic: true, source: "assistant_stop_aborted" };
		const synthEnd: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-synth-stop",
			toolName: "task",
			result: { content: [{ type: "text", text: "aborted" }], details: synthDetails },
			isError: true,
		};
		await controller.handleEvent(synthEnd);
		expect(synthDetails).toEqual({ __synthetic: true, source: "assistant_stop_aborted" });

		const validEnd: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-live-valid",
			toolName: "task",
			result: { content: [{ type: "text", text: "ok" }], details: VALID_TASK_DETAILS },
			isError: false,
		};
		await controller.handleEvent(validEnd);

		expect(receivedUpdates).toEqual([
			{ kind: "partial", id: "tc-live-block", details: undefined },
			{ kind: "final", id: "tc-live-block", details: undefined },
			{ kind: "final", id: "tc-synth-stop", details: undefined },
			{ kind: "final", id: "tc-live-valid", details: VALID_TASK_DETAILS },
		]);

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "transient",
		});
		expect(removedBlocks).toEqual([{ id: "tc-synth-stop" }]);
	});

	test("projects non-snapshot task results in Agent.getPendingToolResults and agentTranscriptSource.parseEntries without mutating stored entries", async () => {
		const { pi } = makeApi();
		taskResultGuard(pi);

		const rawBlocked = taskResult("tc-p1", {});
		const rawSkipped = taskResult("tc-p2", { __synthetic: true, source: "interrupt_skipped" });
		const rawValid = taskResult("tc-p3", VALID_TASK_DETAILS, false);
		const rawBash = bashResult("tc-p4", {});

		let capturedPending: readonly ToolResultMessage[] = [];
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const sink = (options as unknown as { cursorOnToolResult?: (msg: ToolResultMessage) => Promise<void> }).cursorOnToolResult;
				for (const msg of [rawBlocked, rawSkipped, rawValid, rawBash]) {
					void sink?.(msg);
				}
				capturedPending = agent.getPendingToolResults();
				throw new Error("stop-probe");
			},
		});
		await agent.prompt("probe").catch(() => {});
		expect(capturedPending.map((m) => ({ id: m.toolCallId, details: m.details }))).toEqual([
			{ id: "tc-p1", details: undefined },
			{ id: "tc-p2", details: { __synthetic: true, source: "interrupt_skipped" } },
			{ id: "tc-p3", details: VALID_TASK_DETAILS },
			{ id: "tc-p4", details: {} },
		]);
		expect(rawBlocked.details).toEqual({});

		const jsonl = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "01a29999-0000-4000-8000-000000000001",
				timestamp: "2026-11-27T00:00:00.000Z",
				cwd: "/tmp",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-11-27T00:00:01.000Z",
				message: rawBlocked,
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-11-27T00:00:02.000Z",
				message: rawSkipped,
			}),
			JSON.stringify({
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: "2026-11-27T00:00:03.000Z",
				message: rawValid,
			}),
			JSON.stringify({
				type: "message",
				id: "m4",
				parentId: "m3",
				timestamp: "2026-11-27T00:00:04.000Z",
				message: rawBash,
			}),
		].join("\n");

		const parsed = agentTranscriptSource.parseEntries(jsonl);
		const parsedResults = parsed
			.filter((e): e is Extract<(typeof parsed)[number], { type: "message" }> => e.type === "message")
			.map((e) => {
				const msg = e.message as ToolResultMessage;
				return { id: msg.toolCallId, details: msg.details };
			});
		expect(parsedResults).toEqual([
			{ id: "tc-p1", details: undefined },
			{ id: "tc-p2", details: { __synthetic: true, source: "interrupt_skipped" } },
			{ id: "tc-p3", details: VALID_TASK_DETAILS },
			{ id: "tc-p4", details: {} },
		]);
	});

	test("projects plain-terminal /rewind, sibling branch trees, and /copy selectors without mutating SessionManager", () => {
		const { pi } = makeApi();
		taskResultGuard(pi);

		const zeroUsage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manager = SessionManager.inMemory("/tmp/task-guard-selector");
		const u1 = manager.appendMessage({ role: "user", content: "first prompt", timestamp: 100 });
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "dummy",
			model: "test-model",
			stopReason: "toolUse",
			usage: zeroUsage,
			timestamp: 200,
			content: [{ type: "toolCall", id: "tc-sel-main", name: "task", arguments: { task: "main", solutionSpace: "narrow" } }],
		});
		manager.appendMessage(taskResult("tc-sel-main", {}));

		manager.branch(u1);
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "dummy",
			model: "test-model",
			stopReason: "toolUse",
			usage: zeroUsage,
			timestamp: 300,
			content: [{ type: "toolCall", id: "tc-sel-sib", name: "task", arguments: { task: "sib", solutionSpace: "narrow" } }],
		});
		manager.appendMessage(taskResult("tc-sel-sib", { __synthetic: true, source: "assistant_stop_error" }));

		let latestFactory: (() => unknown) | undefined;
		const readLatestFactory = (): (() => unknown) | undefined => latestFactory;
		const fakeController = new SelectorController({
			sessionManager: manager,
			viewSession: { sessionManager: manager },
			shell: {
				native: () => null,
				size: () => ({ rows: 30, cols: 100 }),
				overlays: {
					show: (factory: () => unknown) => {
						latestFactory = factory;
						return { close: () => {} };
					},
				},
			},
			showStatus: () => {},
			focusActiveEditorArea: () => {},
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		fakeController.showUserMessageSelector();
		const rewindFactory = readLatestFactory();
		expect(rewindFactory).toBeDefined();
		const rewindRoot = resolveChildren(rewindFactory?.() as Parameters<typeof resolveChildren>[0])();
		const rewindBar = (rewindRoot[0]?.children() ?? [])[0] as UiNode | undefined;
		expect(rewindBar).toBeDefined();
		const rawRewindTerm = ((rewindBar?.props() ?? {}) as { term?: unknown }).term;
		const rewindTerm = (typeof rawRewindTerm === "function" ? rawRewindTerm() : rawRewindTerm) as
			| { turns: Array<{ blocks: UiNode[] }> }
			| undefined;
		expect(rewindTerm?.turns.length).toBeGreaterThan(0);
		for (const turn of rewindTerm?.turns ?? []) {
			for (const block of turn.blocks) {
				expect(() => block.props()).not.toThrow();
			}
		}

		const tree = manager.getTree();
		const allTreeToolDetails: Array<{ id: string; details: unknown }> = [];
		const walk = (nodes: ReturnType<SessionManager["getTree"]>) => {
			for (const n of nodes) {
				if (n.entry.type === "message" && n.entry.message.role === "toolResult") {
					allTreeToolDetails.push({ id: n.entry.message.toolCallId, details: n.entry.message.details });
				}
				walk(n.children);
			}
		};
		walk(tree);
		expect(allTreeToolDetails).toEqual([
			{ id: "tc-sel-main", details: undefined },
			{ id: "tc-sel-sib", details: undefined },
		]);

		latestFactory = undefined;
		fakeController.showCopySelector();
		const copyFactory = readLatestFactory();
		expect(copyFactory).toBeDefined();
		const copyRoot = resolveChildren(copyFactory?.() as Parameters<typeof resolveChildren>[0])();
		const copyPicker = (copyRoot[0]?.children() ?? [])[0] as UiNode | undefined;
		const rawCopyTerm = ((copyPicker?.props() ?? {}) as { term?: unknown }).term;
		const copyTerm = (typeof rawCopyTerm === "function" ? rawCopyTerm() : rawCopyTerm) as
			| { turns: Array<{ blocks: UiNode[] }> }
			| undefined;
		expect(copyTerm?.turns.length).toBeGreaterThan(0);
		for (const turn of copyTerm?.turns ?? []) {
			for (const block of turn.blocks) {
				expect(() => block.props()).not.toThrow();
			}
		}

		const rawBranchResults = manager
			.getBranch()
			.filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message" && e.message.role === "toolResult")
			.map((e) => (e.message as ToolResultMessage).details);
		expect(rawBranchResults).toEqual([{ __synthetic: true, source: "assistant_stop_error" }]);
	});

	test("logs once per process and notifies once on the main UI session when a host entrypoint is missing", async () => {
		const degradedGuard = createTaskResultGuard({
			uiHelpersProto: {},
			eventControllerProto: EventController.prototype,
			selectorControllerProto: SelectorController.prototype,
			sessionManagerProto: SessionManager.prototype,
			agentProto: Agent.prototype,
			transcriptSource: agentTranscriptSource,
		});

		const api1 = makeApi();
		const outcome1 = degradedGuard(api1.pi);
		const outcome2 = degradedGuard(api1.pi);
		expect(outcome1.kind).toBe("missing");
		expect(outcome2).toEqual(outcome1);
		expect(api1.warnings).toHaveLength(1);

		const notices: Array<{ text: string; level: string }> = [];
		const startHandlers = api1.handlers.get("session_start") ?? [];
		for (const h of startHandlers) {
			await h({}, { agent: { kind: "sub" }, hasUI: true, ui: { notify: (t: string, l: string) => notices.push({ text: t, level: l }) } });
		}
		expect(notices).toHaveLength(0);

		for (const h of startHandlers) {
			await h({}, { agent: { kind: "main" }, hasUI: true, ui: { notify: (t: string, l: string) => notices.push({ text: t, level: l }) } });
			await h({}, { agent: { kind: "main" }, hasUI: true, ui: { notify: (t: string, l: string) => notices.push({ text: t, level: l }) } });
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.text).toContain("UiHelpers.renderSessionContext");
	});
});
