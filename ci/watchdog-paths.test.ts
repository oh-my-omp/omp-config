import { describe, expect, test } from "bun:test";
import { touchedWatchdogFiles } from "../agent/extensions/watchdog-agent/spec.ts";

describe("watchdog filesystem writes", () => {
	test("relative paths use the supplied live worktree directory", () => {
		expect(touchedWatchdogFiles("write", { path: ".omp/WATCHDOG-LowTierScope.md" }, undefined, "/tmp/worktree")).toEqual([
			"/tmp/worktree/.omp/WATCHDOG-LowTierScope.md",
		]);
	});

	test("resource URI writes do not fabricate filesystem watchdog paths", () => {
		for (const scheme of ["out", "local", "agent", "xd", "file"]) {
			expect(touchedWatchdogFiles("write", { path: `${scheme}://notes/WATCHDOG-LowTierScope.md` }, undefined, "/tmp/worktree")).toEqual([]);
		}
	});

	test("edits report every path the edit result names, whatever the patch grammar", () => {
		const details = {
			diff: "",
			perFileResults: [
				{ path: "/tmp/worktree/.omp/WATCHDOG-Renamed.md", sourcePath: "/tmp/worktree/.omp/WATCHDOG-Old.md", diff: "" },
				{ path: "/tmp/worktree/src/index.ts", diff: "" },
			],
		};
		expect(touchedWatchdogFiles("edit", { input: "*** Edit File: anything" }, details, "/tmp/worktree")).toEqual([
			"/tmp/worktree/.omp/WATCHDOG-Renamed.md",
			"/tmp/worktree/.omp/WATCHDOG-Old.md",
		]);
	});
});
