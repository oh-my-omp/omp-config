import { describe, expect, test } from "bun:test";
import { touchedWatchdogFiles } from "../agent/extensions/watchdog-agent/commands.ts";

describe("watchdog filesystem writes", () => {
	test("relative paths use the supplied live worktree directory", () => {
		expect(touchedWatchdogFiles("write", { path: ".omp/WATCHDOG-LowTierScope.md" }, "/tmp/worktree")).toEqual([
			"/tmp/worktree/.omp/WATCHDOG-LowTierScope.md",
		]);
	});

	test("resource URI writes do not fabricate filesystem watchdog paths", () => {
		for (const scheme of ["out", "local", "agent", "xd", "file"]) {
			expect(touchedWatchdogFiles("write", { path: `${scheme}://notes/WATCHDOG-LowTierScope.md` }, "/tmp/worktree")).toEqual([]);
		}
	});

	test("edit headers and move destinations exclude resource URIs", () => {
		const input = "*** Begin Patch\n[.omp/WATCHDOG-LowTierScope.md#ABCD]\nMV out://notes/WATCHDOG-Copy.md\n*** End Patch\n";
		expect(touchedWatchdogFiles("edit", { input }, "/tmp/worktree")).toEqual(["/tmp/worktree/.omp/WATCHDOG-LowTierScope.md"]);
	});
});
