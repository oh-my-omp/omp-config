import { describe, expect, test } from "bun:test";
import { fitState, MAX_BYTES_LIMIT, parseMaxBytes, type TimelineEntry } from "../agent/extensions/turn-judge/state.ts";

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const cjk = "中".repeat(10_000);
const escapes = 'a"b\\c\nd'.repeat(2_000);
const emoji = "😀".repeat(10_000);
/** A lone surrogate half anywhere in the text: the sign of a split code point. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("turn-judge maxBytes limit", () => {
	test("64KB is accepted and 64KB + 1 byte is invalid", () => {
		expect(MAX_BYTES_LIMIT).toBe(65_536);
		expect(parseMaxBytes("65536")).toEqual({ kind: "ok", value: 65_536 });
		expect(parseMaxBytes("65537").kind).toBe("invalid");
	});
});

describe("turn-judge fitState", () => {
	test("a small state passes through unchanged", () => {
		const entries: TimelineEntry[] = [
			{ 类型: "用户说", 内容: "hi" },
			{ 类型: "模型想", 内容: "thinking" },
		];
		expect(fitState(entries, "reply", 30_000)).toEqual({ 时间线: entries, 本轮回复: "reply" });
	});

	test("the serialized state stays within maxBytes for CJK, escapes and emoji", () => {
		for (const maxBytes of [200, 777, 4097, 30_000]) {
			for (const big of [cjk, escapes, emoji]) {
				const state = fitState(
					[
						{ 类型: "用户说", 内容: big },
						{ 类型: "模型说", 内容: big },
						{ 类型: "模型想", 内容: big },
					],
					big,
					maxBytes,
				);
				expect(bytes(state)).toBeLessThanOrEqual(maxBytes);
			}
		}
	});

	test("an over-share reply keeps its head and ends with …", () => {
		const state = fitState([{ 类型: "用户说", 内容: "q" }], `HEAD${cjk}`, 30_000);
		expect(state.本轮回复.startsWith("HEAD")).toBe(true);
		expect(state.本轮回复.endsWith("…")).toBe(true);
		expect(bytes(state.本轮回复)).toBeLessThanOrEqual(15_000);
	});

	test("an over-share 用户说 stays the first entry, truncated not dropped", () => {
		const state = fitState(
			[
				{ 类型: "用户说", 内容: `TJ-PROMPT-HEAD\n${cjk}` },
				{ 类型: "模型说", 内容: "ok" },
			],
			"ok",
			30_000,
		);
		const head = state.时间线[0];
		expect(head?.类型).toBe("用户说");
		expect(head?.内容.startsWith("TJ-PROMPT-HEAD")).toBe(true);
		expect(head?.内容.endsWith("…")).toBe(true);
		expect(bytes(head)).toBeLessThanOrEqual(7_500);
	});

	test("an over-budget newest entry is truncated and older entries drop whole", () => {
		const state = fitState(
			[
				{ 类型: "用户说", 内容: "q" },
				{ 类型: "模型想", 内容: "old-1" },
				{ 类型: "模型说", 内容: "old-2" },
				{ 类型: "模型想", 内容: `TJ-ASK-HEAD\n${cjk.repeat(3)}` },
			],
			"ok",
			30_000,
		);
		const newest = state.时间线[state.时间线.length - 1];
		expect(newest?.类型).toBe("模型想");
		expect(newest?.内容.startsWith("TJ-ASK-HEAD")).toBe(true);
		expect(newest?.内容.endsWith("…")).toBe(true);
		expect(state.时间线.some((e) => e.内容 === "old-1")).toBe(false);
		expect(state.时间线.some((e) => e.内容 === "old-2")).toBe(false);
	});

	test("older entries are kept whole, newest first, in chronological order", () => {
		const entries: TimelineEntry[] = [
			{ 类型: "用户说", 内容: "q" },
			{ 类型: "模型说", 内容: "first" },
			{ 类型: "模型调用工具", 内容: "read：x" },
			{ 类型: "模型想", 内容: "last" },
		];
		expect(fitState(entries, "r", 30_000).时间线.map((e) => e.内容)).toEqual(["q", "first", "read：x", "last"]);
	});

	test("truncation never splits a surrogate pair", () => {
		const state = fitState(
			[
				{ 类型: "用户说", 内容: "q" },
				{ 类型: "模型说", 内容: `x${emoji}` },
			],
			`r${emoji}`,
			500,
		);
		const newest = state.时间线[state.时间线.length - 1]?.内容 ?? "";
		expect(newest.endsWith("…")).toBe(true);
		expect(loneSurrogate.test(newest)).toBe(false);
		expect(loneSurrogate.test(state.本轮回复)).toBe(false);
	});

	test("with no 用户说 head, the newest entry still fits and survives", () => {
		const state = fitState(
			[
				{ 类型: "提醒", 内容: cjk },
				{ 类型: "模型说", 内容: cjk },
			],
			"r",
			30_000,
		);
		expect(bytes(state)).toBeLessThanOrEqual(30_000);
		expect(state.时间线[state.时间线.length - 1]?.内容.endsWith("…")).toBe(true);
	});
});
