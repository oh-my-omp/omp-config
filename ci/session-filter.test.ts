import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type FilterKeys,
	parseSessionFilter,
	producerMatches,
	type SessionFilter,
	targetsSession,
} from "../agent/extensions/_shared/session-filter.ts";

const KEYS: FilterKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider" };
const main: ExtensionContext["agent"] = { kind: "main", id: "Main", name: "main", depth: 0 };
const mid: ExtensionContext["agent"] = { kind: "sub", id: "0-Fixer", name: "task:mid", depth: 1, parentId: "Main" };
const mentor: ExtensionContext["agent"] = { kind: "sub", id: "1-Coach", name: "mentor:default", depth: 1, parentId: "Main" };

function filter(fields: Record<string, string>): SessionFilter {
	const parsed = parseSessionFilter(fields, KEYS, { kind: "default", targets: [{ kind: "main" }] }, "frontmatter");
	if (parsed.kind !== "ok") throw new Error(JSON.stringify(parsed.problem));
	return parsed.value;
}

describe("session filter targets", () => {
	test("a missing target falls back to the caller's default", () => {
		const f = filter({});
		expect(targetsSession(f, main, "/x")).toBe(true);
		expect(targetsSession(f, mid, "/x")).toBe(false);
	});

	test("a missing target is a problem when the caller requires it", () => {
		expect(parseSessionFilter({}, KEYS, { kind: "required" }, "frontmatter")).toEqual({
			kind: "invalid",
			problem: { kind: "missing", key: "target" },
		});
	});

	test("listed targets are alternatives: main, a subagent name, a registry id", () => {
		const f = filter({ target: "[main, Task:Mid, 1-coach]" });
		expect(targetsSession(f, main, "/x")).toBe(true);
		expect(targetsSession(f, mid, "/x")).toBe(true);
		expect(targetsSession(f, mentor, "/x")).toBe(true);
		const subs = filter({ target: "subagents" });
		expect(targetsSession(subs, main, "/x")).toBe(false);
		expect(targetsSession(subs, mentor, "/x")).toBe(true);
	});
});

describe("session filter cwd globs", () => {
	test("an exact path matches only that directory; /** only its subdirectories", () => {
		const exact = filter({ target: "*", cwd: "/repo" });
		expect(targetsSession(exact, main, "/repo")).toBe(true);
		expect(targetsSession(exact, main, "/repo/")).toBe(true);
		expect(targetsSession(exact, main, "/repo/sub")).toBe(false);
		const below = filter({ target: "*", cwd: "/repo/**" });
		expect(targetsSession(below, main, "/repo")).toBe(false);
		expect(targetsSession(below, main, "/repo/a/b")).toBe(true);
	});

	test("~/ expands to the home directory", () => {
		const f = filter({ target: "*", cwd: "~/code/*" });
		expect(targetsSession(f, main, `${homedir()}/code/app`)).toBe(true);
		expect(targetsSession(f, main, "/code/app")).toBe(false);
	});

	test("cwd ANDs with target, even with target *", () => {
		const f = filter({ target: "main", cwd: "/repo" });
		expect(targetsSession(f, mid, "/repo")).toBe(false);
		expect(targetsSession(filter({ target: "*", cwd: "/repo" }), mid, "/elsewhere")).toBe(false);
	});

	test("a relative pattern is a problem naming the pattern", () => {
		expect(parseSessionFilter({ cwd: "/a, src/*" }, KEYS, { kind: "required" }, "frontmatter")).toMatchObject({
			kind: "invalid",
			problem: { kind: "missing" },
		});
		expect(parseSessionFilter({ target: "main", cwd: "/a, src/*" }, KEYS, { kind: "required" }, "frontmatter")).toEqual({
			kind: "invalid",
			problem: { kind: "relative", key: "cwd", pattern: "src/*" },
		});
	});
});

describe("session filter producers", () => {
	test("every regex must match; absent keys match anything", () => {
		expect(producerMatches(filter({}), { model: "x", provider: "y" })).toBe(true);
		const f = filter({ model: "opus|sonnet", provider: "^anthropic$" });
		expect(producerMatches(f, { model: "claude-sonnet-4-5", provider: "anthropic" })).toBe(true);
		expect(producerMatches(f, { model: "claude-sonnet-4-5", provider: "anthropic-vertex" })).toBe(false);
		expect(producerMatches(f, { model: "gpt-6", provider: "anthropic" })).toBe(false);
	});

	test("keys are looked up case-insensitively but reported as declared", () => {
		const keys: FilterKeys = { ...KEYS, model: "watchModel" };
		expect(parseSessionFilter({ target: "main", watchmodel: "" }, keys, { kind: "required" }, "frontmatter")).toEqual({
			kind: "invalid",
			problem: { kind: "empty", key: "watchModel" },
		});
	});

	test("frontmatter quotes are syntax; a decoded YAML string is the regex source itself", () => {
		const quoted = { target: "main", model: "'^gpt$'" };
		const front = parseSessionFilter(quoted, KEYS, { kind: "required" }, "frontmatter");
		const yaml = parseSessionFilter(quoted, KEYS, { kind: "required" }, "yaml");
		if (front.kind !== "ok" || yaml.kind !== "ok") throw new Error("both parse");
		expect(producerMatches(front.value, { model: "gpt", provider: "p" })).toBe(true);
		expect(producerMatches(yaml.value, { model: "gpt", provider: "p" })).toBe(false);
		expect(producerMatches(yaml.value, { model: "'gpt'", provider: "p" })).toBe(false);
		expect(producerMatches(yaml.value, { model: "x'gpt'", provider: "p" })).toBe(false);
		const literal = parseSessionFilter({ target: "main", model: "^'gpt'$" }, KEYS, { kind: "required" }, "yaml");
		if (literal.kind !== "ok") throw new Error("parses");
		expect(producerMatches(literal.value, { model: "'gpt'", provider: "p" })).toBe(true);
	});
});
