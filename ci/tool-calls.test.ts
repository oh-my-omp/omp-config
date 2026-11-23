import { describe, expect, test } from "bun:test";
import { type WatchedCall, watchedCallOf } from "../agent/extensions/_shared/tool-calls.ts";

describe("host tool call boundary", () => {
	test("reads native shell and eval calls", () => {
		const expected: WatchedCall = { kind: "shell", tool: "bash", command: "date", pty: false };
		expect(watchedCallOf("bash", { command: "date" })).toEqual(expected);
		expect(watchedCallOf("bash", { command: "ssh host", pty: true })).toEqual({
			kind: "shell",
			tool: "bash",
			command: "ssh host",
			pty: true,
		});
		expect(watchedCallOf("bash_bg", { command: "date" })).toBeNull();
		expect(watchedCallOf("eval", { language: "py", code: "1 + 1" })).toEqual({ kind: "eval", language: "py", code: "1 + 1", reset: false });
	});

	test("ignores plugin and write calls regardless of payload", () => {
		for (const payload of [{ job_id: "bg_1", chars: "cat package.json" }, { command: "cat package.json" }, null]) {
			expect(watchedCallOf("write_stdin", payload)).toBeNull();
			expect(watchedCallOf("monitor", payload)).toBeNull();
		}
		expect(watchedCallOf("write", { path: "foo.txt", content: '{"command":"date"}' })).toBeNull();
	});

	test("ignores malformed native inputs", () => {
		expect(watchedCallOf("bash", { cmd: "date" })).toBeNull();
		expect(watchedCallOf("eval", { language: "py" })).toBeNull();
	});
});
