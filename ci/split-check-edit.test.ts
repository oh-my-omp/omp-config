import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { splitCheckEdit } from "../agent/extensions/omp-config-autoupdate/omomp-migration.ts";

const root = mkdtempSync(join(tmpdir(), "split-check-edit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function agentDirWith(frontmatter: string): string {
	const agentDir = join(root, String(seq++));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "task-x.md"), `---\nname: task-x\n${frontmatter}\n---\nbody\n`);
	return agentDir;
}

function hostSetsSplitCheck(frontmatter: string): boolean | "throws" {
	try {
		return parseFrontmatter(`---\nname: task-x\n${frontmatter}\n---\nbody\n`, { level: "fatal" }).frontmatter.splitCheck === true;
	} catch {
		return "throws";
	}
}

const cases: readonly { readonly frontmatter: string; readonly kind: "present" | "declined" | "edit" | "unreadable" }[] = [
	{ frontmatter: "splitCheck: true", kind: "present" },
	{ frontmatter: "split-check: true", kind: "present" },
	{ frontmatter: "splitCheck: true # judged", kind: "present" },
	{ frontmatter: '"splitCheck": true', kind: "present" },
	{ frontmatter: "splitCheck: false", kind: "declined" },
	{ frontmatter: '"splitCheck": false', kind: "declined" },
	{ frontmatter: 'splitCheck: "true"', kind: "declined" },
	{ frontmatter: "splitCheck: tRue", kind: "declined" },
	{ frontmatter: "splitcheck: true", kind: "edit" },
	{ frontmatter: "SplitCheck: true", kind: "edit" },
	{ frontmatter: "options:\n  splitCheck: true", kind: "edit" },
	{ frontmatter: "splitCheck: true\ntags: [a, b", kind: "unreadable" },
];

describe("splitCheckEdit reads agent definitions as omp does", () => {
	for (const { frontmatter, kind } of cases) {
		test(JSON.stringify(frontmatter), () => {
			const edit = splitCheckEdit(agentDirWith(frontmatter), "task-x");
			expect(edit.kind).toBe(kind);
			const host = hostSetsSplitCheck(frontmatter);
			expect(host).toBe(kind === "present" ? true : kind === "unreadable" ? "throws" : false);
		});
	}

	test("an added key keeps every other line and lands before the closing delimiter", () => {
		const edit = splitCheckEdit(agentDirWith("description: d"), "task-x");
		expect(edit).toEqual({
			kind: "edit",
			rel: "agent/agents/task-x.md",
			content: "---\nname: task-x\ndescription: d\nsplitCheck: true\n---\nbody\n",
		});
	});
});
