// Session JSONL → normalized timeline events.
// One streaming pass projects each record with TIMELINE (speech kept, tool
// output measured only) into compact per-entry items; the active branch is
// then chosen by OMP's own leaf replay and walked root→leaf. Tool calls are
// completed from their results and tool_execution_start records wherever they
// sit in the file. `<task-result>` blocks (async-result messages and wait/task
// results) become subagent results, deduplicated. Every text has its
// artifact://, agent://, history:// and local:// references rewritten to the
// owning session so a reader never resolves them against its own session.
import { activeLeaf, type LeafNode } from "./omp-adapter.ts";
import {
	Clipped,
	each,
	keepAll,
	keys,
	type Policy,
	type Projected,
	type ProjectedObject,
	type ScanStats,
	SKIP,
	scalar,
	scanChunks,
} from "./scanner.ts";

export type Text = string | Clipped;

const SPEECH = 1 << 20;
const ARG = 64 * 1024;
const ID = scalar(512);
const FLAG = scalar(0);
const DETAIL_CAP = 2 << 20;

const DETAILS = keys({ from: ID, to: ID, message: scalar(SPEECH), body: scalar(SPEECH), pool: ID });
const BLOCK = keys({
	type: ID,
	text: scalar(SPEECH),
	thinking: scalar(SPEECH),
	summary: FLAG,
	name: ID,
	id: ID,
	arguments: keepAll(ARG, 500),
	path: ID,
});
const CONTENT: Policy = { kind: "keep", cap: SPEECH, maxItems: 1000, child: () => BLOCK };
const MESSAGE = keys({
	role: ID,
	content: CONTENT,
	toolCallId: ID,
	toolName: ID,
	isError: FLAG,
	attribution: ID,
	customType: ID,
	display: FLAG,
	details: DETAILS,
	command: scalar(ARG),
	code: scalar(ARG),
	exitCode: FLAG,
	cancelled: FLAG,
	excludeFromContext: FLAG,
	summary: scalar(400),
	files: each(keys({ path: ID }), 200),
});
const TIMELINE: Policy = keys({
	type: ID,
	id: ID,
	parentId: ID,
	timestamp: ID,
	activeLeafId: ID,
	version: FLAG,
	cwd: ID,
	title: ID,
	parentSession: ID,
	customType: ID,
	display: FLAG,
	attribution: ID,
	content: CONTENT,
	details: DETAILS,
	data: keys({ toolCallId: ID, toolName: ID, startedAt: ID, intent: ID, reason: ID, kind: ID }),
	summary: scalar(400),
	model: ID,
	role: ID,
	thinkingLevel: ID,
	mode: ID,
	label: ID,
	targetId: ID,
	fromId: ID,
	message: MESSAGE,
});

/** A tool call completed from its result and start records. */
export interface Call {
	readonly id: string;
	readonly tool: string;
	readonly args: Projected;
	readonly intent: string | null;
	readonly status: "pending" | "ok" | "error";
	readonly resultEntry: string | null;
	readonly resultChars: number | null;
	readonly durMs: number | null;
}

export interface Child {
	readonly name: string;
	readonly agent: string;
	readonly task: Text;
}

interface Base {
	readonly entry: string;
	readonly block: number | null;
	readonly t: string;
	readonly line: number;
	readonly turn: number;
}

export type SessionEvent =
	| (Base & { readonly kind: "user"; readonly text: Text; readonly injected: boolean })
	| (Base & { readonly kind: "developer"; readonly text: Text })
	| (Base & { readonly kind: "thinking"; readonly text: Text })
	| (Base & { readonly kind: "say"; readonly text: Text })
	| (Base & { readonly kind: "call"; readonly call: Call })
	| (Base & { readonly kind: "irc_out"; readonly to: string; readonly text: Text; readonly call: Call })
	| (Base & { readonly kind: "dispatch"; readonly call: Call; readonly context: Text | null; readonly children: readonly Child[] })
	| (Base & { readonly kind: "irc_in"; readonly from: string; readonly to: string; readonly text: Text })
	| (Base & {
			readonly kind: "subresult";
			readonly id: string;
			readonly agent: string;
			readonly status: string;
			readonly duration: string;
			readonly text: Text;
	  })
	| (Base & { readonly kind: "exec"; readonly lang: "bash" | "python"; readonly source: Text; readonly status: string })
	| (Base & { readonly kind: "marker"; readonly what: string; readonly detail: string });

export interface SessionMeta {
	readonly sid: string;
	readonly agent: string;
	readonly file: string;
	readonly cwd: string;
	readonly title: string | null;
	readonly created: string;
	readonly parentSession: string | null;
	readonly leaf: string | null;
	readonly entries: number;
	readonly onBranch: number;
	readonly stats: ScanStats;
}

export interface LoadedSession {
	readonly meta: SessionMeta;
	readonly events: readonly SessionEvent[];
}

/** An item awaiting branch selection and call completion; `turn` is assigned in branch order. */
type Item =
	| { readonly kind: "user"; readonly block: number | null; readonly text: Text; readonly injected: boolean }
	| { readonly kind: "developer" | "thinking" | "say"; readonly block: number | null; readonly text: Text }
	| { readonly kind: "call"; readonly block: number; readonly id: string; readonly tool: string; readonly args: Projected }
	| { readonly kind: "irc_in"; readonly from: string; readonly to: string; readonly text: Text }
	| {
			readonly kind: "subresult";
			readonly id: string;
			readonly agent: string;
			readonly status: string;
			readonly duration: string;
			readonly text: Text;
	  }
	| { readonly kind: "exec"; readonly lang: "bash" | "python"; readonly source: Text; readonly status: string }
	| { readonly kind: "marker"; readonly what: string; readonly detail: string };

interface Node extends LeafNode {
	readonly parentId: string | null;
	readonly line: number;
	readonly t: string;
	readonly items: readonly Item[];
}

interface ResultInfo {
	readonly entry: string;
	readonly isError: boolean;
	readonly chars: number;
	readonly t: string;
}

const TASK_RESULT = /<task-result id="([^"]*)" agent="([^"]*)" status="([^"]*)" duration="([^"]*)">([\s\S]*?)<\/task-result>/g;
const OUTPUT = /<output>\n?([\s\S]*?)\n?<\/output>/;
const SUBAGENT_RESULT_TOOLS: Readonly<Record<string, true>> = { wait: true, task: true, fork_task: true };

function str(value: Projected | undefined): string | null {
	if (typeof value === "string") return value;
	if (value instanceof Clipped) return value.text;
	return null;
}

function text(value: Projected | undefined): Text | null {
	return typeof value === "string" || value instanceof Clipped ? value : null;
}

function obj(value: Projected | undefined): ProjectedObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Clipped) ? value : null;
}

/** Joins a string-or-blocks content field's text blocks; images become `[image]`. */
function contentText(value: Projected | undefined): Text | null {
	const direct = text(value);
	if (direct !== null) return direct;
	if (!Array.isArray(value)) return null;
	const parts: string[] = [];
	let clipped = false;
	let chars = 0;
	for (const block of value) {
		const fields = obj(block);
		if (!fields) continue;
		const type = str(fields.type);
		if (type === "image") parts.push("[image]");
		const body = text(fields.text);
		if (body === null) continue;
		if (body instanceof Clipped) {
			clipped = true;
			chars += body.chars;
			parts.push(body.text);
		} else {
			chars += body.length;
			parts.push(body);
		}
	}
	const joined = parts.join("\n");
	return clipped ? new Clipped(joined, chars, joined.split("\n").length) : joined;
}

function textChars(value: Text): number {
	return value instanceof Clipped ? value.chars : value.length;
}

const TAG_ONLY = /^<\/?[\w:.-]+(?:\s[^>]*)?>$/;

/** First line carrying content (bare wrapper tags such as `<system-notice>` skipped), cut to `max`. */
function firstLine(value: Text | null, max = 160): string {
	const lines = (value instanceof Clipped ? value.text : (value ?? "")).split("\n");
	const flat = lines.map((line) => line.trim()).find((line) => line !== "" && !TAG_ONLY.test(line)) ?? "";
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Rewrites references to the owning session's resources into session:// URLs. */
export function rewriteRefs(value: Text, sid: string): Text {
	const rewrite = (input: string): string =>
		input
			.replace(/\bartifact:\/\/(\d+)/g, `session://${sid}/artifacts/$1`)
			.replace(/\b(?:agent|history):\/\/((?!all\b)[A-Za-z0-9_.-]+)/g, `session://${sid}/agents/$1`)
			.replace(/\blocal:\/\/([^\s)\]`'"<>]+)/g, `session://${sid}/local/$1`);
	return value instanceof Clipped ? new Clipped(rewrite(value.text), value.chars, value.lines) : rewrite(value);
}

function taskResults(body: Text): Item[] {
	const items: Item[] = [];
	for (const match of (body instanceof Clipped ? body.text : body).matchAll(TASK_RESULT)) {
		const inner = match[5] ?? "";
		items.push({
			kind: "subresult",
			id: match[1] ?? "",
			agent: match[2] ?? "",
			status: match[3] ?? "",
			duration: match[4] ?? "",
			text: (OUTPUT.exec(inner)?.[1] ?? inner).trim(),
		});
	}
	return items;
}

/** Items of a custom (non-tool) message, from either a custom_message entry or a custom-role message. */
function customItems(customType: string, fields: ProjectedObject, agent: string): Item[] {
	const details = obj(fields.details);
	const body = contentText(fields.content);
	switch (customType) {
		case "irc:incoming":
			return [{ kind: "irc_in", from: str(details?.from) ?? "?", to: agent || "main", text: text(details?.message) ?? body ?? "" }];
		case "irc:relay":
			return [{ kind: "irc_in", from: str(details?.from) ?? "?", to: str(details?.to) ?? "?", text: text(details?.body) ?? body ?? "" }];
		case "irc:workpool":
			return [
				{ kind: "irc_in", from: `pool ${str(details?.pool) ?? "?"}`, to: str(details?.to) ?? "?", text: text(details?.body) ?? body ?? "" },
			];
		case "async-result": {
			const results = body === null ? [] : taskResults(body);
			return results.length > 0 ? results : [{ kind: "marker", what: customType, detail: firstLine(body) }];
		}
		default:
			return [{ kind: "marker", what: customType, detail: firstLine(body) }];
	}
}

interface Collector {
	readonly results: Map<string, ResultInfo>;
	readonly starts: Map<string, { readonly intent: string | null; readonly startedAt: string | null }>;
}

/** Items of one `message` entry. */
function messageItems(message: ProjectedObject, entry: string, t: string, agent: string, collector: Collector): Item[] {
	const role = str(message.role);
	switch (role) {
		case "user": {
			const body = contentText(message.content);
			return body === null ? [] : [{ kind: "user", block: null, text: body, injected: str(message.attribution) === "agent" }];
		}
		case "developer": {
			const body = contentText(message.content);
			return body === null ? [] : [{ kind: "developer", block: null, text: body }];
		}
		case "assistant": {
			const items: Item[] = [];
			const blocks = Array.isArray(message.content) ? message.content : [];
			blocks.forEach((value, block) => {
				const fields = obj(value);
				if (!fields) return;
				const type = str(fields.type);
				if (type === "thinking") {
					const body = text(fields.thinking);
					if (body !== null && textChars(body) > 0) items.push({ kind: "thinking", block, text: body });
				} else if (type === "redactedThinking") items.push({ kind: "marker", what: "thinking", detail: "redacted" });
				else if (type === "text") {
					const body = text(fields.text);
					if (body !== null && textChars(body) > 0) items.push({ kind: "say", block, text: body });
				} else if (type === "toolCall")
					items.push({
						kind: "call",
						block,
						id: str(fields.id) ?? `${entry}.${block}`,
						tool: str(fields.name) ?? "?",
						args: fields.arguments ?? null,
					});
				else if (type !== null && type !== "image") items.push({ kind: "marker", what: type, detail: str(fields.name) ?? "" });
			});
			return items;
		}
		case "toolResult": {
			const callId = str(message.toolCallId);
			const body = contentText(message.content);
			if (callId !== null)
				collector.results.set(callId, { entry, isError: message.isError === true, chars: body === null ? 0 : textChars(body), t });
			// Only the subagent tools deliver `<task-result>` blocks; elsewhere the text is tool output.
			return body !== null && SUBAGENT_RESULT_TOOLS[str(message.toolName) ?? ""] === true ? taskResults(body) : [];
		}
		case "bashExecution":
		case "pythonExecution": {
			if (message.excludeFromContext === true) return [];
			const exit = message.exitCode;
			const status = message.cancelled === true ? "cancelled" : typeof exit === "number" && exit !== 0 ? `error · exit ${exit}` : "ok";
			const source = text(role === "bashExecution" ? message.command : message.code) ?? "";
			return [{ kind: "exec", lang: role === "bashExecution" ? "bash" : "python", source, status }];
		}
		case "custom":
		case "hookMessage":
			return customItems(str(message.customType) ?? role, message, agent);
		case "fileMention": {
			const files = Array.isArray(message.files) ? message.files.map((file) => str(obj(file)?.path) ?? "?") : [];
			return [{ kind: "marker", what: "file mention", detail: files.join(", ") }];
		}
		case "branchSummary":
		case "compactionSummary":
			return [{ kind: "marker", what: role, detail: firstLine(text(message.summary)) }];
		default:
			return role === null ? [] : [{ kind: "marker", what: role, detail: "" }];
	}
}

/** Items of one non-header entry; also records results and tool starts into `collector`. */
function entryItems(record: ProjectedObject, entry: string, t: string, agent: string, collector: Collector): Item[] {
	const type = str(record.type);
	switch (type) {
		case "message": {
			const message = obj(record.message);
			return message ? messageItems(message, entry, t, agent, collector) : [];
		}
		case "custom_message":
			return customItems(str(record.customType) ?? "custom_message", record, agent);
		case "custom": {
			const customType = str(record.customType) ?? "custom";
			const data = obj(record.data);
			if (customType === "tool_execution_start") {
				const callId = str(data?.toolCallId);
				if (callId !== null) collector.starts.set(callId, { intent: str(data?.intent), startedAt: str(data?.startedAt) });
				return [];
			}
			if (customType === "session_exit")
				return [{ kind: "marker", what: "session exit", detail: [str(data?.kind), str(data?.reason)].filter(Boolean).join(" · ") }];
			return [];
		}
		case "compaction":
			return [{ kind: "marker", what: "compaction", detail: firstLine(text(record.summary)) }];
		case "branch_summary":
			return [
				{ kind: "marker", what: "branch summary", detail: `from #${str(record.fromId) ?? "?"} · ${firstLine(text(record.summary))}` },
			];
		case "model_change":
			return [{ kind: "marker", what: "model", detail: [str(record.model), str(record.role)].filter(Boolean).join(" · ") }];
		case "thinking_level_change":
			return [{ kind: "marker", what: "thinking level", detail: str(record.thinkingLevel) ?? "off" }];
		case "mode_change":
			return [{ kind: "marker", what: "mode", detail: str(record.mode) ?? "" }];
		case "title_change":
			return [{ kind: "marker", what: "title", detail: str(record.title) ?? "" }];
		case "reset_boundary":
			return [{ kind: "marker", what: "context reset", detail: "" }];
		case "label":
			return [{ kind: "marker", what: "label", detail: `${str(record.label) ?? "(cleared)"} → #${str(record.targetId) ?? "?"}` }];
		case "session_init":
			return [{ kind: "marker", what: "session init", detail: "" }];
		default:
			return [];
	}
}

function parseTime(value: string | null): number | null {
	if (value === null) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
}

/** The completed call for `item` (status, result entry, intent, duration). */
function completeCall(item: Extract<Item, { kind: "call" }>, t: string, collector: Collector): Call {
	const result = collector.results.get(item.id);
	const start = collector.starts.get(item.id);
	const began = parseTime(start?.startedAt ?? null) ?? parseTime(t);
	const ended = parseTime(result?.t ?? null);
	const argIntent = str(obj(item.args)?.i);
	return {
		id: item.id,
		tool: item.tool,
		args: item.args,
		intent: start?.intent ?? argIntent,
		status: result === undefined ? "pending" : result.isError ? "error" : "ok",
		resultEntry: result?.entry ?? null,
		resultChars: result?.chars ?? null,
		durMs: began !== null && ended !== null ? Math.max(0, ended - began) : null,
	};
}

/** Turns a completed call into its event kind: outgoing IRC, dispatch, or a plain call. */
function callEvent(base: Base, call: Call): SessionEvent {
	const args = obj(call.args);
	if (call.tool === "write") {
		const target = str(args?.path);
		const match = target === null ? null : /^agent:\/\/([^/?#\s]+)$/.exec(target);
		if (match) return { ...base, kind: "irc_out", to: match[1] ?? "?", text: text(args?.content) ?? "", call };
	}
	if (call.tool === "task" || call.tool === "fork_task") {
		const tasks = Array.isArray(args?.tasks) ? args.tasks : null;
		const children: Child[] = (tasks ?? (args ? [args] : [])).flatMap((value) => {
			const item = obj(value);
			if (!item) return [];
			return [
				{
					name: str(item.name) ?? "?",
					agent: str(item.agent) ?? (call.tool === "fork_task" ? "fork" : "task"),
					task: text(item.task) ?? "",
				},
			];
		});
		return { ...base, kind: "dispatch", call, context: text(args?.context), children };
	}
	return { ...base, kind: "call", call };
}

function rewriteEvent(event: SessionEvent, sid: string): SessionEvent {
	switch (event.kind) {
		case "user":
		case "developer":
		case "thinking":
		case "say":
		case "irc_in":
		case "subresult":
		case "irc_out":
			return { ...event, text: rewriteRefs(event.text, sid) };
		case "dispatch":
			return {
				...event,
				context: event.context === null ? null : rewriteRefs(event.context, sid),
				children: event.children.map((child) => ({ ...child, task: rewriteRefs(child.task, sid) })),
			};
		case "call":
		case "exec":
		case "marker":
			return event;
		default: {
			const unreachable: never = event;
			throw new Error(`Unhandled event ${String(unreachable)}`);
		}
	}
}

/**
 * Loads one session file (`agent` = "" for the root session, else the subagent id)
 * as its active-branch timeline. `sid` is the root session's full id.
 */
export async function loadSession(file: string, sid: string, agent: string, signal?: AbortSignal): Promise<LoadedSession> {
	const nodes: Node[] = [];
	const collector: Collector = { results: new Map(), starts: new Map() };
	const state: { header: ProjectedObject | null; title: string | null; previous: string | null } = {
		header: null,
		title: null,
		previous: null,
	};
	const stats = await scanChunks(
		Bun.file(file).stream(),
		() => TIMELINE,
		(record) => {
			const fields = obj(record.value);
			if (!fields) return;
			const type = str(fields.type);
			if (type === "session") {
				state.header = fields;
				return;
			}
			if (type === "title") {
				state.title = str(fields.title);
				return;
			}
			if (type === "title_change") state.title = str(fields.title) ?? state.title;
			// v1 journals carry no ids; OMP's migration links them linearly, so do the same with stable line ids.
			const version = state.header?.version;
			const legacy = typeof version !== "number" || version < 2;
			const id = (!legacy && str(fields.id)) || `legacy-${record.line}`;
			const parentId = legacy ? state.previous : str(fields.parentId);
			state.previous = id;
			const t = str(fields.timestamp) ?? "";
			const activeLeafId = fields.activeLeafId === null ? null : (str(fields.activeLeafId) ?? undefined);
			nodes.push({ id, parentId, activeLeafId, line: record.line, t, items: entryItems(fields, id, t, agent, collector) });
		},
		signal,
	);
	const { header: headerFields, title } = state;
	const leaf = activeLeaf(nodes);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const branch: Node[] = [];
	const seen = new Set<string>();
	for (
		let current = leaf === null ? undefined : byId.get(leaf);
		current && !seen.has(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined
	) {
		seen.add(current.id);
		branch.push(current);
	}
	branch.reverse();

	const events: SessionEvent[] = [];
	const seenResults = new Set<string>();
	let turn = 0;
	for (const node of branch) {
		for (const item of node.items) {
			const block = "block" in item ? item.block : null;
			// A subagent's first prompt comes from its parent with agent attribution, so every prompt there opens a turn.
			if (item.kind === "user" && (!item.injected || agent !== "")) turn++;
			const base: Base = { entry: node.id, block, t: node.t, line: node.line, turn };
			let event: SessionEvent;
			switch (item.kind) {
				case "call":
					event = callEvent(base, completeCall(item, node.t, collector));
					break;
				case "subresult": {
					const key = `${item.id}|${item.status}|${item.duration}`;
					if (seenResults.has(key)) continue;
					seenResults.add(key);
					event = { ...base, ...item };
					break;
				}
				case "user":
				case "developer":
				case "thinking":
				case "say":
				case "irc_in":
				case "exec":
				case "marker":
					event = { ...base, ...item };
					break;
				default: {
					const unreachable: never = item;
					throw new Error(`Unhandled item ${String(unreachable)}`);
				}
			}
			events.push(rewriteEvent(event, sid));
		}
	}

	const created = str(headerFields?.timestamp) ?? nodes[0]?.t ?? "";
	return {
		meta: {
			sid,
			agent,
			file,
			cwd: str(headerFields?.cwd) ?? "",
			title: title || str(headerFields?.title) || null,
			created,
			parentSession: str(headerFields?.parentSession),
			leaf,
			entries: nodes.length,
			onBranch: branch.length,
			stats,
		},
		events,
	};
}

const INDEX: Policy = keys({
	type: ID,
	id: ID,
	customType: ID,
	data: keys({ toolCallId: ID }),
	message: keys({ role: ID, toolCallId: ID, content: each(keys({ type: ID, id: ID })) }),
});
const DETAIL: Policy = {
	kind: "keep",
	cap: DETAIL_CAP,
	maxItems: 5000,
	child: (key) => (key === "thinkingSignature" || key === "textSignature" || key === "providerPayload" ? SKIP : DETAIL),
};

export type EntrySelector = { readonly kind: "id"; readonly id: string } | { readonly kind: "line"; readonly line: number };

export interface EntryDetail {
	readonly line: number;
	readonly record: Projected;
	/** For a tool result: the assistant's toolCall block and the tool_execution_start record. */
	readonly call: Projected | null;
	readonly start: Projected | null;
}

/**
 * Finds one entry anywhere in the file (any branch) and projects it in detail.
 * Pass one indexes lines; pass two builds only the target line and, for a tool
 * result, its toolCall and start lines. Null when absent.
 */
export async function loadEntry(file: string, selector: EntrySelector, signal?: AbortSignal): Promise<EntryDetail | null> {
	const callLines = new Map<string, number>();
	const startLines = new Map<string, number>();
	const target: { line: number | null; callId: string | null } = { line: null, callId: null };
	await scanChunks(
		Bun.file(file).stream(),
		() => INDEX,
		(record) => {
			const fields = obj(record.value);
			if (!fields) return;
			const message = obj(fields.message);
			for (const block of Array.isArray(message?.content) ? message.content : []) {
				const id = str(obj(block)?.id);
				if (id !== null && str(obj(block)?.type) === "toolCall") callLines.set(id, record.line);
			}
			if (str(fields.customType) === "tool_execution_start") {
				const callId = str(obj(fields.data)?.toolCallId);
				if (callId !== null) startLines.set(callId, record.line);
			}
			const hit = selector.kind === "line" ? record.line === selector.line : str(fields.id) === selector.id;
			if (hit && target.line === null) {
				target.line = record.line;
				target.callId = str(message?.role) === "toolResult" ? str(message?.toolCallId) : null;
			}
		},
		signal,
	);
	const { line, callId } = target;
	if (line === null) return null;
	const callLine = callId === null ? null : (callLines.get(callId) ?? null);
	const startLine = callId === null ? null : (startLines.get(callId) ?? null);
	const wanted = new Set([line, callLine, startLine].filter((value): value is number => value !== null));
	const records = new Map<number, Projected>();
	await scanChunks(
		Bun.file(file).stream(),
		(current) => (wanted.has(current) ? DETAIL : SKIP),
		(record) => records.set(record.line, record.value),
		signal,
	);
	const blocks = callLine === null ? null : obj(obj(records.get(callLine))?.message)?.content;
	return {
		line,
		record: records.get(line) ?? null,
		call: (Array.isArray(blocks) ? blocks : []).find((block) => str(obj(block)?.id) === callId) ?? null,
		start: startLine === null ? null : (records.get(startLine) ?? null),
	};
}
