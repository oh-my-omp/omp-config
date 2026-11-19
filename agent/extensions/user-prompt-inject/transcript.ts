import { closeSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { parseSessionContent, SESSION_TITLE_SLOT_BYTES } from "@oh-my-pi/pi-coding-agent";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { textOf } from "../_shared/messages.ts";

const LF = 0x0a;
const READ_CHUNK_BYTES = 1 << 20;
const SEAM_BYTES = 64;

export type PromptSource = { readonly length: number; at(index: number): string };

export type BranchNeed = { readonly prompts: boolean; readonly answers: boolean };

type BranchPrompts = {
	readonly prompts: PromptSource;
	answers(): readonly string[];
};

type EntryRole = "prompt" | "answers" | "other";

type EntryFacts = {
	readonly parentId: string | null;
	readonly role: EntryRole;
	readonly start: number;
	readonly end: number;
};

type Cursor = {
	offset: number;
	size: number;
	mtimeMs: number;
	dev: number;
	ino: number;
	head: string;
	seam: string;
	readonly entries: Map<string, EntryFacts>;
	leafId: string | null;
	header: "pending" | "ok" | "invalid";
};

export type TranscriptReader = {
	reset(): void;
	read(file: string, need: BranchNeed): BranchPrompts;
	release(): void;
};

export function createTranscriptReader(): TranscriptReader {
	let cursor: Cursor | null = null;
	let cursorFile = "";
	let handle: number | null = null;
	let scratch: Uint8Array = new Uint8Array(0);
	const record = (facts: EntryFacts): Record<string, unknown> | null => {
		handle ??= openSync(cursorFile, "r");
		const length = facts.end - facts.start;
		if (scratch.length < length) scratch = new Uint8Array(length);
		const filled = readInto(handle, scratch, facts.start, length);
		return parseMessage(scratch.subarray(0, filled));
	};

	return {
		reset(): void {
			cursor = null;
		},
		read(file: string, need: BranchNeed): BranchPrompts {
			cursorFile = file;
			cursor = ensureCursor(cursor, file);
			const branch = branchOf(cursor);
			const prompts = need.prompts ? branch.filter((facts) => facts.role === "prompt") : [];
			return {
				prompts: { length: prompts.length, at: (index) => promptText(record, prompts[index]) },
				answers: () => (need.answers ? answerTexts(record, branch) : []),
			};
		},
		release(): void {
			if (handle !== null) {
				closeSync(handle);
				handle = null;
			}
		},
	};
}

function ensureCursor(current: Cursor | null, file: string): Cursor {
	const stats = statSync(file, { throwIfNoEntry: false });
	if (stats === undefined) return emptyCursor();
	const head = headOf(file);
	const seam = sampleBefore(file, current === null ? 0 : current.offset);
	const stale =
		current === null ||
		current.dev !== stats.dev ||
		current.ino !== stats.ino ||
		current.head !== head.bytes ||
		current.seam !== seam ||
		stats.size < current.size ||
		(stats.size === current.size && stats.mtimeMs !== current.mtimeMs);
	const cursor = stale ? startCursor(head, stats) : current;
	if (stats.size > cursor.offset) advance(file, cursor, stats.size);
	cursor.size = stats.size;
	cursor.mtimeMs = stats.mtimeMs;
	cursor.seam = sampleBefore(file, cursor.offset);
	return cursor;
}

function emptyCursor(): Cursor {
	return {
		offset: 0,
		size: 0,
		mtimeMs: 0,
		dev: -1,
		ino: -1,
		head: "",
		seam: "",
		entries: new Map(),
		leafId: null,
		header: "invalid",
	};
}

function startCursor(head: Head, stats: Stats): Cursor {
	return {
		offset: head.bodyStart,
		size: 0,
		mtimeMs: 0,
		dev: stats.dev,
		ino: stats.ino,
		head: head.bytes,
		seam: "",
		entries: new Map(),
		leafId: null,
		header: "pending",
	};
}

type Head = { readonly bodyStart: number; readonly bytes: string };

function headOf(file: string): Head {
	const fd = openSync(file, "r");
	try {
		const bytes = readBytesAt(fd, 0, SESSION_TITLE_SLOT_BYTES);
		const text = bytes.toString("utf8");
		const newline = bytes.indexOf(LF);
		if (newline === -1) return { bodyStart: 0, bytes: text };
		const slot = parseSessionContent(text.slice(0, newline + 1)).titleSlot;
		return { bodyStart: slot === undefined ? 0 : newline + 1, bytes: text };
	} finally {
		closeSync(fd);
	}
}

function advance(file: string, cursor: Cursor, size: number): void {
	const fd = openSync(file, "r");
	try {
		while (cursor.offset < size) {
			const remaining = size - cursor.offset;
			let window = Math.min(READ_CHUNK_BYTES, remaining);
			let bytes = readBytesAt(fd, cursor.offset, window);
			let end = bytes.lastIndexOf(LF);
			while (end === -1 && window < remaining) {
				window = Math.min(window * 2, remaining);
				bytes = readBytesAt(fd, cursor.offset, window);
				end = bytes.lastIndexOf(LF);
			}
			if (end === -1) {
				absorb(cursor, bytes, cursor.offset);
				return;
			}
			absorb(cursor, bytes.subarray(0, end + 1), cursor.offset);
			cursor.offset += end + 1;
		}
	} finally {
		closeSync(fd);
	}
}

function sampleBefore(file: string, offset: number): string {
	if (offset === 0) return "";
	const length = Math.min(SEAM_BYTES, offset);
	const fd = openSync(file, "r");
	try {
		return readBytesAt(fd, offset - length, length).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function absorb(cursor: Cursor, bytes: Buffer, baseOffset: number): void {
	let from = 0;
	while (from < bytes.length) {
		const newline = bytes.indexOf(LF, from);
		const end = newline === -1 ? bytes.length : newline + 1;
		absorbRecord(cursor, bytes.subarray(from, end), baseOffset + from, baseOffset + end);
		if (newline === -1) return;
		from = end;
	}
}

function absorbRecord(cursor: Cursor, line: Uint8Array, start: number, end: number): void {
	const value = Bun.JSONL.parseChunk(line).values[0];
	if (value === undefined) return;
	if (cursor.header === "pending") {
		const header = asRecord(value);
		cursor.header = header !== null && header.type === "session" && typeof header.id === "string" ? "ok" : "invalid";
		return;
	}
	if (cursor.header === "invalid") return;
	const record = asRecord(value);
	if (record === null || record.type === "session" || typeof record.id !== "string") return;
	cursor.entries.set(record.id, factsOf(record, start, end));
	cursor.leafId = record.id;
}

function factsOf(record: Record<string, unknown>, start: number, end: number): EntryFacts {
	const parentId = typeof record.parentId === "string" ? record.parentId : null;
	return { parentId, role: roleOf(record), start, end };
}

function roleOf(record: Record<string, unknown>): EntryRole {
	if (record.type !== "message") return "other";
	const message = asRecord(record.message);
	if (message === null) return "other";
	if (message.role === "toolResult") return askAnswers(message) === null ? "other" : "answers";
	if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true) return "other";
	return textOf(message.content, "\n").trim() === "" ? "other" : "prompt";
}

function branchOf(cursor: Cursor): EntryFacts[] {
	const branch: EntryFacts[] = [];
	const visited = new Set<string>();
	let id = cursor.leafId;
	while (id !== null && !visited.has(id)) {
		visited.add(id);
		const facts = cursor.entries.get(id);
		if (facts === undefined) break;
		branch.push(facts);
		id = facts.parentId;
	}
	branch.reverse();
	return branch;
}

type RecordReader = (facts: EntryFacts) => Record<string, unknown> | null;

function promptText(read: RecordReader, facts: EntryFacts | undefined): string {
	if (facts === undefined) return "";
	const message = read(facts);
	return message === null ? "" : textOf(message.content, "\n").trim();
}

function answerTexts(read: RecordReader, branch: readonly EntryFacts[]): readonly string[] {
	const answers: string[] = [];
	for (const facts of branch) {
		if (facts.role !== "answers") continue;
		const message = read(facts);
		if (message === null) continue;
		const answered = askAnswers(message);
		if (answered !== null) answers.push(formatAskAnswers(answered));
	}
	return answers;
}

function parseMessage(bytes: Uint8Array): Record<string, unknown> | null {
	const value = Bun.JSONL.parseChunk(bytes).values[0];
	const record = value === undefined ? null : asRecord(value);
	return record === null ? null : asRecord(record.message);
}

function readInto(fd: number, buffer: Uint8Array, position: number, length: number): number {
	let filled = 0;
	while (filled < length) {
		const read = readSync(fd, buffer, filled, length - filled, position + filled);
		if (read === 0) break;
		filled += read;
	}
	return filled;
}

function readBytesAt(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.allocUnsafe(length);
	return buffer.subarray(0, readInto(fd, buffer, position, length));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
