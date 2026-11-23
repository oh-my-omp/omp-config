import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InjectRule, loadCatalog } from "../agent/extensions/tool-topics/catalog.ts";

const CATALOG_DIR = join(import.meta.dir, "..", "agent", "extensions", "tool-topics");

const FS_DOC_FILES: readonly string[] = [
	"SURFACE-read.md",
	"TOPIC-read-archives.md",
	"TOPIC-read-binaries.md",
	"TOPIC-read-documents.md",
	"TOPIC-read-failures.md",
	"TOPIC-read-forge.md",
	"TOPIC-read-json.md",
	"TOPIC-read-media.md",
	"TOPIC-read-runtime.md",
	"TOPIC-read-selectors.md",
	"TOPIC-read-sqlite.md",
	"TOPIC-read-ssh.md",
	"TOPIC-read-summaries.md",
	"TOPIC-read-web.md",
	"TOPIC-write-archive.md",
	"TOPIC-write-conflict.md",
	"TOPIC-write-refusals.md",
	"TOPIC-write-sqlite.md",
	"TOPIC-write-urls.md",
	"TOPIC-edit-hashline-moves.md",
	"TOPIC-edit-hashline-recovery.md",
	"TOPIC-find-coverage.md",
	"TOPIC-grep-regex.md",
	"TOPIC-grep-results.md",
	"TOPIC-grep-scopes.md",
];

const SHIPPED_PARAM_RULES: Readonly<Record<string, { readonly tool: string; readonly parameter: string; readonly pattern: string }>> = {
	"read-ssh": { tool: "read", parameter: "path", pattern: "^ssh://" },
	"eval-ssh-cat": { tool: "eval", parameter: "code", pattern: "\\bssh\\b[^\\n;|&]*\\bcat\\b" },
	"bash-ssh-cat": { tool: "bash", parameter: "command", pattern: "\\bssh\\b[^\\n;|&]*\\bcat\\b" },
	"read-archives": {
		tool: "read",
		parameter: "path",
		pattern:
			"\\.(zip|jar|war|ear|whl|apk|ipa|xpi|vsix|nupkg|cbz|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|z|lzma|7z|rar|cbr|cab|cpio|deb|rpm|ar|a|lib|lzh|lha|arj|iso|asar)(:|$)",
	},
	"read-sqlite": { tool: "read", parameter: "path", pattern: "\\.(sqlite3?|db3?)(:|\\?|$)" },
	"read-json": { tool: "read", parameter: "path", pattern: "\\.(json|jsonl|ndjson)(\\?|:|$)" },
	"read-documents": { tool: "read", parameter: "path", pattern: "\\.(pdf|docx|pptx|xlsx|epub|ipynb)(:|\\?|$)" },
	"read-forge": { tool: "read", parameter: "path", pattern: "^(issue|pr|mr)://" },
	"read-runtime": { tool: "read", parameter: "path", pattern: "^(?:(?:agent|history|proc)://|local://\\d+\\.log)" },
	"read-web": { tool: "read", parameter: "path", pattern: "^(https?://|www\\.)" },
	"grep-regex": { tool: "grep", parameter: "pattern", pattern: "\\(\\?[=!<]|\\\\[1-9]|\\\\n|\\n" },
	"grep-scopes": { tool: "grep", parameter: "path", pattern: "(^|;)!|://|\\.(zip|jar|whl|tar|tgz|gz|zst):" },
};

const HIDDEN_RECOVERY_TOPICS: readonly string[] = [
	"read/failures",
	"read/summaries",
	"edit/hashline-recovery",
	"write/refusals",
	"bash/policy",
	"bash/output",
	"find/coverage",
	"grep/results",
	"task/results",
	"task/isolation",
	"ast_edit/apply",
];

function header(extra: string): string {
	return ["---", "tool: read", "name: ssh", "title: t", "when: w", "upstream: u", extra, "---", "body", ""].join("\n");
}

function tempDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tool-topics-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

describe("tool-topics catalog inject entries", () => {
	test("shipped TOPIC files load cleanly with parameter rules and hidden recovery auto-inject rules", () => {
		const catalog = loadCatalog(CATALOG_DIR);
		expect(catalog.problems).toEqual([]);
		const rules = new Map<string, InjectRule>();
		const hidden: string[] = [];
		for (const docs of catalog.tools.values()) {
			for (const topic of docs.topics) {
				if (topic.hiddenFromIndex) {
					hidden.push(`${docs.tool}/${topic.name}`);
					expect(topic.inject.length).toBeGreaterThan(0);
					expect(topic.inject.some((rule) => rule.match.onError === true || rule.match.resultPattern !== undefined)).toBe(true);
				}
				for (const rule of topic.inject) rules.set(rule.id, rule);
			}
		}
		expect(hidden.sort()).toEqual([...HIDDEN_RECOVERY_TOPICS].sort());
		for (const [id, expected] of Object.entries(SHIPPED_PARAM_RULES)) {
			const rule = rules.get(id);
			expect(rule?.tool).toBe(expected.tool);
			expect(rule?.match.param).toBe(expected.parameter);
			expect(rule?.match.pattern).toBe(expected.pattern);
		}
		// Retired dead/duplicate topics stay deleted.
		expect(catalog.tools.get("ask")).toBeUndefined();
		expect(catalog.tools.get("bash")?.topics.some((topic) => topic.name === "waiting")).toBe(false);
		expect(catalog.tools.get("read")?.topics.some((topic) => topic.name === "resources")).toBe(false);
	});

	test("FS group docs target pi-coding-agent@19.1.1 with zero artifact:// and matching 19.1.1 triggers", () => {
		for (const file of FS_DOC_FILES) {
			const text = readFileSync(join(CATALOG_DIR, file), "utf8");
			expect(text).not.toContain("artifact://");
			expect(text).not.toContain("artifact-protocol.ts");
			expect(text).toMatch(/^upstream: pi-coding-agent@19\.1\.1 /m);
		}
		const catalog = loadCatalog(CATALOG_DIR);
		const rules = new Map<string, InjectRule>();
		for (const docs of catalog.tools.values()) {
			for (const topic of docs.topics) {
				for (const rule of topic.inject) rules.set(rule.id, rule);
			}
		}
		const readNotice = new RegExp(rules.get("read-failures-notice")?.match.resultPattern ?? "(?!)");
		expect(readNotice.test("[Cannot read binary file 'foo.bin' (1 KiB); not valid UTF-8 text.]")).toBe(true);
		expect(readNotice.test("[raw output: local://12.log]")).toBe(true);

		const findPartial = new RegExp(rules.get("find-coverage-partial")?.match.resultPattern ?? "(?!)");
		expect(findPartial.test('find timed out after 20.0s at "verifying", before any passage was verified.')).toBe(true);

		const readSummary = new RegExp(rules.get("read-summaries-folded")?.match.resultPattern ?? "(?!)");
		expect(readSummary.test("[…42ln elided; re-read needed ranges, e.g. foo.ts:5-47]")).toBe(true);
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

	test("an invalid inject pattern or resultPattern skips the whole file", () => {
		const dir = tempDir({
			"TOPIC-read-bad-param.md": header("inject:\n  - id: bad\n    tool: read\n    parameter: path\n    pattern: '('"),
			"TOPIC-read-bad-result.md": header("inject:\n  - id: bad2\n    tool: read\n    resultPattern: '('"),
			"TOPIC-read-empty-rule.md": header("inject:\n  - id: empty\n    tool: read"),
		});
		const catalog = loadCatalog(dir);
		expect(catalog.problems.length).toBe(3);
		expect(catalog.tools.size).toBe(0);
	});

	test("parses hiddenFromIndex, onError, and resultPattern with default tool", () => {
		const dir = tempDir({
			"TOPIC-read-recover.md": header(
				"hiddenFromIndex: true\ninject:\n  - id: err\n    onError: true\n  - id: pat\n    resultPattern: 'truncated'",
			),
		});
		const catalog = loadCatalog(dir);
		expect(catalog.problems).toEqual([]);
		const topic = catalog.tools.get("read")?.topics[0];
		expect(topic?.hiddenFromIndex).toBe(true);
		expect(topic?.inject).toHaveLength(2);
		expect(topic?.inject[0]?.tool).toBe("read");
		expect(topic?.inject[0]?.match.onError).toBe(true);
		expect(topic?.inject[1]?.match.resultPattern).toBe("truncated");
	});
});
