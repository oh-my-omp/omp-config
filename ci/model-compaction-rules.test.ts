import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerRuleFiles } from "../agent/extensions/model-compaction/rule-files.ts";
import { applyCompactionRules, planCompactionRules } from "../agent/extensions/omp-config-autoupdate/compaction-rules.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function ruleDir(files: Readonly<Record<string, string>>): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-compaction-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

describe("model-compaction rule layers", () => {
	test("project rules come first and the machine rules follow, even when the project file sits under the machine name", () => {
		const machine = "/home/u/.omp/agent/extensions/model-compaction";
		const m = join(machine, "model-compaction.json");
		const p1 = "/work/proj/.omp/model-compaction.json";
		const p2 = "/work/model-compaction.json";
		expect(layerRuleFiles([m, p1, p2], machine)).toEqual([p1, p2, m]);
	});
});

describe("COMPACTION-*.md rules move into model-compaction.json", () => {
	test("rules keep filename order and their values; the md files are deleted", () => {
		const dir = ruleDir({
			"COMPACTION-rule-02.md": "---\nprovider: '^(?!devin$)'\nmodel: \"^claude-sonnet-\"\nthresholdTokens: 350000\n---\n",
			"COMPACTION-rule-01.md": "---\nmodel: [gG][pP][tT]\nthresholdTokens: 650000\n---\n",
			"notes.md": "unrelated\n",
		});
		const plan = planCompactionRules(dir);
		if (plan.kind !== "ready") throw new Error(`expected a ready plan, got ${JSON.stringify(plan)}`);
		applyCompactionRules(plan);
		expect(JSON.parse(readFileSync(join(dir, "model-compaction.json"), "utf8"))).toEqual({
			rules: [
				{ model: "[gG][pP][tT]", thresholdTokens: 650000 },
				{ provider: "^(?!devin$)", model: "^claude-sonnet-", thresholdTokens: 350000 },
			],
		});
		expect(readdirSync(dir).toSorted()).toEqual(["model-compaction.json", "notes.md"]);
		expect(planCompactionRules(dir).kind).toBe("none");
	});

	test("an existing model-compaction.json or an invalid md file leaves every file as it is", () => {
		const existing = ruleDir({
			"COMPACTION-a.md": "---\nmodel: x\nthresholdTokens: 1\n---\n",
			"model-compaction.json": '{ "rules": [] }\n',
		});
		expect(planCompactionRules(existing)).toEqual({
			kind: "kept",
			reason: `${join(existing, "model-compaction.json")} already exists; move the rules of ${join(existing, "COMPACTION-a.md")} into it by hand`,
		});
		const invalid = ruleDir({
			"COMPACTION-a.md": "---\nmodel: x\nthresholdTokens: 1\n---\n",
			"COMPACTION-b.md": "---\nmodel: y\nthresholdTokens: lots\n---\n",
		});
		expect(planCompactionRules(invalid)).toEqual({
			kind: "kept",
			reason: `${join(invalid, "COMPACTION-b.md")}: thresholdTokens must be a positive integer`,
		});
		expect(existsSync(join(invalid, "model-compaction.json"))).toBe(false);
	});
});
