import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { producerMatches, targetsSession } from "../agent/extensions/_shared/session-filter.ts";
import { parseWatchdogFile } from "../agent/extensions/watchdog-agent/spec.ts";

const root = mkdtempSync("/tmp/omp-watchdog-spec-");
const file = join(root, "WATCHDOG-Scope.md");
const main: ExtensionContext["agent"] = { kind: "main", id: "Main", name: "main", depth: 0 };

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function parse(lines: readonly string[], backend: "chat" | "jev") {
	const options =
		backend === "jev" ? ["option.pass: Meets guidance", "option.warn: Misses guidance", "option.warn.prompt: Continue work"] : [];
	writeFileSync(file, `---\n${[...lines, ...options].join("\n")}\n---\nReview the latest work.\n`);
	return parseWatchdogFile(file);
}

describe("observer watchdog (inject: none)", () => {
	test("parses as an observer with no delivery path, keeping tools and model", () => {
		const parsed = parse(["target: main", "inject: None", "tools: [bash, read]", "model: anthropic/claude-haiku-5-5", "every: 25"], "chat");
		expect(parsed).toMatchObject({
			kind: "ok",
			spec: { kind: "observer", tools: ["bash", "read"], model: "anthropic/claude-haiku-5-5", every: 25 },
		});
		if (parsed.kind !== "ok") throw new Error(parsed.reason);
		expect(parsed.spec).not.toHaveProperty("inject");
		expect(parsed.spec).not.toHaveProperty("delivery");
		expect(parsed.spec).not.toHaveProperty("maxPerContext");
	});

	for (const line of ["delivery: steer", "maxPerContext: 2", "note: x", "instructions: x"]) {
		test(`rejects ${line.split(":")[0]} instead of silently ignoring it`, () => {
			expect(parse(["target: main", "inject: none", line], "chat")).toMatchObject({ kind: "invalid" });
		});
	}

	test("requires a body to act on", () => {
		writeFileSync(file, "---\ntarget: main\ninject: none\n---\n");
		expect(parseWatchdogFile(file)).toMatchObject({ kind: "invalid" });
	});
});

for (const backend of ["chat", "jev"] as const) {
	describe(`watchdog frontmatter (${backend})`, () => {
		test("target is required", () => {
			expect(parse([], backend)).toEqual({ kind: "invalid", reason: "frontmatter has no `target`" });
		});

		test("inject defaults to system and accepts user", () => {
			expect(parse(["target: main"], backend)).toMatchObject({ kind: "ok", spec: { inject: "system" } });
			expect(parse(["target: main", "inject: User"], backend)).toMatchObject({ kind: "ok", spec: { inject: "user" } });
		});

		test("an unknown inject value invalidates the file", () => {
			expect(parse(["target: main", "inject: developer"], backend)).toMatchObject({ kind: "invalid" });
		});

		test("watchModel and watchProvider filter producers; model stays the reviewer's", () => {
			const parsed = parse(["target: main", "watchModel: ^gpt-", "watchProvider: codex"], backend);
			if (parsed.kind !== "ok") throw new Error(parsed.reason);
			const filter = parsed.spec.filter;
			expect(producerMatches(filter, { model: "gpt-6-luna", provider: "openai-codex" })).toBe(true);
			expect(producerMatches(filter, { model: "gpt-6-luna", provider: "anthropic" })).toBe(false);
			expect(producerMatches(filter, { model: "claude-opus-5-5", provider: "openai-codex" })).toBe(false);
		});

		test("an invalid watchModel regex invalidates the file", () => {
			expect(parse(["target: main", "watchModel: ("], backend)).toMatchObject({ kind: "invalid" });
		});

		test("cwd globs restrict the watched sessions", () => {
			const parsed = parse(["target: main", "cwd: /tmp/leader{,/**}, /**/worktrees/*"], backend);
			if (parsed.kind !== "ok") throw new Error(parsed.reason);
			const filter = parsed.spec.filter;
			expect(targetsSession(filter, main, "/tmp/leader")).toBe(true);
			expect(targetsSession(filter, main, "/tmp/leader/pkg")).toBe(true);
			expect(targetsSession(filter, main, "/home/u/worktrees/wt-1")).toBe(true);
			expect(targetsSession(filter, main, "/tmp/other")).toBe(false);
		});

		if (backend === "jev") {
			test("inject: none cannot be combined with JUDGE options", () => {
				expect(parse(["target: main", "inject: none"], backend)).toMatchObject({ kind: "invalid" });
			});
		}

		for (const value of ["", '""', "[]", ".", "relative/leader", "/tmp/a, ../b"]) {
			test(`cwd ${JSON.stringify(value)} invalidates the file instead of matching everything`, () => {
				expect(parse(["target: main", `cwd: ${value}`], backend)).toMatchObject({ kind: "invalid" });
			});
		}
	});
}
