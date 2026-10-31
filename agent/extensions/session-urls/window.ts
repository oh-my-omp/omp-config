// `?since=` / `?until=` time window over timeline events. Accepted values:
//   30m 2h 3d                     that long before now
//   2026-10-28                    a local calendar day
//   2026-10-28T1430[15[.250]]     a local wall time; `T` or a space, colons optional,
//   2026-10-28T14:30Z / …+0800    a zone (`Z`, `±hhmm`, `±hh:mm`) makes it absolute
//   1430 / 14:30:15               a wall time on the session's only local date
// Both bounds include their whole written unit (until=2026-10-28 is that entire
// day, until=1430 runs through 14:30:59.999); internally the window is
// half-open [start, end). OMP's read peels a trailing `:<digits>` off an
// internal URL as a line selector, so `until=14:30` at the end of a URL
// arrives as `until=14`; that truncated shape fails with the colonless forms.
import type { SessionEvent } from "./events.ts";

interface Day {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

interface Clock {
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly milli: number;
	/** Length of the written unit in ms: a minute, a second, or the fraction's last digit. */
	readonly unit: number;
}

export type Bound =
	| { readonly kind: "ago"; readonly ms: number }
	| { readonly kind: "day"; readonly day: Day }
	/** `zone` is minutes east of UTC; null is local time. */
	| { readonly kind: "moment"; readonly day: Day; readonly clock: Clock; readonly zone: number | null }
	| { readonly kind: "clock"; readonly clock: Clock };

/** The bounds as written; at least one is present. */
export interface WindowSpec {
	readonly since: Bound | null;
	readonly until: Bound | null;
}

/** Resolved window in epoch ms: `start` inclusive, `end` exclusive; null is open. */
export interface TimeWindow {
	readonly start: number | null;
	readonly end: number | null;
}

type Key = "since" | "until";

const AGO = /^(\d+)([mhd])$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = String.raw`(\d{2}):?(\d{2})(?::?(\d{2})(?:\.(\d{1,3}))?)?`;
const MOMENT = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})[T ]${CLOCK}(Z|[+-]\d{2}:?\d{2})?$`, "i");
const CLOCK_ONLY = new RegExp(`^${CLOCK}$`);
/** What a peeled `:mm`, `:ss` or zone `:mm` leaves behind. */
const TRUNCATED = /^(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}$|[T ]\d{2,6}(?:\.\d{1,3})?[+-]\d{2}$/i;
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function badValue(key: Key, raw: string): Error {
	return new Error(
		`Bad ${key}=${raw}. Use ${key}=<n>m|h|d (that long before now), YYYY-MM-DD (a local day), ` +
			`YYYY-MM-DDThhmm[ss][Z|±hhmm] (local unless zoned), or hhmm[ss] (a wall time on the session's only date).`,
	);
}

function day(key: Key, raw: string, year: string, month: string, date: string): Day {
	const parsed = { year: Number(year), month: Number(month), day: Number(date) };
	const check = new Date(parsed.year, parsed.month - 1, parsed.day);
	if (check.getFullYear() !== parsed.year || check.getMonth() !== parsed.month - 1 || check.getDate() !== parsed.day)
		throw badValue(key, raw);
	return parsed;
}

function clock(key: Key, raw: string, hour: string, minute: string, second?: string, fraction?: string): Clock {
	const parsed = {
		hour: Number(hour),
		minute: Number(minute),
		second: second === undefined ? 0 : Number(second),
		milli: fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")),
		unit: second === undefined ? 60_000 : fraction === undefined ? 1000 : 10 ** (3 - fraction.length),
	};
	if (parsed.hour > 23 || parsed.minute > 59 || parsed.second > 59) throw badValue(key, raw);
	return parsed;
}

function zone(key: Key, raw: string, written: string | undefined): number | null {
	if (written === undefined) return null;
	if (written.toUpperCase() === "Z") return 0;
	const digits = written.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2));
	if (hours > 14 || minutes > 59) throw badValue(key, raw);
	return (written.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
}

function parseBound(key: Key, raw: string): Bound {
	const value = raw.trim();
	const ago = AGO.exec(value);
	if (ago) return { kind: "ago", ms: Number(ago[1]) * (UNIT_MS[(ago[2] ?? "").toLowerCase()] ?? 0) };
	const date = DAY.exec(value);
	if (date) return { kind: "day", day: day(key, raw, date[1] ?? "", date[2] ?? "", date[3] ?? "") };
	const moment = MOMENT.exec(value);
	if (moment)
		return {
			kind: "moment",
			day: day(key, raw, moment[1] ?? "", moment[2] ?? "", moment[3] ?? ""),
			clock: clock(key, raw, moment[4] ?? "", moment[5] ?? "", moment[6], moment[7]),
			zone: zone(key, raw, moment[8]),
		};
	const time = CLOCK_ONLY.exec(value);
	if (time) return { kind: "clock", clock: clock(key, raw, time[1] ?? "", time[2] ?? "", time[3], time[4]) };
	if (TRUNCATED.test(value))
		throw new Error(
			`${key}=${raw} is cut short: read takes a trailing ":<digits>" of a URL as a line selector, so a time ` +
				`like 14:30 at the end of the URL arrives without its ":30". Write the time without colons (1430, ` +
				`2026-10-28T143000+0800), as 14%3A30, or put ${key} before another query key.`,
		);
	throw badValue(key, raw);
}

/** Parses the written bounds; null when neither is given. Throws on a malformed value. */
export function parseWindow(since: string | null, until: string | null): WindowSpec | null {
	if (since === null && until === null) return null;
	return { since: since === null ? null : parseBound("since", since), until: until === null ? null : parseBound("until", until) };
}

function dayName(value: Day): string {
	return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

/** The single local date of the session's timestamped events, for clock-only bounds. */
function sessionDay(events: readonly SessionEvent[]): Day {
	const days = new Map<string, Day>();
	for (const event of events) {
		const at = new Date(event.t);
		if (Number.isNaN(at.getTime())) continue;
		const value = { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate() };
		days.set(dayName(value), value);
	}
	const [only, ...more] = days.values();
	if (only === undefined) throw new Error("The session has no timestamped events; give since/until with a date (YYYY-MM-DD…).");
	if (more.length > 0)
		throw new Error(
			`A bare time is ambiguous: the session spans ${[...days.keys()].join(", ")}. ` +
				`Add the date, e.g. ${[...days.keys()].at(-1)}T1430.`,
		);
	return only;
}

/** The half-open span [start, end) of a bound's written unit. */
function span(bound: Bound, events: readonly SessionEvent[], now: number): { readonly start: number; readonly end: number } {
	switch (bound.kind) {
		case "ago":
			return { start: now - bound.ms, end: now - bound.ms + 1 };
		case "day": {
			const { year, month, day: date } = bound.day;
			return { start: new Date(year, month - 1, date).getTime(), end: new Date(year, month - 1, date + 1).getTime() };
		}
		case "moment":
		case "clock": {
			const { year, month, day: date } = bound.kind === "moment" ? bound.day : sessionDay(events);
			const { hour, minute, second, milli, unit } = bound.clock;
			const zoned = bound.kind === "moment" ? bound.zone : null;
			const start =
				zoned === null
					? new Date(year, month - 1, date, hour, minute, second, milli).getTime()
					: Date.UTC(year, month - 1, date, hour, minute, second, milli) - zoned * 60_000;
			return { start, end: start + unit };
		}
		default: {
			const unreachable: never = bound;
			throw new Error(`Unhandled bound ${String(unreachable)}`);
		}
	}
}

/** Resolves written bounds against the session (clock-only bounds) and `now` (relative bounds). */
export function resolveWindow(spec: WindowSpec, events: readonly SessionEvent[], now: number): TimeWindow {
	const start = spec.since === null ? null : span(spec.since, events, now).start;
	const end = spec.until === null ? null : span(spec.until, events, now).end;
	if (start !== null && end !== null && start >= end)
		throw new Error(`since (${new Date(start).toISOString()}) is not before until (${new Date(end).toISOString()}).`);
	return { start, end };
}

/** Whether `event` falls in the window; an event without a valid timestamp never does. */
export function within(window: TimeWindow, event: SessionEvent): boolean {
	const at = Date.parse(event.t);
	if (Number.isNaN(at)) return false;
	return (window.start === null || at >= window.start) && (window.end === null || at < window.end);
}

/** The window as absolute `since`/`until` query parameters (UTC, millisecond units), so later pages keep the same span. */
export function windowQuery(window: TimeWindow): string {
	const parts: string[] = [];
	if (window.start !== null) parts.push(`since=${encodeURIComponent(new Date(window.start).toISOString())}`);
	if (window.end !== null) parts.push(`until=${encodeURIComponent(new Date(window.end - 1).toISOString())}`);
	return parts.join("&");
}
