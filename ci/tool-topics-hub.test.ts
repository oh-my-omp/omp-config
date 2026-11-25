import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter, type ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { clearToolTopics, getToolTopicInjections, registerToolTopics } from "../agent/extensions/_shared/omomp-shared/internal-url.ts";
import type { ToolDocs } from "../agent/extensions/tool-topics/catalog.ts";
import { installToolTopicInjection } from "../agent/extensions/tool-topics/injection.ts";
import { publishTopics } from "../agent/extensions/tool-topics/registry.ts";

const noWarn = (): void => {};

afterEach(() => {
	clearToolTopics();
	InternalUrlRouter.resetForTests();
	for (const ref of AgentRegistry.global().list()) {
		AgentRegistry.global().unregister(ref.id);
	}
});

function fakePi(options?: { readonly sessionId?: string; readonly agentId?: string }) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const warnings: { readonly message: string; readonly meta: unknown }[] = [];
	const pi = {
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, fn);
		},
		logger: {
			warn(message: string, meta?: unknown) {
				warnings.push({ message, meta });
			},
			info() {},
			debug() {},
			error() {},
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp/test",
		agent: { kind: "main", id: options?.agentId ?? "Main", name: "main", depth: 0 },
		sessionManager: {
			getLeafId: () => null,
			getEntry: () => undefined,
			...(options?.sessionId !== undefined ? { getSessionId: () => options.sessionId } : {}),
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		warnings,
		async fireToolResult(event: Partial<ToolResultEvent>): Promise<ToolResultEventResult | undefined> {
			const fn = handlers.get("tool_result");
			if (!fn) throw new Error("tool_result handler not registered");
			return (await fn(
				{
					toolCallId: "tc-1",
					toolName: "bash",
					input: {},
					content: [],
					isError: false,
					...event,
				},
				ctx,
			)) as ToolResultEventResult | undefined;
		},
	};
}

describe("tool-topics unified help:// integration and auto-injection", () => {
	test("wraps native help:// without registering tool://, merging hub topics and native docTopics", async () => {
		const ownTopics: ToolDocs[] = [
			{
				tool: "read",
				surface: undefined,
				topics: [
					{
						name: "failures",
						title: "Read failures",
						when: "after a read fails",
						body: "# Read failures body",
						hiddenFromIndex: true,
						inject: [{ id: "read-err", tool: "read", match: { onError: true } }],
					},
				],
			},
		];
		publishTopics(ownTopics, () => ["read", "ask", "native_only"], noWarn);
		registerToolTopics("omp-ask-ng", [
			{
				tool: "ask",
				topic: "routing",
				title: "Ask routing",
				when: "when asking questions",
				body: "# Ask routing body",
				inject: [{ onError: true }],
			},
		]);

		const router = InternalUrlRouter.instance();
		expect(router.getHandler("tool")).toBeUndefined();
		expect(router.getHandler("help")?.promptReference?.()).toContain("help://<tool>/<topic>");

		const nativeSession = {
			getToolByName(name: string) {
				if (name === "read") return { docTopics: () => ({ urls: "# Native read URLs", sources: "# Native read sources" }) };
				if (name === "native_only") return { docTopics: () => ({ guide: "# Native guide" }) };
				return undefined;
			},
		};
		const resolveCtx = { session: nativeSession } as unknown as ResolveContext;

		const index = await router.resolve("help://", resolveCtx);
		expect(index.content).toContain("## read");
		expect(index.content).toContain("help://read/urls");
		expect(index.content).toContain("## ask");
		expect(index.content).toContain("help://ask/routing");
		expect(index.content).toContain("## native_only");
		expect(index.content).toContain("help://native_only/guide");

		const readList = await router.resolve("help://read", resolveCtx);
		expect(readList.content).toContain("help://read/failures");
		expect(readList.content).toContain("help://read/urls");

		const nativeOnlyList = await router.resolve("help://native_only", resolveCtx);
		expect(nativeOnlyList.content).toContain("help://native_only/guide");

		expect((await router.resolve("help://read/failures", resolveCtx)).content).toBe("# Read failures body");
		expect((await router.resolve("help://read/urls", resolveCtx)).content).toBe("# Native read URLs");
		expect((await router.resolve("help://ask/routing", resolveCtx)).content).toBe("# Ask routing body");
		expect((await router.resolve("help://native_only/guide", resolveCtx)).content).toBe("# Native guide");

		await expect(router.resolve("help://read/no-such-topic", resolveCtx)).rejects.toThrow(
			"Unknown topic 'no-such-topic' for read. Available: failures, sources, urls. Read help://read for the topic index.",
		);
		await expect(router.resolve("help://ask/no-such-topic", resolveCtx)).rejects.toThrow(
			"Unknown topic 'no-such-topic' for ask. Available: routing. Read help://ask for the topic index.",
		);
	});

	test("injects onError, resultPattern, and external hub plugin rules via help:// once per context", async () => {
		const ownTopics: ToolDocs[] = [
			{
				tool: "bash",
				surface: undefined,
				topics: [
					{
						name: "output",
						title: "Bash output",
						when: "when bash fails or truncates",
						body: "# Bash output guidance",
						hiddenFromIndex: true,
						inject: [
							{ id: "bash-err", tool: "bash", match: { onError: true } },
							{ id: "bash-trunc", tool: "bash", match: { resultPattern: "local://\\d+\\.log" } },
						],
					},
				],
			},
		];
		publishTopics(ownTopics, () => [], noWarn);
		registerToolTopics("omp-sessions", [
			{
				tool: "session_query",
				topic: "sql",
				title: "Session SQL",
				when: "when SQL fails",
				body: "# Session SQL guidance",
				inject: [{ onError: true, resultPattern: "SQLITE" }],
			},
		]);

		// Local catalog rules stay local; the shared hub only carries external plugin inject rules.
		expect(getToolTopicInjections().map((doc) => `${doc.tool}/${doc.topic}`)).toEqual(["session_query/sql"]);

		const { pi, fireToolResult } = fakePi();
		installToolTopicInjection(pi, [
			{ id: "bash-err", tool: "bash", topic: "help://bash/output", match: { onError: true } },
			{ id: "bash-trunc", tool: "bash", topic: "help://bash/output", match: { resultPattern: "local://\\d+\\.log" } },
		]);

		// Non-error, non-truncated bash result -> no injection.
		expect(await fireToolResult({ toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] })).toBeUndefined();

		// Error + truncated bash result -> injected once (not duplicated across both rules).
		const bashRes = await fireToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "failed; full log at local://123.log" }],
		});
		expect(bashRes?.additionalContext).toContain('topic="help://bash/output"');
		expect(bashRes?.additionalContext).toContain("# Bash output guidance");
		expect(bashRes?.additionalContext?.match(/<tool-topic-injection /g)?.length).toBe(1);

		// External plugin hub rule: requires both onError and SQLITE match.
		expect(
			await fireToolResult({
				toolName: "session_query",
				isError: false,
				content: [{ type: "text", text: "SQLITE ok" }],
			}),
		).toBeUndefined();
		const sqlRes = await fireToolResult({
			toolName: "session_query",
			isError: true,
			content: [{ type: "text", text: "SQLITE_ERROR: near syntax" }],
		});
		expect(sqlRes?.additionalContext).toContain('topic="help://session_query/sql"');
		expect(sqlRes?.additionalContext).toContain("# Session SQL guidance");
	});

	test("fires cross-tool inject[].tool rules and deduplicates via claimDeliveries", async () => {
		const ownTopics: ToolDocs[] = [
			{
				tool: "read",
				surface: undefined,
				topics: [
					{
						name: "ssh",
						title: "SSH reads",
						when: "before reading remote files",
						body: "# SSH guidance",
						hiddenFromIndex: false,
						inject: [
							{ id: "read-ssh", tool: "read", match: { param: "path", pattern: "^ssh://" } },
							{ id: "bash-ssh-cat", tool: "bash", match: { param: "command", pattern: "\\bssh\\b[^\\n;|&]*\\bcat\\b" } },
						],
					},
				],
			},
		];
		publishTopics(ownTopics, () => ["read", "bash"], noWarn);
		expect(getToolTopicInjections()).toEqual([]);

		const { pi, fireToolResult } = fakePi();
		installToolTopicInjection(
			pi,
			ownTopics.flatMap((docs) =>
				docs.topics.flatMap((topic) =>
					topic.inject.map((rule) => ({ id: rule.id, tool: rule.tool, topic: `help://${docs.tool}/${topic.name}`, match: rule.match })),
				),
			),
		);

		// Cross-tool trigger: bash command matching read/ssh injects help://read/ssh.
		const bashRes = await fireToolResult({
			toolName: "bash",
			input: { command: "ssh prod cat /etc/hosts" },
			content: [{ type: "text", text: "127.0.0.1 localhost" }],
		});
		expect(bashRes?.additionalContext).toContain('topic="help://read/ssh"');
		expect(bashRes?.additionalContext).toContain("# SSH guidance");

		// Repeat cross-tool trigger and same-tool trigger in the same turn are deduplicated.
		expect(
			await fireToolResult({
				toolName: "bash",
				input: { command: "ssh prod cat /etc/resolv.conf" },
				content: [{ type: "text", text: "nameserver 1.1.1.1" }],
			}),
		).toBeUndefined();
		expect(
			await fireToolResult({
				toolName: "read",
				input: { path: "ssh://prod/etc/hosts" },
				content: [{ type: "text", text: "127.0.0.1 localhost" }],
			}),
		).toBeUndefined();
	});

	test("resolves native help:// topics with session context and guards missing session without throwing", async () => {
		publishTopics([], () => ["read"], noWarn);

		// Without a live session in AgentRegistry, native help:// topic is skipped safely (no base.resolve throw).
		const detached = fakePi({ sessionId: "sess-missing", agentId: "Missing" });
		installToolTopicInjection(detached.pi, [{ id: "native-read", tool: "read", topic: "help://read/sources", match: { onError: true } }]);
		const missingRes = await detached.fireToolResult({
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "failed" }],
		});
		expect(missingRes).toBeUndefined();
		expect(detached.warnings.some((entry) => entry.message === "tool-topic-injection: topic unavailable")).toBe(true);
		expect(JSON.stringify(detached.warnings)).toContain("requires a tool session");

		// With a live session in AgentRegistry, native help://read/sources resolves cleanly via ResolveContext.session.
		const liveSession = {
			sessionManager: { getSessionId: () => "sess-live" },
			getToolByName(name: string) {
				if (name === "read") return { docTopics: () => ({ sources: "# Native read sources content" }) };
				return undefined;
			},
		} as unknown as AgentSessionHandle;
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			status: "running",
			session: liveSession,
			sessionFile: null,
		});

		const attached = fakePi({ sessionId: "sess-live", agentId: "Main" });
		installToolTopicInjection(attached.pi, [{ id: "native-read", tool: "read", topic: "help://read/sources", match: { onError: true } }]);
		const liveRes = await attached.fireToolResult({
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "failed" }],
		});
		expect(liveRes?.additionalContext).toContain('topic="help://read/sources"');
		expect(liveRes?.additionalContext).toContain("# Native read sources content");
		expect(attached.warnings).toEqual([]);
	});
});
