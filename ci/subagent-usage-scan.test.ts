import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ScanResult } from "../agent/extensions/subagent-usage/records.ts";

const CHUNK = 1 << 20;
const AT = "2026-01-01T00:30:00.000Z";
const HOUR = String(Math.floor(Date.parse(AT) / 3_600_000));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-usage-scan-"));
const sessions = path.join(root, "sessions");
const cachePath = path.join(root, "cache", "transcripts.json");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function assistant(cost: number, padding = 0): string {
	return `${JSON.stringify({
		type: "message",
		timestamp: AT,
		message: {
			role: "assistant",
			provider: "p",
			model: "m",
			usage: { cost: { total: cost } },
			content: [{ type: "text", text: "x".repeat(padding) }],
		},
	})}\n`;
}

function toolResult(padding: number): string {
	return `${JSON.stringify({ type: "message", timestamp: AT, message: { role: "toolResult", content: "y".repeat(padding) } })}\n`;
}

function sized(line: (padding: number) => string, bytes: number): string {
	const text = line(bytes - line(0).length);
	expect(text.length).toBe(bytes);
	return text;
}

const init = `${JSON.stringify({ type: "session_init", agent: "task:low", resolvedModel: "p/m:high" })}\n`;
const exit = `${JSON.stringify({ type: "custom", customType: "session_exit" })}\n`;

function scan(): Promise<Extract<ScanResult, { kind: "done" }>> {
	const { promise, resolve, reject } = Promise.withResolvers<Extract<ScanResult, { kind: "done" }>>();
	const worker = new Worker(new URL("../agent/extensions/subagent-usage/worker.ts", import.meta.url).href);
	worker.onmessage = (event: MessageEvent<ScanResult>) => {
		worker.terminate();
		if (event.data.kind === "done") resolve(event.data);
		else reject(new Error(event.data.reason));
	};
	worker.onerror = (event) => {
		worker.terminate();
		reject(new Error(event.message));
	};
	worker.postMessage({ sessionsRoot: sessions, cachePath });
	return promise;
}

function transcript(name: string): string {
	const file = path.join(sessions, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return file;
}

function spent(result: Extract<ScanResult, { kind: "done" }>): number {
	return result.spend["p/m"]?.[HOUR] ?? 0;
}

describe("subagent-usage transcript scan", () => {
	test("heads that straddle a chunk boundary and lines longer than a chunk are judged on their head", async () => {
		const file = transcript("a/straddle.jsonl");
		let text = "";
		const fill = (until: number): void => {
			text += sized(toolResult, until - text.length);
		};
		fill(CHUNK - 100);
		text += assistant(1, CHUNK + 5_000);
		fill(3 * CHUNK - 100);
		text += toolResult(2 * CHUNK);
		fill(6 * CHUNK - 10);
		text += assistant(2);
		fill(7 * CHUNK - 30);
		text += toolResult(0);
		text += assistant(4);
		fs.writeFileSync(file, text);
		const result = await scan();
		expect(spent(result)).toBe(7);
		expect(result.parsed).toBe(1);
	});

	test("an entry cut off at the end of the file counts once after it is completed", async () => {
		const file = transcript("b/cut.jsonl");
		const whole = assistant(8);
		fs.writeFileSync(file, init + assistant(16) + whole.slice(0, 40));
		const first = await scan();
		expect(spent(first)).toBe(7 + 16);
		fs.appendFileSync(file, whole.slice(40) + exit);
		const second = await scan();
		expect(second.parsed).toBe(1);
		expect(spent(second)).toBe(7 + 16 + 8);
		const dispatch = second.dispatches.find((entry) => entry.file === file);
		expect(dispatch).toMatchObject({
			agent: "task:low",
			resolvedModel: "p/m:high",
			models: ["p/m"],
			exited: true,
			costByProvider: { p: 24 },
		});
	});

	test("appended entries are added to the cached totals without counting earlier ones twice", async () => {
		const file = transcript("c/append.jsonl");
		fs.writeFileSync(file, assistant(32));
		expect(spent(await scan())).toBe(7 + 24 + 32);
		fs.appendFileSync(file, assistant(64));
		const result = await scan();
		expect(result.parsed).toBe(1);
		expect(spent(result)).toBe(7 + 24 + 32 + 64);
		const unchanged = await scan();
		expect(unchanged.parsed).toBe(0);
		expect(spent(unchanged)).toBe(7 + 24 + 32 + 64);
	});

	test("a transcript rewritten in place and grown is read again from its start", async () => {
		const file = transcript("c/append.jsonl");
		fs.writeFileSync(file, `${assistant(128)}${toolResult(500)}${assistant(256)}`);
		const result = await scan();
		expect(result.parsed).toBe(1);
		expect(spent(result)).toBe(7 + 24 + 128 + 256);
	});

	test("a removed transcript leaves the totals", async () => {
		fs.rmSync(transcript("c/append.jsonl"));
		const result = await scan();
		expect(result.files).toBe(2);
		expect(spent(result)).toBe(7 + 24);
	});
});
