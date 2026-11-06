import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { layerRuleFiles } from "../agent/extensions/model-compaction/rule-files.ts";

describe("model-compaction rule layers", () => {
	test("project rules come first and every machine rule follows, even one named like a project rule", () => {
		const machine = "/home/u/.omp/agent/extensions/model-compaction";
		const m1 = join(machine, "COMPACTION-rule-01.md");
		const m2 = join(machine, "COMPACTION-rule-02.md");
		const p1 = "/work/proj/.omp/COMPACTION-rule-01.md";
		// discoverSpecFiles lists the extension's own directory first.
		expect(layerRuleFiles([m1, m2, p1], machine)).toEqual([p1, m1, m2]);
	});
});
