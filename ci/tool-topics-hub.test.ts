import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { clearToolTopics, registerToolTopics } from "../agent/extensions/_shared/omomp-shared/internal-url.ts";
import type { Topic } from "../agent/extensions/tool-topics/catalog.ts";
import { installToolTopicInjection } from "../agent/extensions/tool-topics/injection.ts";
import { publishTopics } from "../agent/extensions/tool-topics/registry.ts";

afterEach(() => {
	clearToolTopics();
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

describe("tool-topics shared hub integration and auto-injection", () => {
	test("coexists with external plugins registered on the shared tool:// hub", async () => {
		const ownTopics = new Map<string, readonly Topic[]>([
			[
				"read",
				[
					{
						name: "failures",
						title: "Read failures",
						when: "after a read fails",
						body: "# Read failures body",
						hiddenFromIndex: true,
						inject: [{ id: "read-err", tool: "read", onError: true }],
					},
				],
			],
		]);
		expect(publishTopics(ownTopics)).toEqual({ kind: "registered" });
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
		const index = await router.resolve("tool://");
		expect(index.content).toContain("## read");
		expect(index.content).toContain("## ask");
		expect((await router.resolve("tool://read/failures")).content).toBe("# Read failures body");
		expect((await router.resolve("tool://ask/routing")).content).toBe("# Ask routing body");
	});

	test("injects onError, resultPattern, and external hub plugin rules once per context", async () => {
		const ownTopics = new Map<string, readonly Topic[]>([
			[
				"bash",
				[
					{
						name: "output",
						title: "Bash output",
						when: "when bash fails or truncates",
						body: "# Bash output guidance",
						hiddenFromIndex: true,
						inject: [
							{ id: "bash-err", tool: "bash", onError: true },
							{ id: "bash-trunc", tool: "bash", resultPattern: /artifact:\/\//, resultPatternSource: "artifact://" },
						],
					},
				],
			],
		]);
		publishTopics(ownTopics);
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
		installToolTopicInjection(pi, {
			owner: "omp-config/tool-topic-injection",
			rules: [
				{ id: "bash-err", tool: "bash", onError: true, topic: "tool://bash/output" },
				{ id: "bash-trunc", tool: "bash", resultPattern: /artifact:\/\//, topic: "tool://bash/output" },
			],
		});

		// Non-error, non-truncated bash result -> no injection.
		expect(await fireToolResult({ toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] })).toBeUndefined();

		// Error + truncated bash result -> injected once (not duplicated across both rules).
		const bashRes = await fireToolResult({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "failed; full log at artifact://123" }],
		});
		expect(bashRes?.additionalContext).toContain('topic="tool://bash/output"');
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
		expect(sqlRes?.additionalContext).toContain('topic="tool://session_query/sql"');
		expect(sqlRes?.additionalContext).toContain("# Session SQL guidance");
	});
});
