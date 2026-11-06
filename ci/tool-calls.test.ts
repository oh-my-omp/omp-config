import { describe, expect, test } from "bun:test";
import { type WatchedCall, watchedCallOf } from "../agent/extensions/_shared/tool-calls.ts";

describe("host tool call boundary", () => {
	test("reads native shell and eval calls, including native device writes", () => {
		const tools: readonly ("bash" | "bash_bg")[] = ["bash", "bash_bg"];
		for (const tool of tools) {
			const expected: WatchedCall = { kind: "shell", tool, command: "date" };
			expect(watchedCallOf(tool, { command: "date" })).toEqual(expected);
			expect(watchedCallOf("write", { path: `xd://${tool}`, content: '{"command":"date"}' })).toEqual(expected);
		}
		expect(watchedCallOf("eval", { language: "py", code: "1 + 1" })).toEqual({ kind: "eval", language: "py", code: "1 + 1", reset: false });
	});

	test("ignores direct and device plugin calls regardless of payload", () => {
		for (const payload of [{ cmd: "cat package.json" }, { command: "cat package.json" }, { cmd: "ssh host" }, null]) {
			expect(watchedCallOf("exec_command", payload)).toBeNull();
			expect(watchedCallOf("write", { path: "xd://exec_command", content: JSON.stringify(payload) })).toBeNull();
		}
		expect(watchedCallOf("write", { path: "xd://exec_command", content: "not JSON" })).toBeNull();
	});

	test("ignores malformed native inputs", () => {
		expect(watchedCallOf("bash", { cmd: "date" })).toBeNull();
		expect(watchedCallOf("write", { path: "xd://bash", content: "not JSON" })).toBeNull();
		expect(watchedCallOf("eval", { language: "py" })).toBeNull();
	});
});
