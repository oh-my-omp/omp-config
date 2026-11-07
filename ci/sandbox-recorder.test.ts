import { describe, expect, test } from "bun:test";
import { forwardUrl, rewriteProviders } from "../sandbox/recorder.ts";

/** The rewritten `baseUrl` of provider `name`, narrowed at runtime rather than cast. */
function rewrittenBaseUrl(providers: Record<string, unknown>, name: string): string {
	const value = providers[name];
	if (typeof value !== "object" || value === null || !("baseUrl" in value) || typeof value.baseUrl !== "string")
		throw new Error(`provider ${name} has no rewritten baseUrl`);
	return value.baseUrl;
}

/** The URL a client reaches when it requests `${baseUrl}${suffix}` from the rewritten provider. */
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
