import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../agent/extensions/tool-topics/catalog.ts";

const CATALOG_DIR = join(import.meta.dir, "..", "agent", "extensions", "tool-topics");

/** The shipped inject rules, verbatim from the retired `omomp.yml` `tool-topic-injection` section. */
const SHIPPED: Readonly<Record<string, { readonly tool: string; readonly parameter: string; readonly pattern: string }>> = {
	"read-ssh": { tool: "read", parameter: "path", pattern: "^ssh://" },
	"eval-ssh-cat": { tool: "eval", parameter: "code", pattern: "\\bssh\\b[^\\n;|&]*\\bcat\\b" },
	"bash-ssh-cat": { tool: "bash", parameter: "command", pattern: "\\bssh\\b[^\\n;|&]*\\bcat\\b" },
	"read-archives": {
		tool: "read",
		parameter: "path",
		pattern: "\\.(zip|jar|war|whl|apk|vsix|nupkg|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|7z|rar|deb|rpm|iso|asar)(:|$)",
	},
	"read-sqlite": { tool: "read", parameter: "path", pattern: "\\.(sqlite3?|db3?)(:|\\?|$)" },
	"read-json": { tool: "read", parameter: "path", pattern: "\\.(json|jsonl|ndjson)(\\?|:|$)" },
	"read-documents": { tool: "read", parameter: "path", pattern: "\\.(pdf|docx|pptx|xlsx|epub|ipynb)(:|\\?|$)" },
	"read-forge": { tool: "read", parameter: "path", pattern: "^(issue|pr|mr)://" },
	"read-runtime": { tool: "read", parameter: "path", pattern: "^(agent|history|proc|artifact)://" },
	"read-web": { tool: "read", parameter: "path", pattern: "^(https?://|www\\.)" },
	"grep-regex": { tool: "grep", parameter: "pattern", pattern: "\\(\\?[=!<]|\\\\[1-9]|\\\\n|\n" },
	"grep-scopes": { tool: "grep", parameter: "path", pattern: "(^|;)!|://|\\.(zip|jar|whl|tar|tgz|gz|zst):" },
};

function header(inject: string): string {
	return ["---", "tool: read", "name: ssh", "title: t", "when: w", "upstream: u", inject, "---", "body", ""].join("\n");
}

function tempDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tool-topics-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

describe("tool-topics catalog inject entries", () => {
	test("shipped TOPIC files carry the retired omomp rules verbatim", () => {
		const catalog = loadCatalog(CATALOG_DIR);
		expect(catalog.problems).toEqual([]);
		const rules = new Map<string, { tool: string; parameter: string; pattern: RegExp }>();
		for (const docs of catalog.tools.values()) for (const topic of docs.topics) for (const rule of topic.inject) rules.set(rule.id, rule);
		expect([...rules.keys()].sort()).toEqual(Object.keys(SHIPPED).sort());
		for (const [id, expected] of Object.entries(SHIPPED)) {
			const rule = rules.get(id);
			expect(rule?.tool).toBe(expected.tool);
			expect(rule?.parameter).toBe(expected.parameter);
			expect(rule?.pattern).toBeInstanceOf(RegExp);
			expect(rule?.pattern.source).toBe(new RegExp(expected.pattern).source);
		}
	});

	test("a duplicate inject id across files makes the later file a catalog problem", () => {
		const dir = tempDir({
			"TOPIC-read-a.md": header("inject:\n  - id: same\n    tool: read\n    parameter: path\n    pattern: '^a'"),
			"TOPIC-read-b.md": header("inject:\n  - id: same\n    tool: read\n    parameter: path\n    pattern: '^b'"),
		});
		const catalog = loadCatalog(dir);
		expect(catalog.problems).toEqual(["TOPIC-read-b.md: duplicate inject id same"]);
		expect(catalog.tools.get("read")?.topics.length).toBe(1);
	});

	test("an invalid inject pattern skips the whole file", () => {
		const dir = tempDir({ "TOPIC-read-bad.md": header("inject:\n  - id: bad\n    tool: read\n    parameter: path\n    pattern: '('") });
		const catalog = loadCatalog(dir);
		expect(catalog.problems.length).toBe(1);
		expect(catalog.tools.size).toBe(0);
	});
});
