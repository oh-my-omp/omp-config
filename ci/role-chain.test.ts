import { beforeEach, describe, expect, mock, test } from "bun:test";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { RoleModel } from "../agent/extensions/_shared/roles.ts";

type Outcome = "hang" | "error" | "aborted-reply" | "length" | "toolUse" | "answer";
const outcomes = new Map<string, Outcome>();
const seen: { id: string; signal: AbortSignal | undefined }[] = [];

const usage = { cost: { total: 0 } };
mock.module("@oh-my-pi/pi-agent-core", () => ({
	resolveTelemetry: () => undefined,
	instrumentedCompleteSimple: async (model: { id: string }, _context: unknown, options: { signal?: AbortSignal }) => {
		seen.push({ id: model.id, signal: options.signal });
		const outcome = outcomes.get(model.id) ?? "answer";
		if (outcome === "hang") {
			await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { stopReason: "aborted", content: [], usage };
		}
		if (outcome === "aborted-reply") return { stopReason: "aborted", content: [], usage };
		if (outcome === "error") return { stopReason: "error", errorMessage: "boom", content: [], usage };
		if (outcome === "length" || outcome === "toolUse") {
			return {
				stopReason: outcome === "length" ? "length" : "toolUse",
				content: [{ type: "text", text: `cut from ${model.id}` }],
				usage,
			};
		}
		return { stopReason: "stop", content: [{ type: "text", text: `answer from ${model.id}` }], usage };
	},
}));

const keyless = new Set<string>();
let refusal: Error | undefined;
mock.module("../agent/extensions/_shared/caller-session.ts", () => ({
	callerSession: () => ({
		sessionId: "s",
		sessionManager: {},
		modelRegistry: {
			getApiKey: async (model: { id: string }) => (keyless.has(model.id) ? undefined : "key"),
			resolver: () => undefined,
		},
		costGate: {
			admit: () => {
				if (refusal !== undefined) throw refusal;
			},
			record: () => {},
		},
		agent: { telemetry: undefined, metadataForProvider: () => undefined },
	}),
}));

let chain: RoleModel[] = [];
mock.module("../agent/extensions/_shared/roles.ts", () => ({
	roleModels: () => chain,
	roleName: (value: string) => value,
	modelLabel: (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
}));

const { completeRoleChain } = await import("../agent/extensions/_shared/role-chain.ts");

const model = (id: string): RoleModel => ({
	role: "default",
	model: { provider: "p", id } as never,
	level: undefined,
});
const EFFORT = THINKING_EFFORTS[0] as (typeof THINKING_EFFORTS)[number];
const ACCEPT_ALL = () => true;
const ACCEPT_STOP = (stopReason: string) => stopReason === "stop";
const ctx = {} as never;

beforeEach(() => {
	outcomes.clear();
	seen.length = 0;
	keyless.clear();
	refusal = undefined;
	chain = [model("a"), model("b"), model("c")];
});

describe("completeRoleChain per-attempt admission", () => {
	test("a model without credentials records a failure and the next model answers", async () => {
		keyless.add("a");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_ALL,
		);
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", failures: ["p/a: no API key"] });
		expect(seen.map((call) => call.id)).toEqual(["b"]);
	});

	test("a cost-cap refusal ends the chain with that refusal, sending nothing", async () => {
		refusal = new Error("session cost cap reached");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_ALL,
		);
		expect(reply).toEqual({ kind: "error", error: refusal });
		expect(seen).toEqual([]);
	});
});

describe("completeRoleChain whole budget", () => {
	test("a provider aborted reply ends the pass as aborted, without trying the next model", async () => {
		outcomes.set("a", "aborted-reply");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_ALL,
		);
		expect(reply).toEqual({ kind: "aborted" });
		expect(seen.map((call) => call.id)).toEqual(["a"]);
	});

	test("an error reply records a failure line and moves on", async () => {
		outcomes.set("a", "error");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_ALL,
		);
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", failures: ["p/a: boom"] });
	});

	test("attempts run under the caller's signal alone", async () => {
		const signal = new AbortController().signal;
		await completeRoleChain(ctx, ["default"], "sys", "p", EFFORT, signal, { kind: "whole" }, ACCEPT_ALL);
		expect(seen[0]?.signal).toBe(signal);
	});
});

describe("completeRoleChain split budget", () => {
	test("a hanging model costs its share of the budget and the chain answers from the next model", async () => {
		outcomes.set("a", "hang");
		const started = Date.now();
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{
				kind: "split",
				deadlineAt: Date.now() + 300,
			},
			ACCEPT_ALL,
		);
		const elapsed = Date.now() - started;
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", failures: ["p/a: attempt timeout"] });
		expect(elapsed).toBeGreaterThanOrEqual(90);
		expect(elapsed).toBeLessThan(1000);
	});

	test("with every model hanging, the outer signal ends the pass as deadline", async () => {
		outcomes.set("a", "hang");
		outcomes.set("b", "hang");
		outcomes.set("c", "hang");
		const signal = AbortSignal.timeout(150);
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			signal,
			{
				kind: "split",
				deadlineAt: Date.now() + 150,
			},
			ACCEPT_ALL,
		);
		expect(reply).toEqual({ kind: "deadline" });
	});

	test("a provider aborted reply with the outer signal live is an attempt failure, not an abort", async () => {
		outcomes.set("a", "aborted-reply");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{
				kind: "split",
				deadlineAt: Date.now() + 10_000,
			},
			ACCEPT_ALL,
		);
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", failures: ["p/a: attempt timeout"] });
	});

	test("an empty chain is no-model", async () => {
		chain = [];
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{
				kind: "split",
				deadlineAt: Date.now() + 1000,
			},
			ACCEPT_ALL,
		);
		expect(reply).toEqual({ kind: "no-model" });
	});
});

describe("completeRoleChain stop reasons", () => {
	test("the caller that accepts length gets the cut answer with its stop reason", async () => {
		outcomes.set("a", "length");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_ALL,
		);
		expect(reply).toMatchObject({ kind: "text", text: "cut from a", stopReason: "length", failures: [] });
		expect(seen.map((call) => call.id)).toEqual(["a"]);
	});

	test("a rejected length reply records a failure line and moves to the next model", async () => {
		outcomes.set("a", "length");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_STOP,
		);
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", stopReason: "stop", failures: ["p/a: length"] });
	});

	test("a rejected toolUse reply records a failure line and moves to the next model", async () => {
		outcomes.set("a", "toolUse");
		const reply = await completeRoleChain(
			ctx,
			["default"],
			"sys",
			"p",
			EFFORT,
			new AbortController().signal,
			{ kind: "whole" },
			ACCEPT_STOP,
		);
		expect(reply).toMatchObject({ kind: "text", text: "answer from b", failures: ["p/a: toolUse"] });
	});
});
