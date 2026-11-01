import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWatchdogFile } from "../agent/extensions/watchdog-agent/spec.ts";

const root = mkdtempSync("/tmp/omp-watchdog-spec-");
const file = join(root, "WATCHDOG-Scope.md");
const leaderCwd = resolve("/tmp/watchdog-leader");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function parse(cwdLine: string | null, backend: "chat" | "jev") {
	const options = backend === "jev" ? "option.pass: Meets guidance\noption.warn: Misses guidance\noption.warn.prompt: Continue work\n" : "";
	writeFileSync(file, `---\ntarget: main\n${cwdLine === null ? "" : `${cwdLine}\n`}${options}---\nReview the latest work.\n`);
	return parseWatchdogFile(file);
}

for (const backend of ["chat", "jev"] as const) {
	describe(`watchdog cwd frontmatter (${backend})`, () => {
		test("omitting cwd leaves directory matching unrestricted", () => {
			expect(parse(null, backend)).toMatchObject({ kind: "ok", spec: { kind: backend, targets: ["main"], cwd: undefined } });
		});

		test("absolute cwd is normalized without requiring the directory to exist", () => {
			expect(parse(`cwd: ${leaderCwd}/./child/../`, backend)).toMatchObject({ kind: "ok", spec: { cwd: leaderCwd } });
		});

		for (const quote of ['"', "'"]) {
			test(`quoted absolute cwd accepts ${quote} quotes and spaces`, () => {
				const cwd = `${leaderCwd} with spaces`;
				expect(parse(`cwd: ${quote}${cwd}/./${quote}`, backend)).toMatchObject({ kind: "ok", spec: { cwd } });
			});
		}

		for (const value of ["", "   ", '""', "''", '"   "', "null", "~"]) {
			test(`explicit empty or null cwd ${JSON.stringify(value)} is invalid, not unrestricted`, () => {
				expect(parse(`cwd: ${value}`, backend)).toEqual({
					kind: "invalid",
					reason: "frontmatter `cwd` must be a nonempty absolute directory path",
				});
			});
		}

		for (const value of [".", "relative/leader", "../leader", '"relative/leader"', "~/leader", "[]", "[/tmp/leader]"]) {
			test(`non-absolute cwd ${JSON.stringify(value)} is invalid`, () => {
				expect(parse(`cwd: ${value}`, backend)).toEqual({
					kind: "invalid",
					reason: "frontmatter `cwd` must be a nonempty absolute directory path",
				});
			});
		}
	});
}
