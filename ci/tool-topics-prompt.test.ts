import { describe, expect, test } from "bun:test";
import type { ToolDocs } from "../agent/extensions/tool-topics/catalog.ts";
import { indexPrompt, toolLines } from "../agent/extensions/tool-topics/prompt.ts";

const checkpointDocs: ToolDocs = {
	tool: "checkpoint",
	surface: undefined,
	topics: [{ name: "rewind", title: "Rewinding", when: "before calling rewind", body: "# Rewind", hiddenFromIndex: false, inject: [] }],
};

const astEditDocs: ToolDocs = {
	tool: "ast_edit",
	surface: "Rewrites code by syntax shape.",
	topics: [
		{ name: "patterns", title: "Patterns", when: "before writing patterns", body: "# Patterns", hiddenFromIndex: false, inject: [] },
		{ name: "apply", title: "Applying", when: "before resolve", body: "# Apply", hiddenFromIndex: true, inject: [] },
	],
};

describe("tool-topics prompt indexing for 19.1.0 tool commands", () => {
	test("rewrites inlined command-mounted tool descriptions, hides hiddenFromIndex topics, and preserves Usage block", () => {
		const block = [
			"# Tool Commands",
			"Each listed tool is also a command in `bash`.",
			"## checkpoint",
			"",
			"checkpoint — Context checkpoint: before exploratory work.",
			"",
			"Rules:",
			"- MUST rewind before yielding.",
			"",
			"Usage:",
			"  checkpoint [OPTIONS]",
			"",
			"## ast_edit",
			"",
			"ast_edit — Structural AST-aware rewrites.",
			"",
			"Usage:",
			"  ast_edit [OPTIONS]",
		].join("\n");

		const indexed = indexPrompt([block], ["checkpoint", "ast_edit"]);
		const cp = indexed.description("checkpoint");
		const ae = indexed.description("ast_edit");
		expect(cp.kind).toBe("found");
		expect(ae.kind).toBe("found");
		if (cp.kind !== "found" || ae.kind !== "found") throw new Error("expected found");

		const cpEntry = toolLines(cp.description, checkpointDocs);
		const aeEntry = toolLines(ae.description, astEditDocs);
		expect(cpEntry?.kind).toBe("ok");
		expect(aeEntry?.kind).toBe("ok");
		if (cpEntry?.kind !== "ok" || aeEntry?.kind !== "ok") throw new Error("expected ok");

		const [rewritten] = indexed.rewrite([
			{ description: cp.description, lines: cpEntry.lines },
			{ description: ae.description, lines: aeEntry.lines },
		]);
		expect(rewritten).toContain(
			[
				"## checkpoint",
				"",
				"checkpoint — Context checkpoint: before exploratory work.",
				"",
				"Rules:",
				"- MUST rewind before yielding.",
				"",
				"Topics — read the one a call needs before making it:",
				"- `help://checkpoint/rewind` — before calling rewind",
				"",
				"Usage:",
			].join("\n"),
		);
		expect(rewritten).toContain(
			[
				"## ast_edit",
				"",
				"ast_edit — Rewrites code by syntax shape.",
				"",
				"Topics — read the one a call needs before making it:",
				"- `help://ast_edit/patterns` — before writing patterns",
				"",
				"Usage:",
			].join("\n"),
		);
		expect(rewritten).not.toContain("help://ast_edit/apply");
	});

	test("classifies catalog-only command-mounted tools as catalog without drift", () => {
		const block = [
			"# Tool Commands",
			"## More commands (help on demand)",
			"- `checkpoint` — Context checkpoint.",
			"- `github` — gh wrapper.",
			"",
			"Run `<tool> --help` before first use.",
		].join("\n");

		const indexed = indexPrompt([block], ["checkpoint", "github", "debug"]);
		expect(indexed.description("checkpoint")).toEqual({ kind: "catalog" });
		expect(indexed.description("github")).toEqual({ kind: "catalog" });
		expect(indexed.description("debug")).toEqual({ kind: "absent" });
	});

	test("reports drift when an inlined command section lacks the `<tool> — ` header or `Usage:` block", () => {
		const block = ["# Tool Commands", "## checkpoint", "", "Missing prefix.", "", "### Schema"].join("\n");
		const indexed = indexPrompt([block], ["checkpoint"]);
		expect(indexed.description("checkpoint").kind).toBe("drift");
	});

	test("forwards optional native sections and bullets when present and omits cleanly when absent", () => {
		const surface = [
			"Spawn tasks.",
			"",
			"{{native?:Results}}",
			"",
			"# Inputs",
			"- `name`: id",
			"{{native-bullet?:effort}}",
			"{{native-bullet?:model}}",
			"{{native-bullet?:schemaMode}}",
			"",
			"{{native:Available Agents}}",
		].join("\n");
		const taskDocs: ToolDocs = { tool: "task", surface, topics: [] };

		const withAll = [
			"namespace functions {",
			"// Spawn `tasks[]`.",
			"//",
			"// # Results",
			"// `outputSchema` parsed payload: agent://<id> (field /<field>).",
			"//",
			"// # Inputs",
			'// - `effort`: `"lo"`|`"med"`|`"hi"`.',
			"// - `model`: exact provider/model-id.",
			"//   - Approved:",
			"//     - `anthropic/claude-opus-5-5` (slow)",
			"// - `schemaMode`: default permissive.",
			"//",
			"// # Available Agents",
			"// - `task:mid`: worker",
			"type task = (_: {}) => any;",
			"} // namespace functions",
		].join("\n");

		const foundAll = indexPrompt([withAll], ["task"]).description("task");
		expect(foundAll.kind).toBe("found");
		if (foundAll.kind !== "found") throw new Error("expected found");
		const renderedAll = toolLines(foundAll.description, taskDocs);
		expect(renderedAll?.kind).toBe("ok");
		if (renderedAll?.kind !== "ok") throw new Error("expected ok");
		const joinedAll = renderedAll.lines.join("\n");
		expect(joinedAll).toContain("# Results\n`outputSchema` parsed payload: agent://<id> (field /<field>).");
		expect(joinedAll).toContain('- `effort`: `"lo"`|`"med"`|`"hi"`.');
		expect(joinedAll).toContain("- `model`: exact provider/model-id.\n  - Approved:\n    - `anthropic/claude-opus-5-5` (slow)");
		expect(joinedAll).toContain("- `schemaMode`: default permissive.");
		expect(joinedAll).toContain("# Available Agents\n- `task:mid`: worker");

		const minimal = [
			"namespace functions {",
			"// Spawn `tasks[]`.",
			"//",
			"// # Available Agents",
			"// - `task:mid`: worker",
			"type task = (_: {}) => any;",
			"} // namespace functions",
		].join("\n");

		const foundMin = indexPrompt([minimal], ["task"]).description("task");
		expect(foundMin.kind).toBe("found");
		if (foundMin.kind !== "found") throw new Error("expected found");
		const renderedMin = toolLines(foundMin.description, taskDocs);
		expect(renderedMin?.kind).toBe("ok");
		if (renderedMin?.kind !== "ok") throw new Error("expected ok");
		expect(renderedMin.lines.join("\n")).toBe(
			["Spawn tasks.", "", "# Inputs", "- `name`: id", "", "# Available Agents", "- `task:mid`: worker"].join("\n"),
		);
	});

	test("returns undefined when a tool has no surface and only hiddenFromIndex topics", () => {
		const onlyHidden: ToolDocs = {
			tool: "find",
			surface: undefined,
			topics: [{ name: "coverage", title: "Coverage", when: "on partial", body: "# Coverage", hiddenFromIndex: true, inject: [] }],
		};
		const block = ["namespace functions {", "// Search files.", "type find = (_: {}) => any;", "} // namespace functions"].join("\n");
		const found = indexPrompt([block], ["find"]).description("find");
		if (found.kind !== "found") throw new Error("expected found");
		expect(toolLines(found.description, onlyHidden)).toBeUndefined();
	});
});
