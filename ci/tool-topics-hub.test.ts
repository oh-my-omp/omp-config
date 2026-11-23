import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter, type ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { clearToolTopics, registerToolTopics } from "../agent/extensions/_shared/omomp-shared/internal-url.ts";
import type { ToolDocs } from "../agent/extensions/tool-topics/catalog.ts";
import { installToolTopicInjection } from "../agent/extensions/tool-topics/injection.ts";
import { publishTopics } from "../agent/extensions/tool-topics/registry.ts";

const noWarn = (): void => {};

afterEach(() => {
	clearToolTopics();
	InternalUrlRouter.resetForTests();
});

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, fn);
		},
		logger: {
			warn() {},
			info() {},
			debug() {},
			error() {},
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: {
			getLeafId: () => null,
			getEntry: () => undefined,
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
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
		registerToolTopics("omp-ask-more", [
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
							{ id: "bash-trunc", tool: "bash", match: { resultPattern: "artifact://" } },
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

		const { pi, fireToolResult } = fakePi();
		installToolTopicInjection(pi, [
			{ id: "bash-err", tool: "bash", topic: "help://bash/output", match: { onError: true } },
			{ id: "bash-trunc", tool: "bash", topic: "help://bash/output", match: { resultPattern: "artifact://" } },
		]);

		// Non-error, non-truncated bash result -> no injection.
		expect(await fireToolResult({ toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] })).toBeUndefined();

		// Error + truncated bash result -> injected once (not duplicated across both rules).
		const bashRes = await fireToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "failed; full log at artifact://123" }],
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
});
