// Renderers: the timeline (column-0 headers, every body line indented two
// spaces), events JSONL for jq, and one-entry detail. Pure functions of the
// loaded session; `base` is the session:// URL the reader used for this session
// (or subagent), so every pointer printed here can be read back directly.
import { type Call, type EntryDetail, type LoadedSession, rewriteRefs, type SessionEvent, type Text } from "./events.ts";
import { Clipped, type Projected, type ProjectedObject } from "./scanner.ts";

const IDLE_MS = 5 * 60_000;
const SLOW_MS = 10_000;
const ARG_INLINE = 80;
const COMMAND_INLINE = 160;
const PATH_KEYS: Readonly<Record<string, true>> = {
	path: true,
	paths: true,
	file: true,
	cwd: true,
	workdir: true,
	url: true,
	pattern: true,
	pat: true,
	glob: true,
};
const COMMAND_KEYS: Readonly<Record<string, true>> = { command: true, cmd: true };

/** Header-safe single line: control characters become spaces. */
function flat(value: string): string {
	return value.replace(/\p{Cc}+/gu, " ").trim();
}

function textOf(value: Text): string {
	return value instanceof Clipped ? value.text : value;
}

/** `1 call`, `2 calls`; `many` names an irregular plural (`entries`). */
function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

function duration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function localParts(iso: string): { date: string; time: string } | null {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return null;
	const pad = (value: number): string => String(value).padStart(2, "0");
	return {
		date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
		time: `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
	};
}

/** Local ISO-8601 time with the UTC offset, e.g. `2026-10-26 16:18:30 +08:00`. */
export function localStamp(iso: string): string {
	const parts = localParts(iso);
	if (!parts) return iso;
	const offset = -new Date(iso).getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${parts.date} ${parts.time} ${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Body lines, each indented two spaces; a clipped text ends with a pointer to the full entry. */
function body(value: Text, detail: string): string[] {
	const lines = textOf(value)
		.split("\n")
		.map((line) => `  ${line}`);
	if (value instanceof Clipped) lines.push(`  …[clipped: ${value.text.length} of ${value.chars} chars shown; full: ${detail}]`);
	return lines;
}

function scalarArg(key: string, value: string, chars: number, lines: number, tool: string): string {
	const first = value.split("\n", 1)[0] ?? "";
	if (PATH_KEYS[key] === true) return JSON.stringify(flat(value));
	const limit = COMMAND_KEYS[key] === true || tool === "bash" ? COMMAND_INLINE : ARG_INLINE;
	if (lines <= 1 && chars <= limit) return JSON.stringify(value);
	const shown = first.length > limit ? `${first.slice(0, limit)}…` : first;
	return `${JSON.stringify(shown)}…(${plural(lines, "line")}, ${chars} chars)`;
}

function itemName(item: Projected): string | null {
	if (typeof item === "string") return item.length <= 40 ? item : null;
	if (item === null || typeof item !== "object" || Array.isArray(item) || item instanceof Clipped) return null;
	for (const key of ["name", "id", "path", "title"]) {
		const value = item[key];
		if (typeof value === "string") return value;
	}
	return null;
}

function argValue(key: string, value: Projected, tool: string): string {
	if (typeof value === "string") return scalarArg(key, value, value.length, value === "" ? 0 : value.split("\n").length, tool);
	if (value instanceof Clipped) return scalarArg(key, value.text, value.chars, value.lines, tool);
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		const names = value.map(itemName).filter((name): name is string => name !== null);
		if (names.length === 0) return `[${value.length}]`;
		const shown = names.slice(0, 3).map((name) => flat(name));
		return `[${value.length}: ${shown.join(", ")}${value.length > shown.length ? ", …" : ""}]`;
	}
	const keys = Object.keys(value);
	return `{${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}}`;
}

/** Compact call signature: `tool(key=value, …)`, `i` dropped (shown as the intent). */
export function signature(call: Call): string {
	const args = call.args;
	if (args === null || typeof args !== "object" || Array.isArray(args) || args instanceof Clipped) {
		return `${call.tool}(${args === null ? "" : argValue("", args, call.tool)})`;
	}
	const parts = Object.entries(args as ProjectedObject)
		.filter(([key]) => key !== "i")
		.map(([key, value]) => `${key}=${argValue(key, value, call.tool)}`);
	return `${call.tool}(${parts.join(", ")})`;
}

function callTail(call: Call): string {
	const parts: string[] = [call.status];
	if (call.durMs !== null && call.durMs >= SLOW_MS) parts.push(duration(call.durMs));
	if (call.resultEntry !== null) parts.push(`#${call.resultEntry}`);
	return `${parts.join(" ")}${call.intent ? `  // ${flat(call.intent)}` : ""}`;
}

function ref(event: SessionEvent): string {
	return event.block === null ? `#${event.entry}` : `#${event.entry}.${event.block}`;
}

function eventTool(event: SessionEvent): Call | null {
	return event.kind === "call" || event.kind === "irc_out" || event.kind === "dispatch" ? event.call : null;
}

function turnHeader(turn: number, events: readonly SessionEvent[]): string {
	const counts = new Map<string, number>();
	let errors = 0;
	for (const event of events) {
		const call = eventTool(event);
		if (!call) continue;
		counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
		if (call.status === "error") errors++;
	}
	const first = events[0];
	const last = events.at(-1);
	const parts: string[] = [turn === 0 ? "── preamble" : `── turn ${turn}`];
	const start = first ? localParts(first.t) : null;
	const end = last ? localParts(last.t) : null;
	if (start && end && first && last) {
		const span = Date.parse(last.t) - Date.parse(first.t);
		parts.push(`${start.date} ${start.time}→${end.time} (${duration(span)})`);
	}
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	if (total > 0) {
		const byTool = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => `${tool}×${count}`);
		parts.push(`${plural(total, "call")} (${byTool.join(" ")})`);
	}
	if (errors > 0) parts.push(plural(errors, "error"));
	return parts.join(" · ");
}

/** Lines of one non-call event. */
function eventLines(event: Exclude<SessionEvent, { kind: "call" }>, time: string, base: string, root: string): string[] {
	const detail = `${base}/entry/${event.entry}`;
	switch (event.kind) {
		case "user":
			return [
				`${time} user ${ref(event)}${event.injected ? " (agent-attributed: an extension or the parent agent)" : ""}`,
				...body(event.text, detail),
			];
		case "developer":
		case "thinking":
		case "say":
			return [`${time} ${event.kind} ${ref(event)}`, ...body(event.text, detail)];
		case "irc_out":
			return [`${time} irc me → ${event.to} ${ref(event)} ${callTail(event.call)}`, ...body(event.text, detail)];
		case "irc_in":
			return [`${time} irc ${flat(event.from)} → ${flat(event.to)} ${ref(event)}`, ...body(event.text, detail)];
		case "dispatch": {
			const agents = [...new Set(event.children.map((child) => child.agent))].join(", ");
			const lines = [`${time} dispatch ${ref(event)} → ${plural(event.children.length, "agent")} (${agents}) ${callTail(event.call)}`];
			if (event.context !== null) lines.push("  context:", ...body(event.context, detail).map((line) => `  ${line}`));
			for (const child of event.children)
				lines.push(`  ${flat(child.name)} (${flat(child.agent)}):`, ...body(child.task, detail).map((line) => `  ${line}`));
			return lines;
		}
		case "subresult":
			return [
				`${time} result ${flat(event.id)} · ${flat(event.agent)} · ${flat(event.status)} · ${flat(event.duration)} ${ref(event)}`,
				...body(event.text, detail),
				`  → ${root}/agents/${event.id}`,
			];
		case "exec":
			return [`${time} exec ${event.lang}! ${ref(event)} ${flat(event.status)}`, ...body(event.source, detail)];
		case "marker":
			return [`${time} ${flat(event.what)} ${ref(event)}${event.detail ? ` · ${flat(event.detail)}` : ""}`];
		default: {
			const unreachable: never = event;
			throw new Error(`Unhandled event ${String(unreachable)}`);
		}
	}
}

/**
 * The timeline: header, then per turn a turn line and its events; consecutive
 * calls of one assistant entry share a `calls` header. `root` is the root
 * session's canonical URL (subagent results point under it); `title` is OMP's
 * indexed title, else the journal's, else the first prompt (as OMP's own
 * session listing names untitled sessions).
 */
export function renderTimeline(loaded: LoadedSession, base: string, root: string, title: string | null): string {
	const { meta, events } = loaded;
	const firstPrompt = events.find((event) => event.kind === "user");
	const fallback = firstPrompt?.kind === "user" ? textOf(firstPrompt.text).split("\n", 1)[0]?.slice(0, 120) : undefined;
	const lines: string[] = [
		`session ${meta.sid}${meta.agent ? ` · agent ${meta.agent}` : ""} · ${meta.cwd}`,
		`title ${flat(title ?? meta.title ?? fallback ?? "(untitled)")}`,
		`start ${localStamp(meta.created)} · ${plural(meta.entries, "entry", "entries")} · ${meta.onBranch} on the active branch (leaf #${meta.leaf ?? "none"})`,
		`details ${base}/entry/<id> · events ${base}/events.jsonl · raw ${base}/raw.jsonl`,
	];
	if (meta.stats.invalidLines.length > 0)
		lines.push(
			`warning ${plural(meta.stats.invalidLines.length, "unparsable line")} skipped: ${meta.stats.invalidLines.slice(0, 20).join(", ")}`,
		);
	if (meta.stats.incompleteTail !== null) lines.push(`warning line ${meta.stats.incompleteTail} is still being written and is not shown`);
	lines.push("");

	const turns = new Map<number, SessionEvent[]>();
	for (const event of events) turns.set(event.turn, [...(turns.get(event.turn) ?? []), event]);
	let previousAt: number | null = null;
	let previousDate: string | null = null;
	for (const [turn, turnEvents] of turns) {
		lines.push(turnHeader(turn, turnEvents));
		let callsEntry: string | null = null;
		for (const event of turnEvents) {
			const at = Date.parse(event.t);
			const parts = localParts(event.t);
			if (previousAt !== null && !Number.isNaN(at) && at - previousAt >= IDLE_MS) lines.push(`── idle ${duration(at - previousAt)} ──`);
			if (parts && previousDate !== null && parts.date !== previousDate) lines.push(`── ${parts.date} ──`);
			if (!Number.isNaN(at)) previousAt = at;
			if (parts) previousDate = parts.date;
			const time = parts?.time ?? "--:--:--";
			if (event.kind === "call") {
				if (callsEntry !== event.entry) lines.push(`${time} calls #${event.entry}`);
				callsEntry = event.entry;
				lines.push(`  ${signature(event.call)} ${callTail(event.call)}`);
				continue;
			}
			callsEntry = null;
			lines.push(...eventLines(event, time, base, root));
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Plain JSON value of a projection; a clipped string becomes its prefix plus a clip marker. */
export function toJson(value: Projected): unknown {
	if (value instanceof Clipped) return `${value.text}…[clipped: ${value.chars} chars total]`;
	if (Array.isArray(value)) return value.map(toJson);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = toJson(item);
		return out;
	}
	return value;
}

function eventFields(event: SessionEvent): Record<string, unknown> {
	switch (event.kind) {
		case "user":
			return { text: toJson(event.text), injected: event.injected };
		case "developer":
		case "thinking":
		case "say":
			return { text: toJson(event.text) };
		case "call":
		case "irc_out":
		case "dispatch": {
			const call = event.call;
			const fields: Record<string, unknown> = {
				tool: call.tool,
				args: toJson(call.args),
				intent: call.intent,
				status: call.status,
				resultEntry: call.resultEntry,
				resultChars: call.resultChars,
				durMs: call.durMs,
			};
			if (event.kind === "irc_out") Object.assign(fields, { to: event.to, text: toJson(event.text) });
			if (event.kind === "dispatch")
				Object.assign(fields, {
					context: event.context === null ? null : toJson(event.context),
					children: event.children.map((child) => ({ name: child.name, agent: child.agent, task: toJson(child.task) })),
				});
			return fields;
		}
		case "irc_in":
			return { from: event.from, to: event.to, text: toJson(event.text) };
		case "subresult":
			return { id: event.id, agent: event.agent, status: event.status, duration: event.duration, text: toJson(event.text) };
		case "exec":
			return { lang: event.lang, source: toJson(event.source), status: event.status };
		case "marker":
			return { what: event.what, detail: event.detail };
		default: {
			const unreachable: never = event;
			throw new Error(`Unhandled event ${String(unreachable)}`);
		}
	}
}

/** One JSON object per event, for jq. */
export function eventRecords(loaded: LoadedSession, base: string): Array<Record<string, unknown>> {
	const { meta } = loaded;
	return loaded.events.map((event) => ({
		sid: meta.sid,
		agent: meta.agent,
		turn: event.turn,
		t: event.t,
		kind: event.kind,
		entry: event.entry,
		block: event.block,
		line: event.line,
		...eventFields(event),
		url: `${base}/entry/${event.entry}`,
	}));
}

function contentText(value: Projected | undefined): string | null {
	if (typeof value === "string" || value instanceof Clipped) return String(toJson(value));
	if (!Array.isArray(value)) return null;
	return value
		.map((block) => {
			if (block === null || typeof block !== "object" || Array.isArray(block) || block instanceof Clipped) return "";
			const type = block.type;
			if (type === "image") return "[image]";
			const body = block.text;
			return typeof body === "string" || body instanceof Clipped ? String(toJson(body)) : "";
		})
		.join("\n");
}

/** One entry in full: a tool result shows its call (arguments, intent, timing) and the whole result text. */
export function renderEntry(detail: EntryDetail, base: string, sid: string): string {
	const record = detail.record;
	const fields = record !== null && typeof record === "object" && !Array.isArray(record) && !(record instanceof Clipped) ? record : null;
	const message = fields?.message;
	const messageFields =
		message !== null && typeof message === "object" && !Array.isArray(message) && !(message instanceof Clipped) ? message : null;
	const lines = [
		`entry #${String(toJson(fields?.id ?? null))} · line ${detail.line} · ${String(toJson(fields?.type ?? null))} · raw ${base}/raw.jsonl:${detail.line}`,
	];
	if (messageFields?.role === "toolResult") {
		lines.push(
			`tool ${String(toJson(messageFields.toolName ?? null))} · ${messageFields.isError === true ? "error" : "ok"} · call ${String(toJson(messageFields.toolCallId ?? null))}`,
		);
		const startData =
			detail.start !== null && typeof detail.start === "object" && !Array.isArray(detail.start) && !(detail.start instanceof Clipped)
				? detail.start.data
				: null;
		if (startData) lines.push(`start ${JSON.stringify(toJson(startData))}`);
		lines.push("", "arguments:", JSON.stringify(toJson(detail.call ?? null), null, 2), "", "result:");
		lines.push(textOf(rewriteRefs(contentText(messageFields.content) ?? "", sid)));
		return `${lines.join("\n")}\n`;
	}
	lines.push("", JSON.stringify(toJson(record), null, 2));
	return `${lines.join("\n")}\n`;
}
