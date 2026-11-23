import { type ExtensionAPI, type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { textOf as textBlocks } from "../_shared/messages.ts";

export const NOTE_CUSTOM_TYPE = "watchdog";
const OVERRIDE_ENTRY_TYPE = "mouriya.omp.watchdog-agent.override";
const CURSOR_ENTRY_TYPE = "mouriya.omp.watchdog-agent.cursor";
const USER_NOTE_ENTRY_TYPE = "mouriya.omp.watchdog-agent.user-note";

type SessionOverride = { readonly filePath: string; readonly enabled: boolean | null };
type CursorEntry = { readonly filePath: string; readonly cursor: number };
type UserNoteEntry = { readonly filePaths: readonly string[]; readonly text: string };

const overrideSchema = z.object({ filePath: z.string(), enabled: z.boolean().nullable() });
const cursorSchema = z.object({ filePath: z.string(), cursor: z.number() });
const userNoteSchema = z.object({ filePaths: z.array(z.string()), text: z.string() });
const noteDetailsSchema = z.object({ filePaths: z.array(z.string()) });

export type NoteIndex = { count: number; anchor: SessionEntry | undefined; index: Map<string, readonly string[]> };

type EntryWriter = Pick<ExtensionAPI, "appendEntry">;

export function emptyNoteIndex(): NoteIndex {
	return { count: 0, anchor: undefined, index: new Map() };
}

export function writeOverride(pi: EntryWriter, filePath: string, enabled: boolean | null): void {
	pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath, enabled });
}

export function writeCursor(pi: EntryWriter, filePath: string, cursor: number): void {
	pi.appendEntry<CursorEntry>(CURSOR_ENTRY_TYPE, { filePath, cursor });
}

export function writeUserNote(pi: EntryWriter, filePaths: readonly string[], text: string): void {
	pi.appendEntry<UserNoteEntry>(USER_NOTE_ENTRY_TYPE, { filePaths, text });
}

function customData(entry: SessionEntry, customType: string): unknown {
	return entry.type === "custom" && entry.customType === customType ? entry.data : undefined;
}

export function overridesFromBranch(entries: ReadonlyArray<SessionEntry>): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const entry of entries) {
		const parsed = overrideSchema.safeParse(customData(entry, OVERRIDE_ENTRY_TYPE));
		if (!parsed.success) continue;
		if (parsed.data.enabled === null) out.delete(parsed.data.filePath);
		else out.set(parsed.data.filePath, parsed.data.enabled);
	}
	return out;
}

export function cursorsFromBranch(entries: ReadonlyArray<SessionEntry>): Map<string, number> {
	const out = new Map<string, number>();
	for (const entry of entries) {
		const parsed = cursorSchema.safeParse(customData(entry, CURSOR_ENTRY_TYPE));
		if (parsed.success) out.set(parsed.data.filePath, parsed.data.cursor);
	}
	return out;
}

export function noteIndexOf(notes: NoteIndex, entries: ReadonlyArray<SessionEntry>): ReadonlyMap<string, readonly string[]> {
	if (notes.count > entries.length || (notes.count > 0 && entries[notes.count - 1] !== notes.anchor)) {
		notes.count = 0;
		notes.index = new Map();
	}
	for (const entry of entries.slice(notes.count)) {
		const parsed = userNoteSchema.safeParse(customData(entry, USER_NOTE_ENTRY_TYPE));
		if (parsed.success) notes.index.set(parsed.data.text.trim(), parsed.data.filePaths);
	}
	notes.count = entries.length;
	notes.anchor = entries[entries.length - 1];
	return notes.index;
}

function noteFiles(entry: SessionEntry, index: ReadonlyMap<string, readonly string[]>): readonly string[] {
	if (entry.type === "custom_message" && entry.customType === NOTE_CUSTOM_TYPE) {
		const parsed = noteDetailsSchema.safeParse(entry.details);
		return parsed.success ? parsed.data.filePaths : [];
	}
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (message.role !== "user" || message.attribution !== "agent") return [];
	return index.get(textBlocks(message.content).trim()) ?? [];
}

export function deliveredSinceCompaction(
	entries: ReadonlyArray<SessionEntry>,
	filePath: string,
	index: ReadonlyMap<string, readonly string[]>,
): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "compaction") count = 0;
		else if (noteFiles(entry, index).includes(filePath)) count += 1;
	}
	return count;
}
