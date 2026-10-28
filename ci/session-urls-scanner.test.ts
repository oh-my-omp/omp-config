// Differential tests for agent/extensions/session-urls/scanner.ts: the streaming
// projection of every JSONL line must equal JSON.parse followed by the same
// projection, under every chunking, and malformed/incomplete lines must be
// reported by line number instead of disappearing.
import { describe, expect, test } from "bun:test";
import {
	Clipped,
	each,
	keepAll,
	keys,
	type Policy,
	type Projected,
	type ProjectedObject,
	SKIP,
	scalar,
	scanChunks,
} from "../agent/extensions/session-urls/scanner.ts";

/** Independent oracle: project an already-parsed value with `policy`. */
function project(value: unknown, policy: Policy): Projected | undefined {
	if (policy.kind === "skip") return undefined;
	if (typeof value === "string") {
		if (value.length <= policy.cap) return value;
		const lines = value.length === 0 ? 0 : value.split("\n").length;
		return new Clipped(value.slice(0, policy.cap), value.length, lines);
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		const out: Projected[] = [];
		value.forEach((item, index) => {
			if (index >= policy.maxItems) return;
			const projected = project(item, policy.child(index));
			if (projected !== undefined) out.push(projected);
		});
		return out;
	}
	if (typeof value === "object") {
		const out: ProjectedObject = Object.create(null);
		let index = 0;
		for (const [key, item] of Object.entries(value)) {
			if (index++ >= policy.maxItems) continue;
			const projected = project(item, policy.child(key));
			if (projected !== undefined) out[key] = projected;
		}
		return out;
	}
	throw new Error(`unexpected value ${String(value)}`);
}

/** Plain-data form for structural comparison (class instances and null prototypes normalized). */
function plain(value: Projected): unknown {
	if (value instanceof Clipped) return { clipped: [value.text, value.chars, value.lines] };
	if (Array.isArray(value)) return value.map(plain);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = plain(item);
		return out;
	}
	return value;
}

interface Outcome {
	records: Array<{ line: number; value: unknown }>;
	invalid: number[];
	incomplete: number | null;
}

function oracle(text: string, root: (line: number) => Policy): Outcome {
	const records: Outcome["records"] = [];
	const invalid: number[] = [];
	const lines = text.split("\n");
	const terminated = text.endsWith("\n");
	let incomplete: number | null = null;
	lines.forEach((raw, index) => {
		const line = index + 1;
		const last = index === lines.length - 1;
		if (last && terminated) return;
		if (raw.trim() === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			if (last) incomplete = line;
			else invalid.push(line);
			return;
		}
		const value = project(parsed, root(line));
		if (value !== undefined) records.push({ line, value: plain(value) });
	});
	return { records, invalid, incomplete };
}

async function scan(text: string, root: (line: number) => Policy, chunkSize: number): Promise<Outcome> {
	const bytes = new TextEncoder().encode(text);
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
	const records: Outcome["records"] = [];
	const stats = await scanChunks(chunks, root, (record) => records.push({ line: record.line, value: plain(record.value) }));
	return { records, invalid: [...stats.invalidLines], incomplete: stats.incompleteTail };
}

const CHUNKS = [1, 2, 3, 5, 7, 64, 4096];

async function expectSame(text: string, root: (line: number) => Policy): Promise<void> {
	const expected = oracle(text, root);
	for (const size of CHUNKS) expect({ size, ...(await scan(text, root, size)) }).toEqual({ size, ...expected });
}

const message: Policy = keys({
	role: scalar(64),
	content: {
		kind: "keep",
		cap: 12,
		maxItems: Number.POSITIVE_INFINITY,
		child: () => keys({ type: scalar(32), text: scalar(12), thinking: scalar(12), name: scalar(64), arguments: keepAll(6, 3) }),
	},
	isError: scalar(0),
	toolCallId: scalar(64),
});
const sessionPolicy: Policy = keys({
	type: scalar(64),
	id: scalar(64),
	parentId: scalar(64),
	activeLeafId: scalar(64),
	timestamp: scalar(64),
	message,
	data: keys({ toolCallId: scalar(64), intent: scalar(10) }),
	tags: each(scalar(4), 2),
	n: scalar(0),
});
const everything = keepAll(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

describe("session-urls scanner", () => {
	test("escapes, unicode and numbers match JSON.parse under every chunking", async () => {
		const lines = [
			{ type: "message", id: "a1", parentId: null, message: { role: "user", content: 'quote " back \\ slash / tab\t nl\n cr\r' } },
			{
				type: "message",
				id: "a2",
				parentId: "a1",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "中文思考🙂🙂 with emoji" }] },
			},
			{ type: "x", id: "a3", n: [0, -0, 1.5, -2e-7, Number.POSITIVE_INFINITY, 1e21] },
			{ type: "x", id: "a4", tags: ["abcdef", "", "z", "dropped"], data: { toolCallId: "t", intent: "\u0001ctl" } },
			{
				type: "message",
				id: "a5",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "very/long/path", list: [1, 2, 3, 4, 5], deep: { a: { b: { c: "d" } } } },
						},
					],
				},
			},
			{ __proto__: "own key", type: "proto" },
		];
		const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		await expectSame(text, () => sessionPolicy);
		await expectSame(text, () => everything);
		// \u escapes, a split surrogate pair, an escaped newline, exponent forms and a raw BOM opening a string, by hand.
		const handWritten =
			'{"type":"x","id":"h\\u00e9","message":{"role":"user","content":"\\ud83d\\ude00 a\\u000ab"}}\n{"type":"bom","title":"\uFEFF{x}","n":[1E5,-0,2.5e-3]}\n';
		await expectSame(handWritten, () => sessionPolicy);
		await expectSame(handWritten, () => everything);
	});

	test("clipping keeps the prefix with the full length and line count", async () => {
		const text = `${JSON.stringify({ type: "message", message: { role: "user", content: "line one\nline two\nline three is long" } })}\n`;
		const outcome = await scan(text, () => sessionPolicy, 3);
		expect(outcome.records[0]?.value).toEqual({
			type: "message",
			message: { role: "user", content: { clipped: ["line one\nlin", 36, 3] } },
		});
		await expectSame(text, () => sessionPolicy);
	});

	test("CRLF, blank lines, malformed middle lines and an incomplete tail are reported, not dropped", async () => {
		const text = [
			'{"type":"ok","id":"1"}\r',
			"",
			'{"type":"bad" "id":"2"}',
			'{"type":"bad2","id":"3",}',
			"   ",
			'{"type":"ok","id":"4"}',
			'{"type":"str","id":"5","message":{"role":"us',
		].join("\n");
		const expected = oracle(text, () => sessionPolicy);
		expect(expected.invalid).toEqual([3, 4]);
		expect(expected.incomplete).toBe(7);
		for (const size of CHUNKS) expect(await scan(text, () => sessionPolicy, size)).toEqual(expected);
	});

	test("a raw control byte in a captured string invalidates only its line", async () => {
		const text = '{"type":"a","id":"1"}\n{"type":"b","id":"2\u0001x"}\n{"type":"c","id":"3"}\n';
		await expectSame(text, () => sessionPolicy);
	});

	test("per-line root policy builds only the requested lines", async () => {
		const text = `${[1, 2, 3, 4].map((n) => JSON.stringify({ type: "x", id: String(n), big: "y".repeat(100) })).join("\n")}\n`;
		const root = (line: number): Policy => (line === 3 ? everything : SKIP);
		const outcome = await scan(text, root, 7);
		expect(outcome.records.map((record) => record.line)).toEqual([3]);
		await expectSame(text, root);
	});

	test("random JSONL matches JSON.parse projection", async () => {
		let seed = 0x5eed;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const alphabet = ["a", "Z", " ", '"', "\\", "\n", "/", "é", "中", "🙂", "\t", "{", "]", ":", ","];
		const randomString = (): string => {
			const length = Math.floor(random() * 30);
			let out = "";
			for (let index = 0; index < length; index++) out += alphabet[Math.floor(random() * alphabet.length)];
			return out;
		};
		const randomValue = (depth: number): unknown => {
			const pick = random();
			if (depth > 3 || pick < 0.35) return randomString();
			if (pick < 0.45) return Math.round((random() - 0.5) * 1e6) / 1e3;
			if (pick < 0.5) return random() < 0.5;
			if (pick < 0.55) return null;
			if (pick < 0.75) return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(depth + 1));
			const object: Record<string, unknown> = {};
			for (const key of ["type", "id", "message", "role", "content", "text", "data", "tags", "arguments", "x"]) {
				if (random() < 0.5) object[key] = randomValue(depth + 1);
			}
			return object;
		};
		const records = Array.from({ length: 400 }, () => JSON.stringify(randomValue(0)));
		const text = `${records.join("\n")}\n`;
		await expectSame(text, () => sessionPolicy);
		await expectSame(text, () => keepAll(5, 3));
		await expectSame(text, () => everything);
	});
});
