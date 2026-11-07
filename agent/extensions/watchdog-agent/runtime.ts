import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { textOf as textBlocks } from "../_shared/messages.ts";
import { describeFilter, type InjectMode, producerMatches, type SessionFilter, targetsSession } from "../_shared/session-filter.ts";
import {
	buildAddPrompt,
	buildEditPrompt,
	type DraftContext,
	parseWatchdogCommand,
	projectRoot,
	type ToggleScope,
	touchedWatchdogFiles,
	type WatchdogCommand,
} from "./commands.ts";
import {
	branchMessages,
	countActions,
	defaultReviewerModel,
	isOwnUserNote,
	messageTimestamp,
	producerOf,
	renderTranscript,
	runJev,
	runReviewer,
	selectMessages,
} from "./review.ts";
import {
	type DeliverAs,
	discoverWatchdogFiles,
	hasKey,
	parseWatchdogFile,
	setFrontmatterEnabled,
	type Verdict,
	WATCHDOG_FILTER_KEYS,
	type WatchdogSpec,
} from "./spec.ts";

/** A finding waiting for the user's next prompt (`delivery: nextTurn`), already in its inject form. */
type QueuedNote = { readonly filePath: string; readonly inject: InjectMode; readonly text: string };

/** One record per loaded extension; session boundaries rebuild branch-derived state. */
type Runtime = {
	readonly pi: ExtensionAPI;
	identity: ExtensionContext["agent"] | null;
	cwd: () => string;
	roster: WatchdogSpec[];
	overrides: Map<string, boolean>;
	states: Map<string, WatchdogState>;
	branchOf: () => ReadonlyArray<unknown>;
	/** User-mode note index over the branch, folded as the branch grows. */
	notes: NoteIndex;
	nextTurnQueue: QueuedNote[];
	userTurnArmed: boolean;
	/** Set by `session_shutdown` until the next session boundary: in-flight reviews abort and nothing new starts. */
	closed: boolean;
};

export function registerWatchdog(pi: ExtensionAPI): void {
	const runtime: Runtime = {
		pi,
		identity: null,
		cwd: () => process.cwd(),
		roster: [],
		overrides: new Map(),
		states: new Map(),
		branchOf: () => [],
		notes: { count: 0, anchor: undefined, index: new Map() },
		nextTurnQueue: [],
		userTurnArmed: false,
		closed: false,
	};
	registerCommand(runtime);
	registerEvents(runtime);
}

// --- extension registration -------------------------------------------------

/**
 * `running` keeps the session-level abort handle and the review's settling promise:
 * a switch aborts it, a shutdown aborts it and awaits `done` before the session ends.
 */
type RunState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly flushAfter: boolean; readonly controller: AbortController; readonly done: Promise<void> };

/** Per-watchdog runtime state; each watchdog counts, runs and caps on its own. */
type WatchdogState = {
	/** Latest parse of the watchdog's file; replaced in place when the roster is re-read. */
	spec: WatchdogSpec;
	/** Watched actions since this watchdog's last run started; restored as the actions after the cursor. */
	pending: number;
	/** Newest message timestamp covered by the last review that reached a verdict; persisted per file. */
	cursor: number;
	run: RunState;
	/** Advisories delivered since the last compaction; restored from the branch; compared against `maxPerContext`. */
	sent: number;
	/** `full` scope: the transcript rendered so far, and the branch message entries it covers. */
	full: { readonly text: string; readonly count: number } | null;
};

/** Session-scoped switch for one watchdog file, persisted as a custom session entry. */
const OVERRIDE_ENTRY_TYPE = "mouriya.omp.watchdog-agent.override";
type SessionOverride = { readonly filePath: string; readonly enabled: boolean | null };

function parseOverride(data: unknown): SessionOverride | null {
	if (!hasKey(data, "filePath") || typeof data.filePath !== "string" || !hasKey(data, "enabled")) return null;
	const enabled = data.enabled;
	if (enabled !== null && typeof enabled !== "boolean") return null;
	return { filePath: data.filePath, enabled };
}

/** Session overrides in effect on the given branch: the last entry per file wins; `null` clears. */
function overridesFromBranch(entries: ReadonlyArray<unknown>): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "custom" || !hasKey(e, "customType") || e.customType !== OVERRIDE_ENTRY_TYPE) continue;
		const parsed = parseOverride(hasKey(e, "data") ? e.data : undefined);
		if (!parsed) continue;
		if (parsed.enabled === null) out.delete(parsed.filePath);
		else out.set(parsed.filePath, parsed.enabled);
	}
	return out;
}

/** Window cursor of one watchdog file, persisted after each review that reaches a verdict. */
const CURSOR_ENTRY_TYPE = "mouriya.omp.watchdog-agent.cursor";
type CursorEntry = { readonly filePath: string; readonly cursor: number };

/** Cursors in effect on the given branch: the last entry per file wins. */
function cursorsFromBranch(entries: ReadonlyArray<unknown>): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "custom" || !hasKey(e, "customType") || e.customType !== CURSOR_ENTRY_TYPE) continue;
		const data = hasKey(e, "data") ? e.data : undefined;
		if (!hasKey(data, "filePath") || typeof data.filePath !== "string" || !hasKey(data, "cursor") || typeof data.cursor !== "number")
			continue;
		out.set(data.filePath, data.cursor);
	}
	return out;
}

/** Attribute-safe watchdog name, as written into the injected `<watchdog name="…">` tag. */
function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Custom message type of system-mode notes (stored as `custom_message` session entries, `details: { filePaths }`). */
const NOTE_CUSTOM_TYPE = "watchdog";

/**
 * Index of user-mode notes: the text a watchdog sent as a user message and the files it came from.
 * It records the send, not the delivery; a note counts only once an agent-attributed user message
 * with that text is on the branch.
 */
const USER_NOTE_ENTRY_TYPE = "mouriya.omp.watchdog-agent.user-note";
type UserNoteEntry = { readonly filePaths: readonly string[]; readonly text: string };

function filePathsOf(data: unknown): readonly string[] {
	if (!hasKey(data, "filePaths") || !Array.isArray(data.filePaths)) return [];
	return data.filePaths.filter((path): path is string => typeof path === "string");
}

/** User-mode note index over the branch prefix folded so far, and the entry that prefix ends at. */
type NoteIndex = { count: number; anchor: unknown; index: Map<string, readonly string[]> };

/** Fold one branch entry into the note index: its trimmed text → the watchdog files it came from. */
function foldNote(entry: unknown, out: Map<string, readonly string[]>): void {
	if (!hasKey(entry, "type") || entry.type !== "custom" || !hasKey(entry, "customType") || entry.customType !== USER_NOTE_ENTRY_TYPE)
		return;
	const data = hasKey(entry, "data") ? entry.data : undefined;
	if (!hasKey(data, "text") || typeof data.text !== "string") return;
	out.set(data.text.trim(), filePathsOf(data));
}

/**
 * The note index up to the end of `entries`, folded incrementally: entries already folded are
 * not rescanned. An anchor that no longer sits where it was folded (a replaced or shortened
 * branch) rebuilds the index from the start.
 */
function noteIndexOf(runtime: Runtime, entries: ReadonlyArray<unknown>): Map<string, readonly string[]> {
	const notes = runtime.notes;
	if (notes.count > entries.length || (notes.count > 0 && entries[notes.count - 1] !== notes.anchor)) {
		notes.count = 0;
		notes.index = new Map();
	}
	for (let i = notes.count; i < entries.length; i++) foldNote(entries[i], notes.index);
	notes.count = entries.length;
	notes.anchor = entries[entries.length - 1];
	return notes.index;
}

/** Watchdog files a branch entry carries a delivered note of: a system-mode custom message, or an indexed user-mode message. */
function noteFiles(entry: unknown, index: ReadonlyMap<string, readonly string[]>): readonly string[] {
	if (!hasKey(entry, "type")) return [];
	if (entry.type === "custom_message" && hasKey(entry, "customType") && entry.customType === NOTE_CUSTOM_TYPE)
		return filePathsOf(hasKey(entry, "details") ? entry.details : undefined);
	if (entry.type !== "message" || !hasKey(entry, "message")) return [];
	const message = entry.message;
	if (!isOwnUserNote(message, index)) return [];
	return index.get(textBlocks(hasKey(message, "content") ? message.content : undefined).trim()) ?? [];
}

/** Notes of the watchdog file delivered on the branch since its last compaction. */
function deliveredSinceCompaction(
	entries: ReadonlyArray<unknown>,
	filePath: string,
	index: ReadonlyMap<string, readonly string[]>,
): number {
	let count = 0;
	for (const e of entries) {
		if (hasKey(e, "type") && e.type === "compaction") count = 0;
		else if (noteFiles(e, index).includes(filePath)) count += 1;
	}
	return count;
}

/** Watched actions of a message: its actions when the filter's model/provider constraints match its producer, else 0. */
function watchedActions(filter: SessionFilter, message: unknown): number {
	const producer = producerOf(message);
	return producer !== null && producerMatches(filter, producer) ? countActions(message) : 0;
}

/** Watched actions on the branch stamped after the cursor. */
function actionsAfter(entries: ReadonlyArray<unknown>, cursor: number, filter: SessionFilter): number {
	let count = 0;
	for (const m of branchMessages(entries)) {
		if ((messageTimestamp(m) ?? 0) > cursor) count += watchedActions(filter, m);
	}
	return count;
}

function targetsHere(runtime: Runtime, spec: WatchdogSpec): boolean {
	return runtime.identity !== null && targetsSession(spec.filter, runtime.identity, runtime.cwd());
}
function effectiveEnabled(runtime: Runtime, spec: WatchdogSpec): boolean {
	return runtime.overrides.get(spec.filePath) ?? spec.enabled;
}

/** Re-read every watchdog file and rebuild the active set, keeping state of watchdogs that stay active. */
function refresh(runtime: Runtime, warn: boolean): void {
	const specs: WatchdogSpec[] = [];
	for (const file of discoverWatchdogFiles(runtime.cwd())) {
		const parsed = parseWatchdogFile(file);
		if (parsed.kind === "ok") specs.push(parsed.spec);
		else if (warn) runtime.pi.logger?.warn?.(`watchdog "${file}": ${parsed.reason}`);
	}
	runtime.roster = specs;
	const next = new Map<string, WatchdogState>();
	// Only a new state is rebuilt from the branch: an existing one carries its own cursor, so a
	// later turn reads no branch entries at all. Directories are enumerated on every call.
	let branch: ReadonlyArray<unknown> | undefined;
	let cursors: Map<string, number> | undefined;
	let notes: Map<string, readonly string[]> | undefined;
	for (const spec of specs) {
		if (!targetsHere(runtime, spec) || !effectiveEnabled(runtime, spec)) continue;
		const prev = runtime.states.get(spec.filePath);
		if (prev) {
			// A retained `full` rendering is only valid for the scope that built it.
			if (prev.spec.scope !== spec.scope) prev.full = null;
			prev.spec = spec;
			next.set(spec.filePath, prev);
			continue;
		}
		branch ??= runtime.branchOf();
		cursors ??= cursorsFromBranch(branch);
		notes ??= noteIndexOf(runtime, branch);
		const cursor = cursors.get(spec.filePath) ?? 0;
		next.set(spec.filePath, {
			spec,
			pending: actionsAfter(branch, cursor, spec.filter),
			cursor,
			run: { kind: "idle" },
			sent: deliveredSinceCompaction(branch, spec.filePath, notes),
			full: null,
		});
	}
	runtime.states = next;
}

function logActive(runtime: Runtime): void {
	if (!runtime.identity) return;
	const who = runtime.identity.kind === "main" ? "main" : `subagent "${runtime.identity.name}"`;
	const active = [...runtime.states.values()].map(
		(s) => `${s.spec.name}(every=${s.spec.every}, scope=${s.spec.scope}, inject=${s.spec.inject})`,
	);
	runtime.pi.logger?.info?.(
		`watchdog: ${active.length} watchdog(s) active for ${who}${active.length > 0 ? ` — ${active.join(", ")}` : ""}`,
	);
}

/** Session boundary: identity, overrides and the active set are rebuilt; state is restored from the branch. */
function load(runtime: Runtime, ctx: ExtensionContext): void {
	runtime.closed = false;
	runtime.identity = ctx.agent;
	runtime.cwd = () => ctx.sessionManager.getCwd();
	runtime.branchOf = () => ctx.sessionManager.getBranch();
	runtime.overrides = overridesFromBranch(runtime.branchOf());
	runtime.notes = { count: 0, anchor: undefined, index: new Map() };
	runtime.states = new Map();
	runtime.nextTurnQueue = [];
	runtime.userTurnArmed = false;
	refresh(runtime, true);
	logActive(runtime);
}

/**
 * Send notes of one inject form as one message. `system`: a `watchdog` custom message (LLM
 * `developer` role) that starts a turn when the session is idle. `user`: an agent-attributed
 * user message, indexed first so the watchdog can recognise it on the branch.
 */
function send(runtime: Runtime, inject: InjectMode, notes: readonly QueuedNote[], deliverAs: Exclude<DeliverAs, "nextTurn">): void {
	const text = notes.map((note) => note.text).join("\n\n");
	const filePaths = notes.map((note) => note.filePath);
	switch (inject) {
		case "system":
			runtime.pi.sendMessage(
				{ customType: NOTE_CUSTOM_TYPE, content: text, display: true, attribution: "agent", details: { filePaths } },
				{ deliverAs, triggerTurn: true },
			);
			return;
		case "user":
			runtime.pi.appendEntry<UserNoteEntry>(USER_NOTE_ENTRY_TYPE, { filePaths, text: text.trim() });
			runtime.pi.sendUserMessage(text, { deliverAs, attribution: "agent" });
			return;
		default: {
			const unreachable: never = inject;
			throw new Error(`unknown inject mode ${String(unreachable)}`);
		}
	}
}

/** A finding in its inject form: tagged for `system`; for `user` the reviewer already wrote it in the user's voice. */
function noteText(spec: WatchdogSpec, severity: string, note: string): string {
	switch (spec.inject) {
		case "system":
			return `<watchdog name="${escapeAttr(spec.name)}" severity="${escapeAttr(severity)}">\n${note}\n</watchdog>`;
		case "user":
			return note.trim();
		default: {
			const unreachable: never = spec.inject;
			return unreachable;
		}
	}
}

function deliver(runtime: Runtime, state: WatchdogState, verdict: Verdict): void {
	if (verdict.kind !== "advice") return;
	const spec = state.spec;
	if (verdict.note.trim() === "" || state.sent >= spec.maxPerContext) return;
	const note: QueuedNote = { filePath: spec.filePath, inject: spec.inject, text: noteText(spec, verdict.severity, verdict.note) };
	if (verdict.delivery === "nextTurn") runtime.nextTurnQueue.push(note);
	else send(runtime, spec.inject, [note], verdict.delivery);
	state.sent += 1;
	runtime.pi.logger?.info?.(
		`watchdog "${spec.name}": ${verdict.severity} → ${verdict.delivery === "nextTurn" ? "queued for next turn" : "delivered"} as ${spec.inject} (${state.sent}/${Number.isFinite(spec.maxPerContext) ? spec.maxPerContext : "∞"})`,
	);
}

/** Advance and persist the window cursor once a review covering up to `reviewed` reached a verdict. */
function advanceCursor(runtime: Runtime, state: WatchdogState, reviewed: number): void {
	if (reviewed <= state.cursor) return;
	state.cursor = reviewed;
	runtime.pi.appendEntry<CursorEntry>(CURSOR_ENTRY_TYPE, { filePath: state.spec.filePath, cursor: reviewed });
}
/** Abort every in-flight review and return their settling promises for the caller to await or drop. */
function abortReviews(runtime: Runtime): Promise<void>[] {
	const done: Promise<void>[] = [];
	for (const state of runtime.states.values()) {
		if (state.run.kind !== "running") continue;
		state.run.controller.abort();
		done.push(state.run.done);
	}
	return done;
}

/** Two rendered pieces as one transcript, joined as `renderTranscript` joins its parts. */
function joinText(head: string, tail: string): string {
	if (head === "") return tail;
	if (tail === "") return head;
	return `${head}\n${tail}`;
}

/**
 * The transcript one review covers, and the timestamp its cursor advances to. `window` renders
 * only messages stamped after the cursor; `full` appends to the rendering retained from earlier
 * reviews, so a review re-renders just the branch's new tail.
 */
function reviewTranscript(
	runtime: Runtime,
	state: WatchdogState,
	branch: ReadonlyArray<unknown>,
	tail: unknown,
): { readonly transcript: string; readonly reviewed: number } {
	const spec = state.spec;
	const retained = state.full;
	const selection = selectMessages(branch, spec.scope, state.cursor, tail, retained === null ? 0 : retained.count);
	const ownNotes = noteIndexOf(runtime, branch);
	const added = renderTranscript(selection.messages, ownNotes);
	let transcript = added;
	if (spec.scope === "full") {
		// A shorter branch (a move the session did not announce) drops the retained rendering.
		const prefix = retained === null || selection.branchCount < retained.count ? "" : retained.text;
		state.full = { text: joinText(prefix, added), count: selection.branchCount };
		transcript = state.full.text;
	}
	return { transcript: joinText(transcript, renderTranscript([], ownNotes, selection.tail)), reviewed: selection.reviewed };
}

/** Start one review now; never awaited by the caller, so the watched agent keeps running. */
function start(runtime: Runtime, state: WatchdogState, ctx: ExtensionContext, tail: unknown): void {
	if (runtime.closed) return;
	const spec = state.spec;
	state.pending = 0;
	if (state.sent >= spec.maxPerContext) return;
	const { transcript, reviewed } = reviewTranscript(runtime, state, ctx.sessionManager.getBranch(), tail);
	if (!/\S/.test(transcript)) {
		advanceCursor(runtime, state, reviewed);
		return;
	}
	const controller = new AbortController();
	const review =
		spec.kind === "jev"
			? runJev(runtime.pi, ctx, spec, transcript, controller.signal)
			: runReviewer(runtime.pi, ctx, spec, transcript, controller.signal);
	// A session boundary, branch move or switch-off removed this state; its finding is stale.
	const live = (): boolean => runtime.states.get(spec.filePath) === state;
	const done = review
		.then(
			(verdict) => {
				// No verdict = failed review: the cursor stays, so the next run covers this range again.
				if (!live() || verdict === null) return;
				advanceCursor(runtime, state, reviewed);
				deliver(runtime, state, verdict);
			},
			(error) => runtime.pi.logger.warn("watchdog review failed", { error: errorText(error) }),
		)
		.finally(() => {
			if (!live()) return;
			const flush = state.run.kind === "running" && state.run.flushAfter;
			state.run = { kind: "idle" };
			if (state.pending >= state.spec.every || (flush && state.pending > 0)) start(runtime, state, ctx, undefined);
		})
		.catch((error) => runtime.pi.logger.warn("watchdog review delivery failed", { error: errorText(error) }));
	// run is registered last so `done` settles the chain the state itself carries.
	state.run = { kind: "running", flushAfter: false, controller, done };
}

/** One line per watchdog file for `/watchdog list`. */
function describe(runtime: Runtime, spec: WatchdogSpec): string {
	const override = runtime.overrides.get(spec.filePath);
	const state = !targetsHere(runtime, spec)
		? tr("not for this session", "不适用于本会话")
		: effectiveEnabled(runtime, spec)
			? tr("ON", "开启")
			: tr("OFF", "关闭");
	const session = override === undefined ? "—" : override ? tr("on", "开启") : tr("off", "关闭");
	const backend = spec.kind === "jev" ? "JUDGE" : `${tr("chat", "聊天")} ${spec.model ?? "@advisor"}`;
	return `${spec.name}: ${state} · ${tr("global", "全局")} ${spec.enabled ? tr("on", "开启") : tr("off", "关闭")} · ${tr("session", "会话")} ${session} · ${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, tr("any", "不限"))} · inject ${spec.inject} · ${tr("every", "每")} ${spec.every} · ${tr("scope", "范围")} ${spec.scope === "full" ? tr("full", "全部") : tr("window", "窗口")} · ${backend}\n  ${spec.filePath}`;
}
/** Model-facing watchdog description kept in English for tool-result content. */
function describeForToolResult(runtime: Runtime, spec: WatchdogSpec): string {
	const override = runtime.overrides.get(spec.filePath);
	const state = !targetsHere(runtime, spec) ? "not for this session" : effectiveEnabled(runtime, spec) ? "ON" : "OFF";
	const session = override === undefined ? "—" : override ? "on" : "off";
	const backend = spec.kind === "jev" ? "JUDGE" : `chat ${spec.model ?? "@advisor"}`;
	return `${spec.name}: ${state} · global ${spec.enabled ? "on" : "off"} · session ${session} · ${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, "any")} · inject ${spec.inject} · every ${spec.every} · scope ${spec.scope} · ${backend}\n  ${spec.filePath}`;
}

/** Status line a `write`/`edit` result carries for a watchdog file it touched. */
function fileStatus(runtime: Runtime, path: string): string {
	if (!existsSync(path)) return `watchdog file ${path}: removed; no watchdog loads from it.`;
	const parsed = parseWatchdogFile(path);
	if (parsed.kind === "invalid") return `watchdog file ${path}: NOT recognised (${parsed.reason}); it is ignored until fixed.`;
	if (!runtime.roster.some((spec) => spec.filePath === path)) {
		return `watchdog file ${path}: valid but not searched from ${runtime.cwd()}; watchdogs load from ${import.meta.dir} and from <dir>/ or <dir>/.omp/ for each dir between ${runtime.cwd()} and its git root.`;
	}
	const spec = parsed.spec;
	const active = !targetsHere(runtime, spec)
		? "not active in this session (its target or cwd restriction excludes it)"
		: effectiveEnabled(runtime, spec)
			? "active in this session now"
			: "switched off in this session";
	return `watchdog file ${path}: recognised, ${active}.\n${describeForToolResult(runtime, spec)}`;
}

/** The one discovered watchdog with this name (case-insensitive), or the error to show. */
function findByName(
	runtime: Runtime,
	name: string,
): { readonly kind: "found"; readonly spec: WatchdogSpec } | { readonly kind: "error"; readonly text: string } {
	const matches = runtime.roster.filter((spec) => spec.name.toLowerCase() === name.toLowerCase());
	if (matches.length === 0)
		return {
			kind: "error",
			text: tr(`watchdog "${name}" not found (see /watchdog list)`, `未找到 watchdog“${name}”（参见 /watchdog list）`),
		};
	if (matches.length > 1) {
		return {
			kind: "error",
			text: tr(
				`watchdog name "${name}" is ambiguous; give each file a unique \`name:\`:\n${matches.map((s) => `  ${s.filePath}`).join("\n")}`,
				`watchdog 名称“${name}”有歧义；请为每个文件指定唯一的 \`name:\`：\n${matches.map((s) => `  ${s.filePath}`).join("\n")}`,
			),
		};
	}
	const spec = matches[0];
	if (!spec)
		return {
			kind: "error",
			text: tr(`watchdog "${name}" not found (see /watchdog list)`, `未找到 watchdog“${name}”（参见 /watchdog list）`),
		};
	return { kind: "found", spec };
}

/**
 * Split `/watchdog edit` arguments into the longest discovered name they start with and the
 * requested change (null when none follows). Null when no name matches.
 */
function splitEditTarget(runtime: Runtime, rest: string): { readonly name: string; readonly change: string | null } | null {
	const lower = rest.toLowerCase();
	let best = "";
	for (const spec of runtime.roster) {
		const name = spec.name.toLowerCase();
		if (name.length <= best.length || !lower.startsWith(name)) continue;
		if (lower.length === name.length || /\s/.test(lower[name.length] ?? "")) best = name;
	}
	if (best === "") return null;
	const change = rest.slice(best.length).trim();
	return { name: rest.slice(0, best.length), change: change === "" ? null : change };
}

/** The model prompt for `/watchdog add|edit`, or the error to show instead. */
function draftPrompt(
	runtime: Runtime,
	command: Extract<WatchdogCommand, { kind: "add" | "edit" }>,
	ctx: ExtensionContext,
): { readonly kind: "prompt"; readonly text: string } | { readonly kind: "error"; readonly text: string } {
	refresh(runtime, false);
	const model = defaultReviewerModel(ctx);
	const draft: DraftContext = {
		projectDir: join(projectRoot(runtime.cwd()), ".omp"),
		globalDir: import.meta.dir,
		existing: runtime.roster,
		defaultModel: model ? `${model.provider}/${model.id}` : null,
	};
	switch (command.kind) {
		case "add":
			return { kind: "prompt", text: buildAddPrompt(command.requirement, draft) };
		case "edit": {
			const target = splitEditTarget(runtime, command.rest);
			if (target === null)
				return {
					kind: "error",
					text: tr(
						`no watchdog named at the start of "${command.rest}" (see /watchdog list)`,
						`在“${command.rest}”开头没有 watchdog 名称（参见 /watchdog list）`,
					),
				};
			const found = findByName(runtime, target.name);
			if (found.kind === "error") return found;
			let current: string;
			try {
				current = readFileSync(found.spec.filePath, "utf8");
			} catch (error) {
				return {
					kind: "error",
					text: tr(`cannot read ${found.spec.filePath}: ${errorText(error)}`, `无法读取 ${found.spec.filePath}：${errorText(error)}`),
				};
			}
			return { kind: "prompt", text: buildEditPrompt(found.spec, current, target.change, draft) };
		}
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

/** `/watchdog rm`: delete the file after the user confirms, and drop this session's override of it. */
async function remove(
	runtime: Runtime,
	name: string,
	ctx: ExtensionContext,
): Promise<{ readonly level: "info" | "error"; readonly text: string }> {
	refresh(runtime, false);
	const found = findByName(runtime, name);
	if (found.kind === "error") return { level: "error", text: found.text };
	const spec = found.spec;
	const confirmed = await ctx.ui.confirm(
		tr(`Delete watchdog "${spec.name}"?`, `删除 watchdog“${spec.name}”？`),
		`${describe(runtime, spec)}\n\n${tr("The file is deleted from disk.", "文件将从磁盘删除。")}`,
	);
	if (!confirmed) return { level: "info", text: tr(`watchdog "${spec.name}" kept`, `已保留 watchdog“${spec.name}”`) };
	try {
		unlinkSync(spec.filePath);
	} catch (error) {
		return {
			level: "error",
			text: tr(`cannot delete ${spec.filePath}: ${errorText(error)}`, `无法删除 ${spec.filePath}：${errorText(error)}`),
		};
	}
	if (runtime.overrides.delete(spec.filePath))
		runtime.pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled: null });
	refresh(runtime, false);
	return {
		level: "info",
		text: tr(`watchdog "${spec.name}" deleted (${spec.filePath})`, `已删除 watchdog“${spec.name}”（${spec.filePath}）`),
	};
}

function toggle(
	runtime: Runtime,
	command: Extract<WatchdogCommand, { kind: "toggle" }>,
): { readonly level: "info" | "error"; readonly text: string } {
	const found = findByName(runtime, command.name);
	if (found.kind === "error") return { level: "error", text: found.text };
	const spec = found.spec;
	const enabled = command.toggle === "on";
	const toggleWord = command.toggle === "on" ? tr("on", "开启") : tr("off", "关闭");
	switch (command.scope) {
		case "session": {
			if (!targetsHere(runtime, spec)) {
				return {
					level: "error",
					text: tr(
						`watchdog "${spec.name}" does not target this session (${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, "any")}); use \`global\``,
						`watchdog“${spec.name}”未将本会话作为目标（${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, "不限")}）；请使用 \`global\``,
					),
				};
			}
			runtime.overrides.set(spec.filePath, enabled);
			runtime.pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled });
			refresh(runtime, false);
			return {
				level: "info",
				text: tr(`watchdog "${spec.name}" ${command.toggle} for this session`, `watchdog“${spec.name}”已在本会话${toggleWord}`),
			};
		}
		case "global": {
			let raw: string;
			try {
				raw = readFileSync(spec.filePath, "utf8");
			} catch (error) {
				return {
					level: "error",
					text: tr(`cannot read ${spec.filePath}: ${errorText(error)}`, `无法读取 ${spec.filePath}：${errorText(error)}`),
				};
			}
			const updated = setFrontmatterEnabled(raw, enabled);
			if (updated === null) return { level: "error", text: tr(`${spec.filePath} has no frontmatter`, `${spec.filePath} 没有 frontmatter`) };
			try {
				if (updated !== raw) writeFileSync(spec.filePath, updated);
			} catch (error) {
				return {
					level: "error",
					text: tr(`cannot write ${spec.filePath}: ${errorText(error)}`, `无法写入 ${spec.filePath}：${errorText(error)}`),
				};
			}
			// The file is now the switch; a session override would keep shadowing it here.
			if (runtime.overrides.delete(spec.filePath))
				runtime.pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled: null });
			refresh(runtime, false);
			return {
				level: "info",
				text: tr(
					`watchdog "${spec.name}" ${command.toggle} globally (${spec.filePath})`,
					`watchdog“${spec.name}”已全局${toggleWord}（${spec.filePath}）`,
				),
			};
		}
		default: {
			const unreachable: never = command.scope;
			return unreachable;
		}
	}
}

function registerCommand(runtime: Runtime): void {
	runtime.pi.registerCommand("watchdog", {
		description: tr(
			"List, add, edit, remove or switch watchdogs: /watchdog [list] | add <requirement> | edit <name> [change] | rm <name> | on|off <name> [session|global]",
			"列出、添加、编辑、删除或切换 watchdog：/watchdog [list] | add <requirement> | edit <name> [change] | rm <name> | on|off <name> [session|global]",
		),
		getArgumentCompletions: (prefix) => {
			try {
				refresh(runtime, false);
				const lower = prefix.toLowerCase();
				if (!/\s/.test(prefix)) {
					const subs = [
						{
							value: "list",
							label: tr("list", "列表"),
							description: tr("all watchdog files and their state", "所有 watchdog 文件及其状态"),
						},
						{ value: "on ", label: tr("on", "开启"), description: tr("switch a watchdog on", "开启 watchdog") },
						{ value: "off ", label: tr("off", "关闭"), description: tr("switch a watchdog off", "关闭 watchdog") },
						{
							value: "add ",
							label: tr("add", "添加"),
							description: tr("draft a new watchdog with the model from a requirement", "根据需求让模型起草新的 watchdog"),
						},
						{ value: "edit ", label: tr("edit", "编辑"), description: tr("revise a watchdog with the model", "让模型修改 watchdog") },
						{
							value: "rm ",
							label: tr("rm", "删除"),
							description: tr("delete a watchdog file (asks first)", "删除 watchdog 文件（先询问）"),
						},
					];
					return subs.filter((s) => s.value.startsWith(lower));
				}
				const sub = lower.split(/\s+/)[0];
				const items: { value: string; label: string; description: string }[] = [];
				const names = new Set<string>();
				for (const spec of runtime.roster) {
					if (names.has(spec.name.toLowerCase())) continue;
					names.add(spec.name.toLowerCase());
					switch (sub) {
						case "on":
						case "off": {
							const scopes: ToggleScope[] = targetsHere(runtime, spec) ? ["session", "global"] : ["global"];
							for (const scope of scopes) {
								const value = `${sub} ${spec.name} ${scope}`;
								if (!value.toLowerCase().startsWith(lower)) continue;
								const now = !targetsHere(runtime, spec)
									? tr("not for this session", "不适用于本会话")
									: effectiveEnabled(runtime, spec)
										? tr("now ON", "当前开启")
										: tr("now OFF", "当前关闭");
								const where =
									scope === "session"
										? tr("this session only", "仅本会话")
										: tr(`writes enabled: ${sub === "on"} to the file`, `向文件写入 enabled: ${sub === "on"}`);
								items.push({
									value,
									label: `${spec.name} ${scope === "session" ? tr("session", "会话") : tr("global", "全局")}`,
									description: `${where} · ${now}`,
								});
							}
							break;
						}
						case "edit":
						case "rm": {
							const value = sub === "edit" ? `edit ${spec.name} ` : `rm ${spec.name}`;
							if (value.toLowerCase().startsWith(lower)) items.push({ value, label: spec.name, description: spec.filePath });
							break;
						}
						default:
							return null;
					}
				}
				return items;
			} catch (error) {
				runtime.pi.logger.warn("watchdog completions failed", { error: errorText(error) });
				return null;
			}
		},
		handler: async (args, ctx) => {
			try {
				if (runtime.identity === null) load(runtime, ctx);
				const command = parseWatchdogCommand(args);
				switch (command.kind) {
					case "list": {
						refresh(runtime, false);
						ctx.ui.notify(
							runtime.roster.length === 0
								? tr("no WATCHDOG-*.md files found", "未找到 WATCHDOG-*.md 文件")
								: runtime.roster.map((spec) => describe(runtime, spec)).join("\n"),
							"info",
						);
						return;
					}
					case "invalid":
						ctx.ui.notify(command.reason, "error");
						return;
					case "toggle": {
						const result = toggle(runtime, command);
						runtime.pi.logger?.info?.(`watchdog command: ${result.text}`);
						logActive(runtime);
						ctx.ui.notify(result.text, result.level);
						return;
					}
					case "add":
					case "edit": {
						const prompt = draftPrompt(runtime, command, ctx);
						if (prompt.kind === "error") {
							ctx.ui.notify(prompt.text, "error");
							return;
						}
						// Extension-authored like every injected message here, so user-prompt-inject never mistakes it for the user's words.
						runtime.pi.sendUserMessage(
							prompt.text,
							ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" },
						);
						return;
					}
					case "rm": {
						const result = await remove(runtime, command.name, ctx);
						runtime.pi.logger?.info?.(`watchdog command: ${result.text}`);
						logActive(runtime);
						ctx.ui.notify(result.text, result.level);
						return;
					}
					default: {
						const unreachable: never = command;
						return unreachable;
					}
				}
			} catch (error) {
				runtime.pi.logger.warn("watchdog command failed", { error: errorText(error) });
			}
		},
	});
}
function registerEvents(runtime: Runtime): void {
	runtime.pi.on("session_start", (_event, ctx) => {
		try {
			load(runtime, ctx);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_start"} handler failed`, { error: errorText(error) });
		}
	});
	runtime.pi.on("session_switch", (_event, ctx) => {
		try {
			// Abort before load: load replaces the states map, so the old handles are unreachable after it.
			abortReviews(runtime);
			load(runtime, ctx);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_switch"} handler failed`, { error: errorText(error) });
		}
	});
	// Shutdown ends the session: abort every in-flight review (no more verdicts, no more helper
	// model calls) and close the runtime so no review starts for a session that is gone.
	runtime.pi.on("session_shutdown", async () => {
		try {
			runtime.closed = true;
			const settling = abortReviews(runtime);
			runtime.states = new Map();
			runtime.nextTurnQueue = [];
			runtime.userTurnArmed = false;
			// The aborted reviews are this session's inner work: they finish (helper disposed,
			// judgment returned) before the session's own teardown proceeds.
			await Promise.allSettled(settling);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_shutdown"} handler failed`, { error: errorText(error) });
		}
	});
	// Branch and tree moves swap the working transcript: overrides, cursors and cap counts are
	// re-read from the new branch, and findings in flight about the old one are dropped.
	runtime.pi.on("session_branch", (_event, ctx) => {
		try {
			load(runtime, ctx);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_branch"} handler failed`, { error: errorText(error) });
		}
	});
	runtime.pi.on("session_tree", (_event, ctx) => {
		try {
			load(runtime, ctx);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_tree"} handler failed`, { error: errorText(error) });
		}
	});

	// A write or edit of a WATCHDOG-*.md (the last step of `/watchdog add`, or any hand edit) is
	// picked up at once, and the tool result tells the model whether the file is recognised.
	runtime.pi.on("tool_result", (event) => {
		try {
			if (event.isError) return;
			const files = touchedWatchdogFiles(event.toolName, event.input, runtime.cwd());
			if (files.length === 0) return;
			refresh(runtime, true);
			logActive(runtime);
			return { content: [...event.content, { type: "text", text: files.map((file) => fileStatus(runtime, file)).join("\n") }] };
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"tool_result"} handler failed`, { error: errorText(error) });
		}
	});

	// Compaction starts a new context on the same transcript: only the per-context budget
	// (`maxPerContext` count) resets. Accumulated actions, the `window` cursor and
	// in-flight reviews carry over.
	runtime.pi.on("session_compact", () => {
		try {
			for (const state of runtime.states.values()) {
				state.sent = 0;
			}
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"session_compact"} handler failed`, { error: errorText(error) });
		}
	});

	// `nextTurn` findings wait for a real user prompt: interactive or RPC input that is not a
	// slash command arms the turn it starts. A subagent has no user, so its next turn delivers.
	runtime.pi.on("input", (event) => {
		try {
			if (event.source !== "extension" && !event.text.trimStart().startsWith("/")) runtime.userTurnArmed = true;
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"input"} handler failed`, { error: errorText(error) });
		}
	});
	// A queued `nextTurn` note reaches the turn the prompt starts from its first model call: a
	// `system` note as the returned custom message, a `user` note as a steer queued while the
	// prompt is being prepared (the session already counts as streaming here).
	runtime.pi.on("before_agent_start", () => {
		try {
			if (runtime.closed) return;
			refresh(runtime, false);
			const armed = runtime.userTurnArmed;
			runtime.userTurnArmed = false;
			if (runtime.nextTurnQueue.length === 0 || (runtime.identity?.kind === "main" && !armed)) return;
			const queued = runtime.nextTurnQueue;
			runtime.nextTurnQueue = [];
			const userNotes = queued.filter((note) => note.inject === "user");
			if (userNotes.length > 0) send(runtime, "user", userNotes, "steer");
			const systemNotes = queued.filter((note) => note.inject === "system");
			if (systemNotes.length === 0) return;
			return {
				message: {
					customType: NOTE_CUSTOM_TYPE,
					content: systemNotes.map((note) => note.text).join("\n\n"),
					display: true,
					attribution: "agent",
					details: { filePaths: systemNotes.map((note) => note.filePath) },
				},
			};
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"before_agent_start"} handler failed`, { error: errorText(error) });
		}
	});

	runtime.pi.on("message_end", (event, ctx) => {
		try {
			if (runtime.closed) return;
			// Registration can precede the first session boundary; initialize lazily.
			if (runtime.identity === null) load(runtime, ctx);
			// One count per message, shared by every watchdog; only the filter test is per watchdog.
			const actions = countActions(event.message);
			if (actions === 0) return;
			const producer = producerOf(event.message);
			if (producer === null) return;
			for (const state of runtime.states.values()) {
				if (!producerMatches(state.spec.filter, producer)) continue;
				state.pending += actions;
				if (state.run.kind === "idle" && state.pending >= state.spec.every) start(runtime, state, ctx, event.message);
			}
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"message_end"} handler failed`, { error: errorText(error) });
		}
	});

	runtime.pi.on("agent_end", (event, ctx) => {
		try {
			if (runtime.closed) return;
			if (runtime.identity === null) load(runtime, ctx);
			// A continuation the session schedules itself (reminder, retry, compaction) is not a settled run;
			// a wait on background jobs hands control back, so pending reviews start here too.
			if (event.willContinue === true && event.awaitingAsyncWork !== true) return;
			for (const state of runtime.states.values()) {
				if (state.pending === 0) continue;
				if (state.run.kind === "idle") start(runtime, state, ctx, undefined);
				else state.run = { kind: "running", flushAfter: true, controller: state.run.controller, done: state.run.done };
			}
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${"agent_end"} handler failed`, { error: errorText(error) });
		}
	});
}
