import { describe, expect, test } from "bun:test";
import type { ToolDocs } from "../agent/extensions/tool-topics/catalog.ts";
import { indexPrompt, toolLines } from "../agent/extensions/tool-topics/prompt.ts";

const checkpointDocs: ToolDocs = {
	tool: "checkpoint",
	surface: undefined,
	topics: [{ name: "rewind", title: "Rewinding", when: "before calling rewind", body: "# Rewind", inject: [] }],
};

const astEditDocs: ToolDocs = {
	tool: "ast_edit",
	surface: "Rewrites code by syntax shape.",
	topics: [{ name: "apply", title: "Applying", when: "before resolve", body: "# Apply", inject: [] }],
};

describe("tool-topics prompt indexing for 19.1.0 tool commands", () => {
	test("rewrites inlined command-mounted tool descriptions and preserves the `<tool> — ` prefix and Usage block", () => {
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

		const cpEntry = toolLines(cp.description, checkpointDocs, true);
		const aeEntry = toolLines(ae.description, astEditDocs, true);
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
				"- `tool://checkpoint/rewind` — before calling rewind",
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
				"- `tool://ast_edit/apply` — before resolve",
				"",
				"Usage:",
			].join("\n"),
		);
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
});
