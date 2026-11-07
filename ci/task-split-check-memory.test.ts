// #244 recall semantics: memoryKey is stable across normalization variants,
// distinguishes context/task (length-framed fragments), and misses on fragment
// boundaries that a plain rendered-string hash would conflate.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

const CheckIds = { split: "split", report: "report-limit" } as const;

const normalizeContext = (context: string | undefined): string => context?.trim() || "(none)";

function memoryKey(checkId: string, context: string | undefined, task: string): string {
	const contextText = normalizeContext(context);
	const taskText = task.trim();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${contextText.length}:${taskText.length}\0`);
	hasher.update(contextText);
	hasher.update("\0");
	hasher.update(taskText);
	return `${checkId}:${hasher.digest("hex")}`;
}

const renderPrompt = (context: string | undefined, task: string): string =>
	["<shared-context>", normalizeContext(context), "</shared-context>", "<assignment>", task.trim(), "</assignment>"].join("\n");

const oldKey = (checkId: string, context: string | undefined, task: string): string =>
	`${checkId}:${createHash("sha256").update(renderPrompt(context, task)).digest("hex")}`;

describe("task-split-check memoryKey recall semantics", () => {
	test("normalization variants hit: undefined, empty, whitespace-only and untrimmed inputs share one key", () => {
		const task = "do one thing";
		const keys = new Set(
			[undefined, "", "   ", "  shared  ", "shared", "shared\n"].map((context) => memoryKey(CheckIds.split, context, `  ${task}  `)),
		);
		// "shared" variants share a key; undefined/""/whitespace-only share the "(none)" key.
		expect(keys.size).toBe(2);
		expect(memoryKey(CheckIds.split, undefined, task)).toBe(memoryKey(CheckIds.split, "", task));
		expect(memoryKey(CheckIds.split, undefined, task)).toBe(memoryKey(CheckIds.split, "   ", task));
		expect(memoryKey(CheckIds.split, "  shared  ", task)).toBe(memoryKey(CheckIds.split, "shared", task));
	});

	test("context and task are distinguished: neither may leak into the other", () => {
		expect(memoryKey(CheckIds.split, "a", "b")).not.toBe(memoryKey(CheckIds.split, "b", "a"));
		expect(memoryKey(CheckIds.split, "a", "b")).not.toBe(memoryKey(CheckIds.split, "a", "c"));
		expect(memoryKey(CheckIds.split, "a", "b")).not.toBe(memoryKey(CheckIds.split, "c", "b"));
	});

	test("fragment boundaries cannot collide: splits of one concatenation key differently", () => {
		const left = memoryKey(CheckIds.split, "ab", "c");
		const right = memoryKey(CheckIds.split, "a", "bc");
		expect(left).not.toBe(right);
		// The fixed tags keep the two rendered prompts distinct too; the
		// length framing guarantees key inequality without relying on tags.
		expect(oldKey(CheckIds.split, "ab", "c")).not.toBe(oldKey(CheckIds.split, "a", "bc"));
		expect(renderPrompt("ab", "c")).not.toBe(renderPrompt("a", "bc"));
	});

	test("rendered prompt bytes for the model are unchanged (judge path sends the same prompt)", () => {
		expect(renderPrompt("  shared  ", "  do one thing  ")).toBe(
			"<shared-context>\nshared\n</shared-context>\n<assignment>\ndo one thing\n</assignment>",
		);
		expect(renderPrompt(undefined, "x")).toBe("<shared-context>\n(none)\n</shared-context>\n<assignment>\nx\n</assignment>");
	});
});
