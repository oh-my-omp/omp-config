// ============================================================================
// The root session's persisted transcript, read only as far as a model call needs.
//
// A subagent OMP runs in a subagent worker thread cannot ask its root for a
// branch (`getBranch`), so it reads the root's JSONL transcript instead. Every
// model call needs the same two things from that file: the branch ending at its
// last record, and the text of the prompts and `ask` answers a template names.
// Parsing the whole file per call costs memory proportional to the session, so
// this module keeps one cursor per file: how many bytes were parsed, and for
// every record its parent, its role (prompt / ask answers / neither) and its
// byte range. A call absorbs only the bytes appended since the previous call,
// then re-reads just the ranges a template indexes. The cursor is dropped and
// the file read again from the start when it shrinks or is rewritten.
//
// PARSING. Each record is parsed with the host's own parser (`Bun.JSONL.parseChunk`,
// the parser behind the host's `parseJsonlLenient`), one newline-terminated
// record at a time, which is how OMP writes transcripts. Kept and dropped
// records therefore match the host for line-oriented JSONL, including blank
// lines, malformed lines (skipped to the next newline), two values on one line
// (only the first survives) and a complete final record with no newline. A
// record whose JSON spans several physical lines is not reproduced: the host's
// whole-content parser accepts it, this reader treats each such line on its own.
// ============================================================================

import { closeSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { parseSessionContent, SESSION_TITLE_SLOT_BYTES } from "@oh-my-pi/pi-coding-agent";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { textOf } from "../_shared/messages.ts";

const LF = 0x0a;
/** Bytes read per pass while catching up, so a first read of a long transcript stays bounded. */
const READ_CHUNK_BYTES = 1 << 20;
/** Bytes sampled at the offset and the file head, to notice a rewrite the file's size hides. */
const SEAM_BYTES = 64;

/**
 * Where one branch entry's text comes from. `at` re-derives it from the record's
 * bytes only for the indices a template names, so no prompt or answer text is
 * held between calls.
 */
export type PromptSource = { readonly length: number; at(index: number): string };

/** Which parts of the branch the active templates read. */
export type BranchNeed = { readonly prompts: boolean; readonly answers: boolean };

/** The root branch as the templates consume it. */
export type BranchPrompts = {
	readonly prompts: PromptSource;
	/** Every ask answer on the branch, oldest first; derived on call. */
	answers(): readonly string[];
};

/** What a persisted record contributes to the prompt and answer windows. */
type EntryRole = "prompt" | "answers" | "other";

/** One record's place in the transcript tree and in the windows. */
type EntryFacts = {
	readonly parentId: string | null;
	readonly role: EntryRole;
	/** Byte range of the record, re-read to derive its text. */
	readonly start: number;
	readonly end: number;
};

/** Read state for one transcript file; the only memory that outlives a single call. */
type Cursor = {
	/** Bytes absorbed, always on a record boundary. */
	offset: number;
	/** Size and mtime last accounted for, to tell appends from in-place rewrites. */
	size: number;
	mtimeMs: number;
	dev: number;
	ino: number;
	/** The file's leading bytes, to notice a rewritten prefix that kept or grew the file. */
	head: string;
	/** The bytes ending at the offset, to notice a rewrite between the samples. */
	seam: string;
	/** Entries by id; headers are excluded, they are never on the branch walk. */
	readonly entries: Map<string, EntryFacts>;
	/** Start of the branch walk: the last non-header record in file order. */
	leafId: string | null;
	/** Whether the first record is a session header; the host drops the file when it is not. */
	header: "pending" | "ok" | "invalid";
};

export type TranscriptReader = {
	/** Forget the cursor, so the next read starts from the file's first record. */
	reset(): void;
	/** The branch and the windows, read as far as this pass needs. */
	read(file: string, need: BranchNeed): BranchPrompts;
	/** Close the handle the windows read through; call once the pass is done. */
	release(): void;
};

/** A reader that advances one cursor per transcript file across calls. */
export function createTranscriptReader(): TranscriptReader {
	let cursor: Cursor | null = null;
	/** The file the cursor follows, the handle this pass reads records through, and its buffer. */
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

// --- cursor maintenance -------------------------------------------------------

/**
 * Bring `current` up to the file's current contents: a missing file reads as
 * empty, a replaced, shrunk or in-place rewritten one as a fresh start, and an
 * appended one as the bytes past the offset. The recorded size and mtime are
 * the ones this pass read, never a later observation.
 */
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

/** The file's leading bytes, plus where its first record starts. */
type Head = { readonly bodyStart: number; readonly bytes: string };

/**
 * Read the file head, which does double duty: the optional fixed-width title
 * slot decides where the first record starts (the host strips it before
 * parsing), and the same bytes notice a rewritten prefix that kept or grew the
 * file, the shapes size and mtime cannot tell from an append.
 */
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

/**
 * Absorb newline-terminated records from `offset` up to `size`, reading in
 * chunks so a first read of a long transcript does not hold it all. A trailing
 * fragment with no newline is absorbed for this pass but not committed: the
 * next pass reads it again once the writer terminates it.
 */
function advance(file: string, cursor: Cursor, size: number): void {
	const fd = openSync(file, "r");
	try {
		while (cursor.offset < size) {
			const remaining = size - cursor.offset;
			let window = Math.min(READ_CHUNK_BYTES, remaining);
			let bytes = readBytesAt(fd, cursor.offset, window);
			let end = bytes.lastIndexOf(LF);
			while (end === -1 && window < remaining) {
				// One record longer than a read window: widen until it terminates.
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

/**
 * A short sample of the bytes just before `offset`: the second probe that catches a
 * rewrite which kept the file's first bytes and grew it, which size and mtime cannot
 * tell from an append.
 */
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

/** Absorb every record in `bytes`, which start at `baseOffset`. */
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

/** Fold one record into the cursor; the host's parser decides what it yields. */
function absorbRecord(cursor: Cursor, line: Uint8Array, start: number, end: number): void {
	const value = Bun.JSONL.parseChunk(line).values[0];
	if (value === undefined) return;
	if (cursor.header === "pending") {
		// The host yields no entries at all when the first record is not a session header.
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

/**
 * What the record contributes, decided as the branch scan decides it: a user
 * message with user attribution and text, an `ask` tool result carrying an
 * answer, or nothing. Reading the text here keeps the emptiness rule exact
 * without holding the text.
 */
function roleOf(record: Record<string, unknown>): EntryRole {
	if (record.type !== "message") return "other";
	const message = asRecord(record.message);
	if (message === null) return "other";
	if (message.role === "toolResult") return askAnswers(message) === null ? "other" : "answers";
	if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true) return "other";
	return textOf(message.content, "\n").trim() === "" ? "other" : "prompt";
}

/**
 * The branch the persisted leaf ends: from the last non-header record back
 * through `parentId` to the first, oldest first. Records off that path (another
 * branch's tail) stay in the map but out of the walk.
 */
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

// --- window reads -------------------------------------------------------------

type RecordReader = (facts: EntryFacts) => Record<string, unknown> | null;

/** The text of the prompt at `facts`, re-derived from its record. */
function promptText(read: RecordReader, facts: EntryFacts | undefined): string {
	if (facts === undefined) return "";
	const message = read(facts);
	return message === null ? "" : textOf(message.content, "\n").trim();
}

/** Every ask answer on the branch, oldest first. */
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

/** The message value of one record, parsed by the host's parser from its own bytes. */
function parseMessage(bytes: Uint8Array): Record<string, unknown> | null {
	const value = Bun.JSONL.parseChunk(bytes).values[0];
	const record = value === undefined ? null : asRecord(value);
	return record === null ? null : asRecord(record.message);
}

// --- file and value helpers ---------------------------------------------------

/** Fill up to `length` bytes of `buffer` at `position`; returns how many the file had. */
function readInto(fd: number, buffer: Uint8Array, position: number, length: number): number {
	let filled = 0;
	while (filled < length) {
		const read = readSync(fd, buffer, filled, length - filled, position + filled);
		if (read === 0) break;
		filled += read;
	}
	return filled;
}

/** Exactly `length` bytes at `position`, or fewer at end of file. */
function readBytesAt(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.allocUnsafe(length);
	return buffer.subarray(0, readInto(fd, buffer, position, length));
}

/** An object value, or null for anything else; entries are read field by field, never as a type. */
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
