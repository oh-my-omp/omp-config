import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FileOperations } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
} from "@oh-my-pi/pi-coding-agent";
import { COMPACT_REGISTRY_SYMBOL, isCompacting } from "../agent/extensions/_shared/omomp-shared/compact-handoff.ts";
import isolationNudge from "../agent/extensions/isolation-nudge/index.ts";
import langNag from "../agent/extensions/lang-nag/index.ts";
import repoRules from "../agent/extensions/repo-rules/index.ts";
import taskCompletionJudge from "../agent/extensions/task-completion-judge/index.ts";
import toolPolicyNag from "../agent/extensions/tool-policy-nag/index.ts";
import turnJudge from "../agent/extensions/turn-judge/index.ts";
import { registerWatchdog } from "../agent/extensions/watchdog-agent/runtime.ts";

type HookHandler = (event: unknown, ctx: unknown) => unknown;

interface MockHost {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, HookHandler[]>;
	emit<T>(eventName: string, event: unknown, ctx: unknown): Promise<T[]>;
}

function createMockHost(): MockHost {
	const handlers = new Map<string, HookHandler[]>();
	const events = {};
	const logger = {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	};
	const pi = {
		events,
		logger,
		on(eventName: string, handler: HookHandler) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
		},
		registerCommand: () => {},
		registerTool: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;

	return {
		pi,
		handlers,
		async emit<T>(eventName: string, event: unknown, ctx: unknown): Promise<T[]> {
			const results: T[] = [];
			for (const handler of handlers.get(eventName) ?? []) {
				const value = await handler(event, ctx);
				if (value !== undefined) results.push(value as T);
			}
			return results;
		},
	};
}

function createMockCtx(cwd: string): ExtensionContext {
	const sessionManager = {
		getCwd: () => cwd,
		getBranch: () => [],
		getEntries: () => [],
		getLeafId: () => null,
		getSessionFile: () => undefined,
	};
	return {
		cwd,
		agent: { kind: "main", id: "main-1", name: "main" },
		sessionManager,
		hasUI: false,
		isIdle: () => true,
		getSystemPrompt: () => [],
		ui: { notify: () => {}, confirm: async () => false },
	} as unknown as ExtensionContext;
}

function resetRegistry(): void {
	Reflect.deleteProperty(globalThis, COMPACT_REGISTRY_SYMBOL);
}

describe("omp-config compact-handoff integration", () => {
	beforeEach(resetRegistry);
	afterEach(resetRegistry);

	test("all compaction-aware extensions aggregate into one session.compacting handler with claims, guards and in-place fileOps pruning", async () => {
		const host = createMockHost();
		repoRules(host.pi);
		toolPolicyNag(host.pi);
		turnJudge(host.pi);
		registerWatchdog(host.pi);
		langNag(host.pi);
		isolationNudge(host.pi);
		taskCompletionJudge(host.pi);

		expect(host.handlers.get("session.compacting")?.length).toBe(1);

		const ctx = createMockCtx("/repo");
		const fileOps: FileOperations = {
			read: new Set(["/tmp/scratch.log", "/Users/mouriya/.local/state/ghc/run/record.json?q=.results", "/repo/src/index.ts:1-40"]),
			written: new Set(["/repo/src/new.ts"]),
			edited: new Set(["/repo/src/existing.ts?q=foo"]),
		};

		const beforeEvent = {
			type: "session_before_compact",
			preparation: {
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps,
				isSplitTurn: false,
				firstKeptEntryId: "entry-1",
				tokensBefore: 100_000,
			},
			branchEntries: [],
			signal: new AbortController().signal,
		} as unknown as SessionBeforeCompactEvent;

		await host.emit("session_before_compact", beforeEvent, ctx);
		expect(isCompacting(ctx.sessionManager)).toBe(true);
		expect(fileOps.read.has("/tmp/scratch.log")).toBe(false);
		expect(fileOps.read.has("src/index.ts")).toBe(true);
		expect(fileOps.edited.has("src/existing.ts")).toBe(true);
		expect(fileOps.written.has("src/new.ts")).toBe(true);

		const compactingEvent = {
			type: "session.compacting",
			sessionId: "sess-1",
		} as unknown as SessionCompactingEvent;
		const results = await host.emit<SessionCompactingResult>("session.compacting", compactingEvent, ctx);
		expect(results.length).toBe(1);

		const result = results[0];
		expect(result?.prompt).toContain("## User Intent & Session Rulings");
		expect(result?.prompt).toContain("## Decisions & Domain Dead Ends");
		expect(result?.prompt).toContain("## Code Anchors & Verified Invocations");
		expect(result?.prompt).toContain("## Landed Milestones & Executed Verifications");
		expect(result?.prompt).not.toContain("## Handoff to Kept Tail");
		expect(result?.prompt).not.toContain("Active uncommitted worktree/branch state");
		expect(result?.prompt).not.toContain('"Fix X", "Verify Y"');
		const extraContext = (result?.context ?? []).join("\n");
		expect(extraContext).toContain("harness-provided [omp-core]");
		expect(extraContext).toContain("this request stops at the compaction cut");
		expect(extraContext).toContain("live runtime handles");
		expect(extraContext).toContain("[omp-config/repo-rules]");
		expect(extraContext).toContain("noise-guard [omp-config/tool-policy-nag]");
		expect(extraContext).toContain("你为什么不遵守system prompt");
		expect(extraContext).toContain("noise-guard [omp-config/turn-judge]");
		expect(extraContext).toContain("noise-guard [omp-config/watchdog-agent]");
		expect(extraContext).toContain("noise-guard [omp-config/lang-nag]");
		expect(extraContext).toContain("noise-guard [omp-config/isolation-nudge]");
		expect(extraContext).toContain("noise-guard [omp-config/task-completion-judge]");

		const compactEvent = {
			type: "session_compact",
			compactionEntry: {
				type: "compaction",
				id: "cmp-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "ok",
				firstKeptEntryId: "entry-1",
				tokensBefore: 100_000,
			},
			fromExtension: false,
		} as unknown as SessionCompactEvent;
		await host.emit("session_compact", compactEvent, ctx);
		expect(isCompacting(ctx.sessionManager)).toBe(false);
	});
});
