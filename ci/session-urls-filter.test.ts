// session-urls `?type=` filter: every accepted form selects the intended events,
// exclusions win over inclusions, and bad tokens fail with the accepted forms.
import { describe, expect, test } from "bun:test";
import type { Call, SessionEvent } from "../agent/extensions/session-urls/events.ts";
import { keeps, parseTypeFilter, type TypeFilter } from "../agent/extensions/session-urls/filter.ts";

const base = { entry: "e", block: null, t: "2026-10-28T00:00:00.000Z", line: 1, turn: 1 } as const;
const call = (tool: string): Call => ({
	id: tool,
	tool,
	args: null,
	intent: null,
	status: "ok",
	resultEntry: null,
	resultChars: null,
	durMs: null,
});

const EVENTS: Record<string, SessionEvent> = {
	user: { ...base, kind: "user", text: "u", injected: false },
	developer: { ...base, kind: "developer", text: "d" },
	thinking: { ...base, kind: "thinking", text: "t" },
	say: { ...base, kind: "say", text: "s" },
	bash: { ...base, kind: "call", call: call("bash") },
	read: { ...base, kind: "call", call: call("read") },
	ircOut: { ...base, kind: "irc_out", to: "X", text: "o", call: call("write") },
	ircIn: { ...base, kind: "irc_in", from: "X", to: "main", text: "i" },
	dispatch: { ...base, kind: "dispatch", call: call("task"), context: null, children: [] },
	result: { ...base, kind: "subresult", id: "X", agent: "task:low", status: "completed", duration: "1s", text: "r" },
	exec: { ...base, kind: "exec", lang: "bash", source: "ls", status: "ok" },
	compaction: { ...base, kind: "marker", what: "compaction", detail: "" },
	sessionExit: { ...base, kind: "marker", what: "session exit", detail: "" },
};

function kept(...values: string[]): string[] {
	const filter = parseTypeFilter(values) as TypeFilter;
	return Object.entries(EVENTS)
		.filter(([, event]) => keeps(filter, event))
		.map(([name]) => name);
}

describe("session-urls type filter", () => {
	test("single kinds, header-label aliases and case", () => {
		expect(kept("thinking")).toEqual(["thinking"]);
		expect(kept("Calls")).toEqual(["bash", "read"]);
		expect(kept("result")).toEqual(["result"]);
		expect(kept("irc-in")).toEqual(["ircIn"]);
	});

	test("comma lists and repeated parameters are one union", () => {
		expect(kept("thinking,say")).toEqual(["thinking", "say"]);
		expect(kept("thinking", "say")).toEqual(kept("thinking,say"));
		expect(kept(" thinking , ,say ")).toEqual(["thinking", "say"]);
	});

	test("groups", () => {
		expect(kept("irc")).toEqual(["ircOut", "ircIn"]);
		expect(kept("subagent")).toEqual(["dispatch", "result"]);
		expect(kept("ai")).toEqual(["thinking", "say", "ircOut", "dispatch"]);
		expect(kept("tools")).toEqual(["bash", "read", "exec"]);
		expect(kept("speech")).toEqual(["user", "developer", "say", "ircOut", "ircIn", "dispatch", "result"]);
	});

	test("call:<tool> matches every event carrying that call; marker:<what> folds separators", () => {
		expect(kept("call:bash")).toEqual(["bash"]);
		expect(kept("call:task")).toEqual(["dispatch"]);
		expect(kept("tool:WRITE")).toEqual(["ircOut"]);
		expect(kept("marker:session_exit")).toEqual(["sessionExit"]);
	});

	test("exclusions alone keep the rest; exclusions win over inclusions", () => {
		expect(kept("-call,!marker")).toEqual(["user", "developer", "thinking", "say", "ircOut", "ircIn", "dispatch", "result", "exec"]);
		expect(kept("tools,-call:read")).toEqual(["bash", "exec"]);
		expect(kept("speech", "-irc")).toEqual(["user", "developer", "say", "dispatch", "result"]);
	});

	test("no or empty values mean no filter; unknown tokens fail with the accepted forms", () => {
		expect(parseTypeFilter([])).toBeNull();
		expect(parseTypeFilter(["", " , "])).toBeNull();
		expect(() => parseTypeFilter(["thinkng"])).toThrow(/Unknown type "thinkng".*thinking.*call:<tool>/);
		expect(() => parseTypeFilter(["call:"])).toThrow(/Unknown type/);
		expect(() => parseTypeFilter(["user:x"])).toThrow(/Unknown type/);
	});
});
