// `?type=` filter over timeline events. Accepted forms, freely combined:
//   type=thinking             one event kind (the timeline header labels: calls, result … are aliases)
//   type=thinking,say         a comma list;  type=say&type=irc   repeated parameters
//   type=irc | speech | ai    a group of kinds (GROUPS below)
//   type=call:bash            events carrying a call of that tool (plain calls, irc_out = write, dispatch = task)
//   type=marker:compaction    markers of one kind (`-`, `_` and spaces are interchangeable)
//   type=-call  type=!marker  exclusion; with no inclusion everything else is kept
// Matching is case-insensitive. Unknown tokens throw, listing the accepted forms.
// EventFilter ANDs this filter with the `since`/`until` window of window.ts.
import type { SessionEvent } from "./events.ts";
import { type TimeWindow, within } from "./window.ts";

const KINDS = ["user", "developer", "thinking", "say", "call", "irc_out", "irc_in", "dispatch", "subresult", "exec", "marker"] as const;
type Kind = (typeof KINDS)[number];

const ALIASES: Readonly<Record<string, Kind>> = {
	calls: "call",
	result: "subresult",
	results: "subresult",
	markers: "marker",
	irc_send: "irc_out",
	irc_receive: "irc_in",
};

const GROUPS: Readonly<Record<string, readonly Kind[]>> = {
	irc: ["irc_in", "irc_out"],
	subagent: ["dispatch", "subresult"],
	speech: ["user", "developer", "say", "irc_in", "irc_out", "dispatch", "subresult"],
	ai: ["thinking", "say", "irc_out", "dispatch"],
	tools: ["call", "exec"],
};

type Selector =
	| { readonly kind: "kind"; readonly kinds: readonly Kind[] }
	| { readonly kind: "tool"; readonly tool: string }
	| { readonly kind: "marker"; readonly what: string };

export interface TypeFilter {
	readonly include: readonly Selector[];
	readonly exclude: readonly Selector[];
	/** The filter as written, for headers and continuation hints. */
	readonly source: string;
}

function isKind(value: string): value is Kind {
	return (KINDS as readonly string[]).includes(value);
}

/** `-`, `_` and spaces compare equal; case folded. */
function fold(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[-_\s]+/g, " ");
}

function usage(token: string): Error {
	return new Error(
		`Unknown type "${token}". Use a kind (${KINDS.join(", ")}), a group (${Object.keys(GROUPS).join(", ")}), ` +
			`call:<tool>, marker:<what>, comma lists or repeated type=, and -<type> / !<type> to exclude.`,
	);
}

function selector(token: string): Selector {
	const colon = token.indexOf(":");
	if (colon !== -1) {
		const head = fold(token.slice(0, colon));
		const rest = token.slice(colon + 1).trim();
		if (rest === "") throw usage(token);
		if (head === "call" || head === "calls" || head === "tool") return { kind: "tool", tool: rest.toLowerCase() };
		if (head === "marker" || head === "markers") return { kind: "marker", what: fold(rest) };
		throw usage(token);
	}
	const name = fold(token).replace(/ /g, "_");
	if (isKind(name)) return { kind: "kind", kinds: [name] };
	const alias = ALIASES[name];
	if (alias !== undefined) return { kind: "kind", kinds: [alias] };
	const group = GROUPS[name];
	if (group !== undefined) return { kind: "kind", kinds: group };
	throw usage(token);
}

/** Parses every `type` value of a query; null when none is given (or all are empty). */
export function parseTypeFilter(values: readonly string[]): TypeFilter | null {
	const include: Selector[] = [];
	const exclude: Selector[] = [];
	const written: string[] = [];
	for (const raw of values.flatMap((value) => value.split(","))) {
		const token = raw.trim();
		if (token === "") continue;
		written.push(token);
		const negated = token.startsWith("-") || token.startsWith("!");
		(negated ? exclude : include).push(selector(negated ? token.slice(1) : token));
	}
	return written.length === 0 ? null : { include, exclude, source: written.join(",") };
}

function matches(selector: Selector, event: SessionEvent): boolean {
	switch (selector.kind) {
		case "kind":
			return selector.kinds.includes(event.kind);
		case "tool":
			return (
				(event.kind === "call" || event.kind === "irc_out" || event.kind === "dispatch") && event.call.tool.toLowerCase() === selector.tool
			);
		case "marker":
			return event.kind === "marker" && fold(event.what) === selector.what;
		default: {
			const unreachable: never = selector;
			throw new Error(`Unhandled selector ${String(unreachable)}`);
		}
	}
}

/** Whether `event` passes: any inclusion (or none given), and no exclusion. */
export function keeps(filter: TypeFilter, event: SessionEvent): boolean {
	if (filter.include.length > 0 && !filter.include.some((item) => matches(item, event))) return false;
	return !filter.exclude.some((item) => matches(item, event));
}

/** Everything a URL filters events by: its type filter and its time window, combined by AND. */
export interface EventFilter {
	readonly types: TypeFilter | null;
	readonly window: TimeWindow | null;
}

/** Whether `event` passes both the type filter and the time window. */
export function shows(filter: EventFilter, event: SessionEvent): boolean {
	return (filter.types === null || keeps(filter.types, event)) && (filter.window === null || within(filter.window, event));
}
