import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { describeFilter, type InjectMode, producerMatches, type SessionFilter, targetsSession } from "../_shared/session-filter.ts";
import {
	cursorsFromBranch,
	deliveredSinceCompaction,
	emptyNoteIndex,
	type NoteIndex,
	noteIndexOf,
	overridesFromBranch,
	writeOverride,
} from "./entries.ts";
import { branchMessages, countActions, producerOf } from "./review.ts";
import { discoverWatchdogFiles, parseWatchdogFile, WATCHDOG_FILTER_KEYS, type WatchdogSpec } from "./spec.ts";

export type QueuedNote = { readonly filePath: string; readonly inject: InjectMode; readonly text: string };

export type RunState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly flushAfter: boolean; readonly controller: AbortController; readonly done: Promise<void> };

export type WatchdogState = {
	spec: WatchdogSpec;
	pending: number;
	cursor: number;
	run: RunState;
	sent: number;
};

export type ActiveSession = {
	readonly view: Pick<ExtensionContext, "agent" | "sessionManager">;
	readonly overrides: Map<string, boolean>;
	readonly notes: NoteIndex;
	states: Map<string, WatchdogState>;
	nextTurnQueue: QueuedNote[];
	userTurnArmed: boolean;
};

type Lifecycle = { readonly kind: "unloaded" } | { readonly kind: "active"; readonly session: ActiveSession } | { readonly kind: "closed" };

export type Runtime = {
	readonly pi: ExtensionAPI;
	lifecycle: Lifecycle;
	roster: readonly WatchdogSpec[];
};

export type Translate = (en: string, zh: string) => string;

export function createRuntime(pi: ExtensionAPI): Runtime {
	return { pi, lifecycle: { kind: "unloaded" }, roster: [] };
}

export function activeSession(runtime: Runtime): ActiveSession | null {
	return runtime.lifecycle.kind === "active" ? runtime.lifecycle.session : null;
}

export function cwdOf(runtime: Runtime): string {
	return activeSession(runtime)?.view.sessionManager.getCwd() ?? process.cwd();
}

export function abortReviews(session: ActiveSession): Promise<void>[] {
	const done: Promise<void>[] = [];
	for (const state of session.states.values()) {
		if (state.run.kind !== "running") continue;
		state.run.controller.abort();
		done.push(state.run.done);
	}
	return done;
}

export function load(runtime: Runtime, ctx: ExtensionContext): ActiveSession {
	const previous = activeSession(runtime);
	if (previous) abortReviews(previous);
	const session: ActiveSession = {
		view: { agent: ctx.agent, sessionManager: ctx.sessionManager },
		overrides: overridesFromBranch(ctx.sessionManager.getBranch()),
		notes: emptyNoteIndex(),
		states: new Map(),
		nextTurnQueue: [],
		userTurnArmed: false,
	};
	runtime.lifecycle = { kind: "active", session };
	logInvalid(runtime, refresh(runtime));
	logActive(runtime, session);
	return session;
}

export function ensureActive(runtime: Runtime, ctx: ExtensionContext): ActiveSession | null {
	switch (runtime.lifecycle.kind) {
		case "active":
			return runtime.lifecycle.session;
		case "unloaded":
			return load(runtime, ctx);
		case "closed":
			return null;
		default: {
			const unreachable: never = runtime.lifecycle;
			return unreachable;
		}
	}
}

export function close(runtime: Runtime): Promise<void>[] {
	const session = activeSession(runtime);
	runtime.lifecycle = { kind: "closed" };
	return session ? abortReviews(session) : [];
}

export function isLive(runtime: Runtime, state: WatchdogState): boolean {
	return activeSession(runtime)?.states.get(state.spec.filePath) === state;
}

export function targetsHere(runtime: Runtime, spec: WatchdogSpec): boolean {
	const session = activeSession(runtime);
	return session !== null && targetsSession(spec.filter, session.view.agent, cwdOf(runtime));
}

export function effectiveEnabled(runtime: Runtime, spec: WatchdogSpec): boolean {
	return activeSession(runtime)?.overrides.get(spec.filePath) ?? spec.enabled;
}

export function setOverride(runtime: Runtime, filePath: string, enabled: boolean | null): void {
	const overrides = activeSession(runtime)?.overrides;
	if (!overrides) return;
	if (enabled === null) {
		if (!overrides.delete(filePath)) return;
	} else overrides.set(filePath, enabled);
	writeOverride(runtime.pi, filePath, enabled);
}

function actionsAfter(entries: ReadonlyArray<SessionEntry>, cursor: number, filter: SessionFilter): number {
	let count = 0;
	for (const message of branchMessages(entries)) {
		if (message.timestamp <= cursor) continue;
		const producer = producerOf(message);
		if (producer !== null && producerMatches(filter, producer)) count += countActions(message);
	}
	return count;
}

type InvalidFile = { readonly file: string; readonly reason: string };

export function refresh(runtime: Runtime): readonly InvalidFile[] {
	const specs: WatchdogSpec[] = [];
	const invalid: InvalidFile[] = [];
	for (const file of discoverWatchdogFiles(cwdOf(runtime))) {
		const parsed = parseWatchdogFile(file);
		if (parsed.kind === "ok") specs.push(parsed.spec);
		else invalid.push({ file, reason: parsed.reason });
	}
	runtime.roster = specs;
	const session = activeSession(runtime);
	if (!session) return invalid;
	const next = new Map<string, WatchdogState>();
	let branch: ReadonlyArray<SessionEntry> | undefined;
	let cursors: Map<string, number> | undefined;
	for (const spec of specs) {
		if (!targetsHere(runtime, spec) || !effectiveEnabled(runtime, spec)) continue;
		const prev = session.states.get(spec.filePath);
		if (prev) {
			prev.spec = spec;
			next.set(spec.filePath, prev);
			continue;
		}
		branch ??= session.view.sessionManager.getBranch();
		cursors ??= cursorsFromBranch(branch);
		const cursor = cursors.get(spec.filePath) ?? 0;
		next.set(spec.filePath, {
			spec,
			pending: actionsAfter(branch, cursor, spec.filter),
			cursor,
			run: { kind: "idle" },
			sent: deliveredSinceCompaction(branch, spec.filePath, noteIndexOf(session.notes, branch)),
		});
	}
	session.states = next;
	return invalid;
}

export function logInvalid(runtime: Runtime, invalid: readonly InvalidFile[]): void {
	for (const { file, reason } of invalid) runtime.pi.logger.warn(`watchdog "${file}": ${reason}`);
}

export function logActive(runtime: Runtime, session: ActiveSession): void {
	const agent = session.view.agent;
	const who = agent.kind === "main" ? "main" : `subagent "${agent.name}"`;
	const active = [...session.states.values()].map(
		(s) => `${s.spec.name}(every=${s.spec.every}, scope=${s.spec.scope}, inject=${s.spec.inject})`,
	);
	runtime.pi.logger.info(`watchdog: ${active.length} watchdog(s) active for ${who}${active.length > 0 ? ` — ${active.join(", ")}` : ""}`);
}

export function describe(runtime: Runtime, spec: WatchdogSpec, t: Translate): string {
	const override = activeSession(runtime)?.overrides.get(spec.filePath);
	const onOff = (value: boolean): string => (value ? t("on", "开启") : t("off", "关闭"));
	const state = !targetsHere(runtime, spec)
		? t("not for this session", "不适用于本会话")
		: effectiveEnabled(runtime, spec)
			? t("ON", "开启")
			: t("OFF", "关闭");
	const backend = spec.kind === "jev" ? "JUDGE" : `${t("chat", "聊天")} ${spec.model ?? "@advisor"}`;
	const scope = spec.scope === "full" ? t("full", "全部") : t("window", "窗口");
	return `${spec.name}: ${state} · ${t("global", "全局")} ${onOff(spec.enabled)} · ${t("session", "会话")} ${override === undefined ? "—" : onOff(override)} · ${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, t("any", "不限"))} · inject ${spec.inject} · ${t("every", "每")} ${spec.every} · ${t("scope", "范围")} ${scope} · ${backend}\n  ${spec.filePath}`;
}

const english: Translate = (en) => en;

export function fileStatus(runtime: Runtime, path: string): string {
	if (!existsSync(path)) return `watchdog file ${path}: removed; no watchdog loads from it.`;
	const parsed = parseWatchdogFile(path);
	if (parsed.kind === "invalid") return `watchdog file ${path}: NOT recognised (${parsed.reason}); it is ignored until fixed.`;
	const cwd = cwdOf(runtime);
	if (!runtime.roster.some((spec) => spec.filePath === path)) {
		return `watchdog file ${path}: valid but not searched from ${cwd}; watchdogs load from ${import.meta.dir} and from <dir>/ or <dir>/.omp/ for each dir between ${cwd} and its git root.`;
	}
	const spec = parsed.spec;
	const active = !targetsHere(runtime, spec)
		? "not active in this session (its target or cwd restriction excludes it)"
		: effectiveEnabled(runtime, spec)
			? "active in this session now"
			: "switched off in this session";
	return `watchdog file ${path}: recognised, ${active}.\n${describe(runtime, spec, english)}`;
}
