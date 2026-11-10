// #244 recall semantics, through the extension's real tool_call path: a stub pi
// captures the registered handler; a mocked role chain answers verdicts.
// Covers: miss calls judge, identical repeat hits memory, same-boundary
// different content misses. No seam added to the extension.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RoleModel } from "../agent/extensions/_shared/roles.ts";

let chain: RoleModel[] = [];
const model = (id: string): RoleModel => ({
	role: "default",
	model: { provider: "p", id } as never,
	level: undefined,
});

const answers = new Map<string, string>();
let judgeCalls = 0;
const prompts: string[] = [];

// The extension judges through `completeRoleChain` in `_shared/role-chain.ts`;
// stubbing it answers verdicts without touching the provider SDK.
// `completeSimple` stays real but is never reached: the stubbed chain resolves
// one canned model and answers from `answers` by matching the prompt fragment.
mock.module("../agent/extensions/_shared/role-chain.ts", () => ({
	completeRoleChain: async (
		_ctx: unknown,
		_roles: readonly string[],
		_systemPrompt: string,
		prompt: string,
		_effort: unknown,
		_signal: AbortSignal,
		_budget: unknown,
		_accepts: (stopReason: string) => boolean,
	) => {
		judgeCalls += 1;
		prompts.push(prompt);
		for (const [fragment, line] of answers) {
			if (prompt.includes(fragment)) {
				return {
					kind: "text",
					text: line,
					stopReason: "stop",
					model: { model: { provider: "p", id: "judge" } },
					failures: [],
				};
			}
		}
		const fallback = [...answers.values()][0] ?? "split: false";
		return {
			kind: "text",
			text: fallback,
			stopReason: "stop",
			model: { model: { provider: "p", id: "judge" } },
			failures: [],
		};
	},
}));

mock.module("../agent/extensions/_shared/roles.ts", () => ({
	roleModels: () => chain,
	modelLabel: (m: { provider: string; id: string }) => `${m.provider}/${m.id}`,
}));

// `declaresFlag` gates `split` coverage on agent frontmatter; the harness drives
// `task`, whose report-limit check covers every `task:*` item without flags.
mock.module("../agent/extensions/_shared/agent-definition.ts", () => ({
	declaresFlag: () => Promise.resolve(false),
}));

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

const loadExtension = async (): Promise<{ handler: ToolCallHandler; pi: { logger: { info(): void; warn(): void } } }> => {
	let handler: ToolCallHandler | undefined;
	const logged: { level: string; message: string }[] = [];
	const pi = {
		on: (_event: string, h: ToolCallHandler) => {
			handler = h;
		},
		logger: {
			info: (message: string) => {
				logged.push({ level: "info", message });
			},
			warn: (message: string) => {
				logged.push({ level: "warn", message });
			},
		},
	} as never;
	const { default: taskSplitCheck } = await import("../agent/extensions/task-split-check/index.ts");
	taskSplitCheck(pi);
	if (handler === undefined) throw new Error("task-split-check did not register a tool_call handler");
	return { handler, pi: pi as never };
};

const mainCtx = {
	agent: { kind: "main", id: "Main", name: "main", depth: 0 },
	// split's covers resolves the caller session; no registry session matches the stub.
	sessionManager: { getCwd: () => "/repo", getSessionFile: () => undefined },
	modelRegistry: { resolver: () => undefined },
} as never;

const dispatch = (context: string | undefined, task: string) => ({
	context,
	tasks: [{ name: "probe", agent: "task:low1", task }],
});

describe("task-split-check recall through tool_call", () => {
	beforeEach(() => {
		chain = [model("judge")];
		answers.clear();
		judgeCalls = 0;
		prompts.length = 0;
	});

	test("miss judges, identical repeat recalls, boundary-shifted content judges again", async () => {
		const { handler } = await loadExtension();
		// The reply must not limit the report, or the call blocks and later
		// dispatches diverge; keep the fixture free of report limits.
		answers.set("run the probe command", "report-limit: false");

		const first = await handler({ toolName: "task", input: dispatch("evidence-context", "run the probe command") }, mainCtx);
		expect(first).toBeUndefined();
		expect(judgeCalls).toBe(1);

		const repeat = await handler({ toolName: "task", input: dispatch("evidence-context", "run the probe command") }, mainCtx);
		expect(repeat).toBeUndefined();
		expect(judgeCalls).toBe(1);

		// Length framing keeps the boundary-split keys apart, so this judges again;
		// the two judge prompts carry the exact rendered bytes for their inputs.
		const shifted = await handler({ toolName: "task", input: dispatch("evidence-contex", "trun the probe command") }, mainCtx);
		expect(shifted).toBeUndefined();
		expect(judgeCalls).toBe(2);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe("<shared-context>\nevidence-context\n</shared-context>\n<assignment>\nrun the probe command\n</assignment>");
		expect(prompts[1]).toBe("<shared-context>\nevidence-contex\n</shared-context>\n<assignment>\ntrun the probe command\n</assignment>");
	});

	test("normalization variants share one memory entry", async () => {
		const { handler } = await loadExtension();
		answers.set("do one thing", "report-limit: false");

		const callsBefore = judgeCalls;
		const first = await handler({ toolName: "task", input: dispatch(undefined, "  do one thing  ") }, mainCtx);
		expect(first).toBeUndefined();
		expect(judgeCalls).toBe(callsBefore + 1);

		for (const context of ["", "   "]) {
			const again = await handler({ toolName: "task", input: dispatch(context, "do one thing") }, mainCtx);
			expect(again).toBeUndefined();
		}
		expect(judgeCalls).toBe(callsBefore + 1);
	});
});
