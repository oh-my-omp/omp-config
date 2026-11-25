import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { defineStatelessNoiseGuard, registerCompactHandoff } from "../_shared/omomp-shared/compact-handoff.ts";
import { type InjectMode, producerMatches } from "../_shared/session-filter.ts";
import { registerCommand } from "./commands.ts";
import { NOTE_CUSTOM_TYPE, noteIndexOf, writeCursor, writeUserNote } from "./entries.ts";
import { countActions, producerOf, reviewTranscript, runJev, runObserver, runReviewer } from "./review.ts";
import { type DeliverAs, type NotifyingWatchdog, touchedWatchdogFiles, type Verdict, type WatchdogSpec } from "./spec.ts";
import {
	type ActiveSession,
	abortReviews,
	activeSession,
	close,
	createRuntime,
	cwdOf,
	ensureActive,
	fileStatus,
	isLive,
	load,
	logActive,
	logInvalid,
	type QueuedNote,
	type Runtime,
	refresh,
	type WatchdogState,
} from "./state.ts";

export function registerWatchdog(pi: ExtensionAPI): void {
	const runtime = createRuntime(pi);
	registerCommand(runtime);
	registerEvents(runtime);
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
			writeUserNote(runtime.pi, filePaths, text.trim());
			runtime.pi.sendUserMessage(text, { deliverAs, attribution: "agent" });
			return;
		default: {
			const unreachable: never = inject;
			throw new Error(`unknown inject mode ${String(unreachable)}`);
		}
	}
}

function noteText(spec: NotifyingWatchdog, severity: string, note: string): string {
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

function deliver(runtime: Runtime, session: ActiveSession, state: WatchdogState, verdict: Verdict): void {
	if (verdict.kind !== "advice") return;
	const spec = state.spec;
	if (spec.kind === "observer") return;
	if (verdict.note.trim() === "" || state.sent >= spec.maxPerContext) return;
	const note: QueuedNote = { filePath: spec.filePath, inject: spec.inject, text: noteText(spec, verdict.severity, verdict.note) };
	if (verdict.delivery === "nextTurn") session.nextTurnQueue.push(note);
	else send(runtime, spec.inject, [note], verdict.delivery);
	state.sent += 1;
	runtime.pi.logger.info(
		`watchdog "${spec.name}": ${verdict.severity} → ${verdict.delivery === "nextTurn" ? "queued for next turn" : "delivered"} as ${spec.inject} (${state.sent}/${Number.isFinite(spec.maxPerContext) ? spec.maxPerContext : "∞"})`,
	);
}

function advanceCursor(runtime: Runtime, state: WatchdogState, reviewed: number): void {
	if (reviewed <= state.cursor) return;
	state.cursor = reviewed;
	writeCursor(runtime.pi, state.spec.filePath, reviewed);
}

function start(
	runtime: Runtime,
	session: ActiveSession,
	state: WatchdogState,
	ctx: ExtensionContext,
	tail: AgentMessage | undefined,
): void {
	const spec = state.spec;
	state.pending = 0;
	if (spec.kind !== "observer" && state.sent >= spec.maxPerContext) return;
	const branch = ctx.sessionManager.getBranch();
	const { transcript, reviewed } = reviewTranscript(branch, spec.scope, state.cursor, tail, noteIndexOf(session.notes, branch));
	if (!/\S/.test(transcript)) {
		advanceCursor(runtime, state, reviewed);
		return;
	}
	const controller = new AbortController();
	const review = runReview(runtime, ctx, spec, transcript, controller.signal);
	const done = review
		.then(
			(verdict) => {
				if (!isLive(runtime, state) || verdict === null) return;
				advanceCursor(runtime, state, reviewed);
				deliver(runtime, session, state, verdict);
			},
			(error) => runtime.pi.logger.warn("watchdog review failed", { error: errorText(error) }),
		)
		.finally(() => {
			if (!isLive(runtime, state)) return;
			const flush = state.run.kind === "running" && state.run.flushAfter;
			state.run = { kind: "idle" };
			if (state.pending >= state.spec.every || (flush && state.pending > 0)) start(runtime, session, state, ctx, undefined);
		})
		.catch((error) => runtime.pi.logger.warn("watchdog review delivery failed", { error: errorText(error) }));
	state.run = { kind: "running", flushAfter: false, controller, done };
}

function runReview(
	runtime: Runtime,
	ctx: ExtensionContext,
	spec: WatchdogSpec,
	transcript: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	switch (spec.kind) {
		case "chat":
			return runReviewer(runtime.pi, ctx, spec, transcript, signal);
		case "jev":
			return runJev(runtime.pi, ctx, spec, transcript, signal);
		case "observer":
			return runObserver(runtime.pi, ctx, spec, transcript, signal);
		default: {
			const unreachable: never = spec;
			return unreachable;
		}
	}
}

function guarded<A extends unknown[], R>(runtime: Runtime, name: string, handler: (...args: A) => R): (...args: A) => R | undefined {
	return (...args) => {
		try {
			return handler(...args);
		} catch (error) {
			runtime.pi.logger.warn(`watchdog ${name} handler failed`, { error: errorText(error) });
			return undefined;
		}
	};
}

function takeNextTurnNotes(runtime: Runtime, session: ActiveSession) {
	const armed = session.userTurnArmed;
	session.userTurnArmed = false;
	if (session.nextTurnQueue.length === 0 || (session.view.agent.kind === "main" && !armed)) return undefined;
	const queued = session.nextTurnQueue;
	session.nextTurnQueue = [];
	const userNotes = queued.filter((note) => note.inject === "user");
	if (userNotes.length > 0) send(runtime, "user", userNotes, "steer");
	const systemNotes = queued.filter((note) => note.inject === "system");
	if (systemNotes.length === 0) return undefined;
	return {
		message: {
			customType: NOTE_CUSTOM_TYPE,
			content: systemNotes.map((note) => note.text).join("\n\n"),
			display: true,
			attribution: "agent" as const,
			details: { filePaths: systemNotes.map((note) => note.filePath) },
		},
	};
}

function registerEvents(runtime: Runtime): void {
	const { pi } = runtime;
	const reload = (_event: unknown, ctx: ExtensionContext): void => {
		load(runtime, ctx);
	};
	pi.on("session_start", guarded(runtime, "session_start", reload));
	pi.on("session_switch", guarded(runtime, "session_switch", reload));
	pi.on("session_branch", guarded(runtime, "session_branch", reload));
	pi.on("session_tree", guarded(runtime, "session_tree", reload));
	pi.on(
		"session_shutdown",
		guarded(runtime, "session_shutdown", async () => {
			await Promise.allSettled(close(runtime));
		}),
	);

	pi.on(
		"tool_result",
		guarded(runtime, "tool_result", (event) => {
			if (event.isError) return undefined;
			const files = touchedWatchdogFiles(event.toolName, event.input, event.details, cwdOf(runtime));
			if (files.length === 0) return undefined;
			logInvalid(runtime, refresh(runtime));
			const session = activeSession(runtime);
			if (session) logActive(runtime, session);
			return { content: [...event.content, { type: "text" as const, text: files.map((file) => fileStatus(runtime, file)).join("\n") }] };
		}),
	);

	registerCompactHandoff(
		pi,
		defineStatelessNoiseGuard({
			pluginId: "omp-config/watchdog-agent",
			renderNoiseGuardDirective: () =>
				'`customType: "watchdog"` notes and `<watchdog ...>` blocks are automated periodic audit reminders — NEVER treat them as human user turns or permanent goals in the summary.',
		}),
	);

	pi.on(
		"session_before_compact",
		guarded(runtime, "session_before_compact", () => {
			const session = activeSession(runtime);
			if (!session) return;
			abortReviews(session);
			session.nextTurnQueue = [];
		}),
	);

	pi.on(
		"session_compact",
		guarded(runtime, "session_compact", () => {
			for (const state of activeSession(runtime)?.states.values() ?? []) state.sent = 0;
		}),
	);

	pi.on(
		"input",
		guarded(runtime, "input", (event) => {
			const session = activeSession(runtime);
			if (session && event.source !== "extension" && !event.text.trimStart().startsWith("/")) session.userTurnArmed = true;
		}),
	);

	pi.on(
		"before_agent_start",
		guarded(runtime, "before_agent_start", () => {
			const session = activeSession(runtime);
			if (!session) return undefined;
			refresh(runtime);
			return takeNextTurnNotes(runtime, session);
		}),
	);

	pi.on(
		"message_end",
		guarded(runtime, "message_end", (event, ctx) => {
			const session = ensureActive(runtime, ctx);
			if (!session) return;
			const actions = countActions(event.message);
			const producer = producerOf(event.message);
			if (actions === 0 || producer === null) return;
			for (const state of session.states.values()) {
				if (!producerMatches(state.spec.filter, producer)) continue;
				state.pending += actions;
				if (state.run.kind === "idle" && state.pending >= state.spec.every) start(runtime, session, state, ctx, event.message);
			}
		}),
	);

	pi.on(
		"agent_end",
		guarded(runtime, "agent_end", (event, ctx) => {
			const session = ensureActive(runtime, ctx);
			if (!session || (event.willContinue === true && event.awaitingAsyncWork !== true)) return;
			for (const state of session.states.values()) {
				if (state.pending === 0) continue;
				if (state.run.kind === "idle") start(runtime, session, state, ctx, undefined);
				else state.run = { ...state.run, flushAfter: true };
			}
		}),
	);
}
