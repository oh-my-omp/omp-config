// ============================================================================
// turn-judge state — the `时间线` / `本轮回复` state a judge request carries,
// and `fitState`, which keeps its serialized UTF-8 size within `maxBytes`.
// This repository caps `maxBytes` at 64KB (`MAX_BYTES_LIMIT`); the cap is a
// repository choice, not a fact about the hosted service.
//
// The budget counts bytes, so it is measured on `JSON.stringify(state)` with
// escapes included, not on UTF-16 length. 本轮回复 takes half of `maxBytes`, 用户说 a quarter, the newest entry
// the rest, and older entries whole from newest to oldest until one does not
// fit. Content over its share keeps its head and gains `…`; 用户说 and the
// newest entry are never dropped.
// ============================================================================

import { tr } from "../_shared/i18n.ts";

/** Largest `maxBytes` this repository accepts for a judge request's state (64KB). */
export const MAX_BYTES_LIMIT = 65_536;

export type MaxBytesParse = { readonly kind: "ok"; readonly value: number } | { readonly kind: "invalid"; readonly reason: string };

/** Parses a spec's `maxBytes` value: a positive integer no larger than `MAX_BYTES_LIMIT`. */
export function parseMaxBytes(raw: string): MaxBytesParse {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0)
		return { kind: "invalid", reason: tr("maxBytes must be a positive integer", "maxBytes 必须是正整数") };
	if (value > MAX_BYTES_LIMIT)
		return {
			kind: "invalid",
			reason: tr(`maxBytes must be at most ${MAX_BYTES_LIMIT} (64KB)`, `maxBytes 不能超过 ${MAX_BYTES_LIMIT}（64KB）`),
		};
	return { kind: "ok", value };
}

export type TimelineKind = "用户说" | "用户在ask中回答" | "提醒" | "模型想" | "模型说" | "模型调用工具";

export type TimelineEntry = { readonly 类型: TimelineKind; readonly 内容: string };

export type TurnState = { readonly 时间线: readonly TimelineEntry[]; readonly 本轮回复: string };

/** UTF-8 bytes a value occupies inside `JSON.stringify`, escapes and quotes included. */
function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Bytes of `{"时间线":[],"本轮回复":""}` that are not the reply's own quotes. */
const STATE_OVERHEAD_BYTES = serializedBytes({ 时间线: [], 本轮回复: "" }) - 2;

/** Bytes of `…` once serialized inside a string: its UTF-8 plus the two quotes. */
const ELLIPSIS_BYTES = serializedBytes("…");

/** Bytes `{"类型":"…","内容":"…"}` spends on keys, colons, commas and quotes besides the two values. */
const ENTRY_FRAME_BYTES = serializedBytes({ 类型: "", 内容: "" });

/**
 * `text` whole when its serialized form fits `budget` bytes; otherwise the
 * longest code-point prefix whose escaped form, plus `…`, fits. A code point is
 * never split, so the result is always valid UTF-8 and well-formed UTF-16.
 *
 * A code point's width inside `JSON.stringify` is read from its code unit, so
 * the cut is found without escaping (or allocating) anything.
 */
function headWithin(text: string, budget: number): string {
	// UTF-8 bytes never exceed the escaped width: a text over budget that way is
	// answered without copying it into a serialized string first.
	if (Buffer.byteLength(text, "utf8") + 2 <= budget && serializedBytes(text) <= budget) return text;
	const cap = budget - ELLIPSIS_BYTES;
	let used = 0;
	let end = 0;
	let index = 0;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		let width: number;
		if (code < 0x20) {
			// Control characters take a short escape, or `\u00XX` beyond them.
			width = code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
			index += 1;
		} else if (code < 0x80) {
			width = code === 0x22 || code === 0x5c ? 2 : 1;
			index += 1;
		} else if (code < 0x800) {
			width = 2;
			index += 1;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			width = low >= 0xdc00 && low <= 0xdfff ? 4 : 6;
			index += width === 4 ? 2 : 1;
		} else if (code >= 0xd800 && code <= 0xdfff) {
			// A lone surrogate half is escaped as `\uXXXX`.
			width = 6;
			index += 1;
		} else {
			width = 3;
			index += 1;
		}
		if (used + width > cap) break;
		used += width;
		end = index;
	}
	return `${text.slice(0, end)}…`;
}

/** `entry` whole when its serialized size fits `budget`, otherwise its 内容 cut to a head. */
function fitEntry(entry: TimelineEntry, budget: number): TimelineEntry {
	// The escaped size is bounded from below by the UTF-8 bytes of both values:
	// an entry over budget that way is cut rather than serialized whole.
	if (
		ENTRY_FRAME_BYTES + Buffer.byteLength(entry.类型) + Buffer.byteLength(entry.内容, "utf8") <= budget &&
		serializedBytes(entry) <= budget
	)
		return entry;
	const overhead = serializedBytes({ 类型: entry.类型, 内容: "" });
	return { 类型: entry.类型, 内容: headWithin(entry.内容, budget - overhead) };
}

/**
 * The state whose serialized UTF-8 size stays within `maxBytes` (see the module
 * header for the shares). Each required part reserves its minimal size before a
 * share is granted, so the reply and 用户说 can never crowd out the newest entry.
 */
export function fitState(entries: readonly TimelineEntry[], reply: string, maxBytes: number): TurnState {
	const [first, ...rest] = entries;
	const head = first?.类型 === "用户说" ? first : undefined;
	const tail = head === undefined ? entries : rest;
	const newest = tail[tail.length - 1];

	// Minimal serialized sizes: `…` bodies. The newest also pays its joining comma.
	const headMin = head === undefined ? 0 : serializedBytes({ 类型: head.类型, 内容: "…" });
	const newestMin = newest === undefined ? 0 : serializedBytes({ 类型: newest.类型, 内容: "…" }) + 1;
	const beyondReply = maxBytes - STATE_OVERHEAD_BYTES;

	const fittedReply = headWithin(reply, Math.min(Math.floor(maxBytes / 2), beyondReply - headMin - newestMin));
	let remaining = beyondReply - serializedBytes(fittedReply);

	const fitted: TimelineEntry[] = [];
	if (head !== undefined) {
		const fittedHead = fitEntry(head, Math.min(Math.floor(maxBytes / 4), remaining - newestMin));
		fitted.push(fittedHead);
		remaining -= serializedBytes(fittedHead);
	}
	if (newest !== undefined) {
		const fittedNewest = fitEntry(newest, remaining - 1);
		remaining -= serializedBytes(fittedNewest) + 1;
		const kept: TimelineEntry[] = [fittedNewest];
		for (let i = tail.length - 2; i >= 0; i--) {
			const entry = tail[i] as TimelineEntry;
			// The escaped size is bounded from below by the UTF-8 bytes of both
			// values: an entry over budget that way drops without being serialized.
			if (ENTRY_FRAME_BYTES + Buffer.byteLength(entry.类型) + Buffer.byteLength(entry.内容, "utf8") + 1 > remaining) break;
			const cost = serializedBytes(entry) + 1;
			if (cost > remaining) break;
			remaining -= cost;
			kept.push(entry);
		}
		fitted.push(...kept.reverse());
	}
	return { 时间线: fitted, 本轮回复: fittedReply };
}
