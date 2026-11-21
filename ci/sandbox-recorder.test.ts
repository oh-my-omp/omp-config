import { describe, expect, test } from "bun:test";
import { parseScenario } from "../sandbox/driver.ts";
import { forwardUrl, pruneConfig, rewriteProviders } from "../sandbox/recorder.ts";

function rewrittenBaseUrl(providers: Record<string, unknown>, name: string): string {
	const value = providers[name];
	if (typeof value !== "object" || value === null || !("baseUrl" in value) || typeof value.baseUrl !== "string")
		throw new Error(`provider ${name} has no rewritten baseUrl`);
	return value.baseUrl;
}

function clientRequestTo(baseUrl: string, suffix: string): URL {
	return new URL(`${baseUrl}${suffix}`);
}

describe("rewriteProviders", () => {
	test("keeps the path of a baseUrl with one, so the client's request paths match the upstream's", () => {
		const { targets, providers } = rewriteProviders({
			pool: { baseUrl: "https://upstream.example/v1", apiKey: "k" },
		});
		expect(targets).toEqual([{ provider: "pool", port: 9400, upstream: "https://upstream.example" }]);
		expect(providers).toEqual({ pool: { baseUrl: "http://127.0.0.1:9400/v1", apiKey: "k" } });
	});

	test("a trailing slash on the path does not survive the rewrite", () => {
		const { providers } = rewriteProviders({ pool: { baseUrl: "https://upstream.example/v1/" } });
		expect(providers).toEqual({ pool: { baseUrl: "http://127.0.0.1:9400/v1" } });
	});

	test("a baseUrl without a path stays origin-only", () => {
		const { targets, providers } = rewriteProviders({ plain: { baseUrl: "https://upstream.example/" } });
		expect(targets).toEqual([{ provider: "plain", port: 9400, upstream: "https://upstream.example" }]);
		expect(providers).toEqual({ plain: { baseUrl: "http://127.0.0.1:9400" } });
	});

	test("providers without a baseUrl are passed through and take no port", () => {
		const original = { none: { apiKey: "k" }, empty: { baseUrl: "" }, pool: { baseUrl: "https://upstream.example/v1" } };
		const { targets, providers } = rewriteProviders(original);
		expect(providers).toEqual({ none: { apiKey: "k" }, empty: { baseUrl: "" }, pool: { baseUrl: "http://127.0.0.1:9400/v1" } });
		expect(targets.map((target) => target.port)).toEqual([9400]);
	});

	test("rewrites model-level baseUrl sharing the provider origin onto the same port", () => {
		const { targets, providers } = rewriteProviders({
			pool: {
				baseUrl: "https://upstream.example/v1",
				apiKey: "k",
				models: [
					{ id: "ernie", api: "anthropic-messages", baseUrl: "https://upstream.example/anthropic/" },
					{ id: "plain", api: "openai-completions" },
				],
				modelOverrides: {
					fast: { baseUrl: "https://upstream.example/fast", reasoning: true },
					unchanged: { reasoning: false },
				},
			},
		});
		expect(targets).toEqual([{ provider: "pool", port: 9400, upstream: "https://upstream.example" }]);
		expect(providers).toEqual({
			pool: {
				baseUrl: "http://127.0.0.1:9400/v1",
				apiKey: "k",
				models: [
					{ id: "ernie", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9400/anthropic" },
					{ id: "plain", api: "openai-completions" },
				],
				modelOverrides: {
					fast: { baseUrl: "http://127.0.0.1:9400/fast", reasoning: true },
					unchanged: { reasoning: false },
				},
			},
		});
	});

	test("allocates a separate target for a model-level baseUrl with a distinct origin and reuses it per origin", () => {
		const { targets, providers } = rewriteProviders({
			pool: {
				baseUrl: "https://upstream.example/v1",
				models: [
					{ id: "a", baseUrl: "https://other.example/anthropic" },
					{ id: "b", baseUrl: "https://other.example/openai/v1/" },
				],
			},
			overrideOnly: {
				modelOverrides: {
					c: { baseUrl: "https://override.example/v1" },
				},
			},
		});
		expect(targets).toEqual([
			{ provider: "pool", port: 9400, upstream: "https://upstream.example" },
			{ provider: "pool", port: 9401, upstream: "https://other.example" },
			{ provider: "overrideOnly", port: 9402, upstream: "https://override.example" },
		]);
		expect(providers).toEqual({
			pool: {
				baseUrl: "http://127.0.0.1:9400/v1",
				models: [
					{ id: "a", baseUrl: "http://127.0.0.1:9401/anthropic" },
					{ id: "b", baseUrl: "http://127.0.0.1:9401/openai/v1" },
				],
			},
			overrideOnly: {
				modelOverrides: {
					c: { baseUrl: "http://127.0.0.1:9402/v1" },
				},
			},
		});
	});
});

describe("forwardUrl", () => {
	test("a request to a rewritten baseUrl with a path reaches the upstream once under that path", () => {
		const { targets, providers } = rewriteProviders({ pool: { baseUrl: "https://upstream.example/v1" } });
		const [target] = targets;
		if (target === undefined) throw new Error("no target");
		const rewritten = rewrittenBaseUrl(providers, "pool");
		expect(forwardUrl(target, clientRequestTo(rewritten, "/models"))).toBe("https://upstream.example/v1/models");
		expect(forwardUrl(target, clientRequestTo(rewritten, "/chat/completions?x=1"))).toBe(
			"https://upstream.example/v1/chat/completions?x=1",
		);
	});

	test("a request to a rewritten origin-only baseUrl is forwarded to the upstream as before", () => {
		const { targets, providers } = rewriteProviders({ plain: { baseUrl: "https://upstream.example" } });
		const [target] = targets;
		if (target === undefined) throw new Error("no target");
		const rewritten = rewrittenBaseUrl(providers, "plain");
		expect(forwardUrl(target, clientRequestTo(rewritten, "/models"))).toBe("https://upstream.example/models");
	});
});

describe("pruneConfig", () => {
	test("filters modelRoles, task.agentModelOverrides, retry.fallbackChains and missing exec.initFile", () => {
		const input = [
			"modelRoles:",
			'  default: "anthropic/claude-opus-5-5:high"',
			'  slow: "anthropic/claude-opus-5-5:high"',
			'  lang-nag: "futureppo-pool/minimax-m3.1-flash"',
			'  mixed: "anthropic/claude-haiku-5-5:medium, futureppo-pool/ernie-5.5-flash-preview:high, bare-model:low"',
			"task:",
			"  maxConcurrency: 4",
			"  agentModelOverrides:",
			'    task:high: "anthropic/claude-opus-5-5:high"',
			'    task:free: "devin/swe-2:high, ernie-5.5-flash-preview:high"',
			'    reviewer: "@slow"',
			'    lint: "@lang-nag:high"',
			'    steady: "futureppo-pool/grok-4.7:medium, commandcode/deepseek/deepseek-v4.1-flash:high"',
			"retry:",
			"  fallbackChains:",
			"    web:",
			"      - anthropic/claude-haiku-4-5",
			'      - "@slow"',
			'      - "@lang-nag"',
			"      - futureppo-pool/ernie-5.5-flash-preview:high",
			"      - fallback-no-provider",
			"exec:",
			"  initFile: /missing/init.sh",
			"  timeout: 30",
			"",
		].join("\n");

		const result = pruneConfig(input, ["futureppo-pool"], (path) => path === "/present/init.sh");
		expect(result.prunedRoles).toEqual(["default", "slow"]);
		expect(result.prunedOverrides).toEqual(["task:high", "reviewer"]);
		expect(Bun.YAML.parse(result.text)).toEqual({
			modelRoles: {
				"lang-nag": "futureppo-pool/minimax-m3.1-flash",
				mixed: "futureppo-pool/ernie-5.5-flash-preview:high, bare-model:low",
			},
			task: {
				maxConcurrency: 4,
				agentModelOverrides: {
					"task:free": "ernie-5.5-flash-preview:high",
					lint: "@lang-nag:high",
					steady: "futureppo-pool/grok-4.7:medium",
				},
			},
			retry: {
				fallbackChains: {
					web: ["@lang-nag", "futureppo-pool/ernie-5.5-flash-preview:high", "fallback-no-provider"],
				},
			},
			exec: {
				timeout: 30,
			},
		});
	});

	test("keeps exec.initFile when it exists and returns non-mapping YAML unchanged", () => {
		const existing = "exec:\n  initFile: /present/init.sh\n";
		const kept = pruneConfig(existing, [], (path) => path === "/present/init.sh");
		expect(Bun.YAML.parse(kept.text)).toEqual({ exec: { initFile: "/present/init.sh" } });

		const scalar = "- a\n- b\n";
		expect(pruneConfig(scalar, [])).toEqual({ text: scalar, prunedRoles: [], prunedOverrides: [] });
	});
});

describe("parseScenario", () => {
	const base = { name: "demo", init: "true", finalAssertion: "true" };

	test("normalizes single prompt into prompts array while preserving prompt", () => {
		const scenario = parseScenario({ ...base, prompt: "say hi" });
		expect(scenario.prompt).toBe("say hi");
		expect(scenario.prompts).toEqual(["say hi"]);
	});

	test("normalizes multi-turn prompts and sets prompt to the first entry", () => {
		const scenario = parseScenario({ ...base, prompts: ["turn one", "turn two"] });
		expect(scenario.prompt).toBe("turn one");
		expect(scenario.prompts).toEqual(["turn one", "turn two"]);
	});

	test("rejects missing, empty, or conflicting prompt fields", () => {
		expect(() => parseScenario(base)).toThrow();
		expect(() => parseScenario({ ...base, prompts: [] })).toThrow();
		expect(() => parseScenario({ ...base, prompts: [1] })).toThrow();
		expect(() => parseScenario({ ...base, prompt: "a", prompts: ["b"] })).toThrow();
	});
});
