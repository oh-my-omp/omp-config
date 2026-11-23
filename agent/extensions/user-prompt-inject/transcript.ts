import { closeSync, openSync, readSync, type Stats, statSync } from "node:fs";
import type { ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { type SessionEntry, z, type zod } from "@oh-my-pi/pi-coding-agent";
import { SESSION_TITLE_SLOT_BYTES, type SessionEntryBase, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { type MessageContent, parseStoredContent, textOf } from "../_shared/messages.ts";

const LF = 0x0a;
const READ_CHUNK_BYTES = 1 << 20;
const SEAM_BYTES = 64;

export type BranchNeed = { readonly prompts: boolean; readonly answers: boolean };

export type RootView = {
	readonly prompts: { readonly length: number; at(index: number): string };
	readonly answers: readonly string[];
};

type PromptMessage = Pick<UserMessage, "role" | "synthetic" | "attribution"> & { readonly content: MessageContent };

type AnswerMessage = Pick<ToolResultMessage, "role" | "toolName" | "isError" | "details">;

type RoleMessage = PromptMessage | AnswerMessage;

type StoredEntry = Pick<SessionEntryBase, "type" | "id" | "parentId"> & { readonly message?: unknown };

const storedHeader: zod.ZodLikeSchema<Pick<SessionHeader, "type" | "id">> = z.object({ type: z.literal("session"), id: z.string() });

const storedEntry: zod.ZodLikeSchema<StoredEntry> = z.object({
	type: z.string(),
	id: z.string(),
	parentId: z.union([z.string(), z.null()]),
	message: z.unknown().optional(),
});

const storedMessage: zod.ZodLikeSchema<RoleMessage> = z.union([
	z.object({
		role: z.literal("user"),
		content: z.unknown().transform(parseStoredContent),
		synthetic: z.boolean().optional(),
		attribution: z.enum(["user", "agent"]).optional(),
	}),
	z.object({
		role: z.literal("toolResult"),
		toolName: z.string(),
		isError: z.boolean(),
		details: z.unknown().optional(),
	}),
]);

type Classified =
	| { readonly kind: "prompt"; readonly text: string }
	| { readonly kind: "answers"; readonly text: string }
	| { readonly kind: "other" };

const OTHER: Classified = { kind: "other" };

const EMPTY_VIEW: RootView = { prompts: { length: 0, at: () => "" }, answers: [] };

type EntryFacts = {
	readonly parentId: string | null;
	readonly kind: Classified["kind"];
	readonly start: number;
	readonly end: number;
};

type Cursor = {
	offset: number;
	size: number;
	mtimeMs: number;
	readonly dev: number;
	readonly ino: number;
	readonly head: string;
	seam: string;
	readonly entries: Map<string, EntryFacts>;
	leafId: string | null;
	header: "pending" | "ok" | "invalid";
};

type Head = { readonly bodyStart: number; readonly bytes: string };

export type TranscriptReader = {
	reset(): void;
	read(file: string, need: BranchNeed): RootView;
	release(): void;
};

function classify(message: RoleMessage): Classified {
	switch (message.role) {
		case "user": {
			if (message.attribution !== "user" || message.synthetic === true) return OTHER;
			const text = textOf(message.content, "\n").trim();
			return text === "" ? OTHER : { kind: "prompt", text };
		}
		case "toolResult": {
			const answers = askAnswers(message);
			return answers === null ? OTHER : { kind: "answers", text: formatAskAnswers(answers) };
		}
		default: {
			const unreachable: never = message;
			return unreachable;
		}
	}
}

export function liveView(branch: readonly SessionEntry[], need: BranchNeed): RootView {
	const prompts: string[] = [];
	const answers: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "toolResult") continue;
		const classified = classify(message);
		if (classified.kind === "prompt" && need.prompts) prompts.push(classified.text);
		if (classified.kind === "answers" && need.answers) answers.push(classified.text);
	}
	return { prompts: { length: prompts.length, at: (index) => prompts[index] ?? "" }, answers };
}

export function createTranscriptReader(): TranscriptReader {
	let cursor: Cursor | null = null;
	let handle: number | null = null;
	let scratch = new Uint8Array(0);
	const textAt = (fd: number, facts: EntryFacts | undefined): string => {
		if (facts === undefined) return "";
		const length = facts.end - facts.start;
		if (scratch.length < length) scratch = new Uint8Array(length);
		const entry = storedEntry.safeParse(Bun.JSONL.parseChunk(scratch.subarray(0, readInto(fd, scratch, facts.start, length))).values[0]);
		const message = entry.success ? messageOf(entry.data) : null;
		const classified = message === null ? OTHER : classify(message);
		return classified.kind === "other" ? "" : classified.text;
	};

	return {
		reset(): void {
			cursor = null;
		},
		read(file: string, need: BranchNeed): RootView {
			const stats = statSync(file, { throwIfNoEntry: false });
			if (stats === undefined) {
				cursor = null;
				return EMPTY_VIEW;
			}
			handle ??= openSync(file, "r");
			const fd = handle;
			cursor = ensureCursor(fd, cursor, stats);
			const branch = branchOf(cursor);
			const prompts = need.prompts ? branch.filter((facts) => facts.kind === "prompt") : [];
			const answers = need.answers ? branch.filter((facts) => facts.kind === "answers").map((facts) => textAt(fd, facts)) : [];
			return { prompts: { length: prompts.length, at: (index) => textAt(fd, prompts[index]) }, answers };
		},
		release(): void {
			if (handle !== null) {
				closeSync(handle);
				handle = null;
			}
		},
	};
}

function ensureCursor(fd: number, current: Cursor | null, stats: Stats): Cursor {
	const head = headOf(fd);
	const stale =
		current === null ||
		current.dev !== stats.dev ||
		current.ino !== stats.ino ||
		stats.size < current.size ||
		(stats.size === current.size && stats.mtimeMs !== current.mtimeMs) ||
		current.head !== head.bytes ||
		current.seam !== sampleBefore(fd, current.offset);
	const cursor = stale ? startCursor(head, stats) : current;
	if (stats.size > cursor.offset) advance(fd, cursor, stats.size);
	cursor.size = stats.size;
	cursor.mtimeMs = stats.mtimeMs;
	cursor.seam = sampleBefore(fd, cursor.offset);
	return cursor;
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

function headOf(fd: number): Head {
	const bytes = readBytesAt(fd, 0, SESSION_TITLE_SLOT_BYTES);
	const text = bytes.toString("utf8");
	const newline = bytes.indexOf(LF);
	if (newline === -1) return { bodyStart: 0, bytes: text };
	const slot = parseSessionContent(text.slice(0, newline + 1)).titleSlot;
	return { bodyStart: slot === undefined ? 0 : newline + 1, bytes: text };
}

function advance(fd: number, cursor: Cursor, size: number): void {
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
}

function sampleBefore(fd: number, offset: number): string {
	if (offset === 0) return "";
	const length = Math.min(SEAM_BYTES, offset);
	return readBytesAt(fd, offset - length, length).toString("utf8");
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
	const value: unknown = Bun.JSONL.parseChunk(line).values[0];
	if (value === undefined) return;
	if (cursor.header === "pending") {
		cursor.header = storedHeader.safeParse(value).success ? "ok" : "invalid";
		return;
	}
	if (cursor.header === "invalid") return;
	const entry = storedEntry.safeParse(value);
	if (!entry.success) return;
	const message = messageOf(entry.data);
	const kind = message === null ? "other" : classify(message).kind;
	cursor.entries.set(entry.data.id, { parentId: entry.data.parentId, kind, start, end });
	cursor.leafId = entry.data.id;
}

function messageOf(entry: StoredEntry): RoleMessage | null {
	if (entry.type !== "message") return null;
	const message = storedMessage.safeParse(entry.message);
	return message.success ? message.data : null;
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
