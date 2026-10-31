// session-urls `?since=` / `?until=` window: every accepted form resolves to the
// intended half-open span (both bounds include their whole written unit), zones
// and local time differ correctly, a bare time anchors only to a single-date
// session, a time cut short by read's selector peeling fails with the fix, and
// the jq continuation bounds resolve back to the same window.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../agent/extensions/session-urls/events.ts";
import { parseWindow, resolveWindow, type TimeWindow, windowQuery, within } from "../agent/extensions/session-urls/window.ts";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

function at(t: string): SessionEvent {
	return { kind: "marker", what: "x", detail: "", entry: "e", block: null, t, line: 1, turn: 1 };
}

const ONE_DAY = [at(new Date(2026, 9, 28, 9, 0).toISOString()), at(new Date(2026, 9, 28, 18, 0).toISOString())];
const TWO_DAYS = [...ONE_DAY, at(new Date(2026, 9, 30, 10, 0).toISOString())];

function resolve(since: string | null, until: string | null, events: readonly SessionEvent[] = ONE_DAY): TimeWindow {
	const spec = parseWindow(since, until);
	if (spec === null) throw new Error("no window");
	return resolveWindow(spec, events, NOW);
}

describe("session-urls time window", () => {
	test("a day covers the whole local day on either side", () => {
		expect(resolve("2026-10-28", "2026-10-28")).toEqual({
			start: new Date(2026, 9, 28).getTime(),
			end: new Date(2026, 9, 29).getTime(),
		});
	});

	test("a wall time includes its written unit; colons, %3A-decoded colons and a space separator are equal", () => {
		const minute = { start: new Date(2026, 9, 28, 14, 30).getTime(), end: new Date(2026, 9, 28, 14, 31).getTime() };
		expect(resolve("2026-10-28T1430", "2026-10-28T1430")).toEqual(minute);
		expect(resolve("2026-10-28T14:30", "2026-10-28 14:30")).toEqual(minute);
		expect(resolve(null, "2026-10-28T143015").end).toBe(new Date(2026, 9, 28, 14, 30, 16).getTime());
		expect(resolve(null, "2026-10-28T14:30:15.25").end).toBe(new Date(2026, 9, 28, 14, 30, 15, 260).getTime());
	});

	test("a zone makes the time absolute", () => {
		expect(resolve("2026-10-28T1430Z", null).start).toBe(Date.UTC(2026, 9, 28, 14, 30));
		expect(resolve("2026-10-28T1430+0800", null).start).toBe(Date.UTC(2026, 9, 28, 6, 30));
		expect(resolve("2026-10-28T14:30+08:00", null).start).toBe(Date.UTC(2026, 9, 28, 6, 30));
		expect(resolve("2026-10-28T1430-0530", null).start).toBe(Date.UTC(2026, 9, 28, 20, 0));
	});

	test("relative bounds count back from now", () => {
		expect(resolve("2h", null).start).toBe(NOW - 2 * 3_600_000);
		expect(resolve("1d", "90m")).toEqual({ start: NOW - 86_400_000, end: NOW - 90 * 60_000 + 1 });
	});

	test("a bare time anchors to the session's only date, never to a guessed one", () => {
		expect(resolve("1430", "15:00")).toEqual({
			start: new Date(2026, 9, 28, 14, 30).getTime(),
			end: new Date(2026, 9, 28, 15, 1).getTime(),
		});
		expect(() => resolve("1430", null, TWO_DAYS)).toThrow(/spans 2026-10-28, 2026-10-30.*2026-10-30T1430/);
		expect(() => resolve("1430", null, [])).toThrow(/no timestamped events/);
		expect(resolve("2026-10-30T1000", null, TWO_DAYS).start).toBe(new Date(2026, 9, 30, 10, 0).getTime());
	});

	test("a time cut short by read's line-selector peeling fails with the colonless forms", () => {
		for (const cut of ["14", "2026-10-28T14", "2026-10-28T1430+08"])
			expect(() => parseWindow(cut, null)).toThrow(/cut short.*1430.*14%3A30/);
	});

	test("malformed values and an empty window fail", () => {
		for (const bad of ["2026-02-30", "2560", "yesterday", "2026-10-28T1430+1500"])
			expect(() => parseWindow(bad, null)).toThrow(/Bad since=/);
		expect(() => parseWindow(null, "10x")).toThrow(/Bad until=/);
		expect(() => resolve("2026-10-29", "2026-10-28")).toThrow(/is not before until/);
		expect(parseWindow(null, null)).toBeNull();
	});

	test("the window is half-open and skips events without a timestamp", () => {
		const window = resolve("1430", "1430");
		expect(within(window, at(new Date(2026, 9, 28, 14, 30, 0).toISOString()))).toBe(true);
		expect(within(window, at(new Date(2026, 9, 28, 14, 30, 59, 999).toISOString()))).toBe(true);
		expect(within(window, at(new Date(2026, 9, 28, 14, 31).toISOString()))).toBe(false);
		expect(within(window, at(new Date(2026, 9, 28, 14, 29, 59, 999).toISOString()))).toBe(false);
		expect(within({ start: null, end: null }, at("not a time"))).toBe(false);
	});

	test("continuation bounds resolve back to the same window, relative ones frozen", () => {
		for (const window of [resolve("4d", "2h"), resolve("2026-10-28", null), resolve(null, "2026-10-28T14:30:15.25")]) {
			const params = new Map(
				windowQuery(window)
					.split("&")
					.map((pair) => [pair.split("=")[0], decodeURIComponent(pair.split("=")[1] ?? "")]),
			);
			expect(windowQuery(window)).not.toContain(":");
			const spec = parseWindow(params.get("since") ?? null, params.get("until") ?? null);
			expect(spec && resolveWindow(spec, [], NOW + 3_600_000)).toEqual(window);
		}
	});
});
