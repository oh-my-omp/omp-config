// ============================================================================
// wt / wt_remove — let the main agent move its session into a new worktree
// and back out of it, which OMP only lets the human do.
//
// `wt` runs the human's `/wt` itself, not a copy: the request is handed to
// `executeBuiltinSlashCommand("/wt [<branch>]", { ctx: <live InteractiveMode> })`,
// the dispatcher the TUI editor submit uses. Everything that path does applies
// unchanged: argument parsing, the collab-guest host-only gate, the vibe-mode
// and /btw gates, settings flush, worktree creation, session move and cwd
// rescope with rollback, `worktree.cleanSource`, the summary line, and
// registration in InteractiveMode's owned worktrees (so `worktree.onExit`
// handles it at exit).
//
// Before queueing, `wt` checks whether the session is already in a linked
// worktree. If it is, the call creates nothing and returns that worktree's
// path, branch, HEAD, uncommitted count, main checkout, what forking from it
// would do, and a `confirm` value (hash of the worktree path and branch).
// Only a second call with that value queues `/wt` anyway.
//
// `wt_remove` removes the linked worktree the session is in and moves the
// session to the main checkout. OMP has no removal command, so only the move
// is the human's (`/move <main checkout>`); the removal is a forced
// `git worktree remove` that keeps the branch. It takes two calls:
//   1. Without `confirm`: a check that changes nothing. It reports what removal
//      would delete (staged, unstaged, untracked, ignored files), the branch
//      commits not reachable from the main checkout's HEAD (the branch is kept
//      either way), and what would block it (running background jobs, running
//      subagents, live subagents whose cwd is in the worktree). It returns a
//      `confirm` value: a hash of the worktree path, branch, upstream's
//      worktree fingerprint (`planWorktreeExit`: HEAD, branch tip, porcelain
//      status, size/mtime of each changed path) and the ignored-file listing.
//   2. With `confirm`: the check runs again and the value must match, so the
//      model can only confirm the state it was shown. The removal is queued.
// When the session is idle the check runs once more before `/move` and once
// more after it; any difference or blocker stops the removal there.
//
// Both tools queue: the human commands refuse while the session is streaming,
// and a tool call always runs while streaming. On an `agent_end` that hands
// control back (terminal, or `willContinue` with `awaitingAsyncWork`: only a
// background job's result can resume the session, which stays open to the
// human's commands meanwhile) the request is armed; a timer waits until the
// session is idle with no queued messages, then runs it once. `agent_start`
// disarms the timer; the next such `agent_end` re-arms it. An end interrupted
// by the user (Esc) cancels the request. Session switch and shutdown drop it.
//
// While a human command runs, `showError` / `showWarning` / `showStatus` /
// `present` on the instance are shadowed by recorders that still delegate, so
// the human sees exactly what the command shows and the agent gets the same
// text. `editor.addToHistory` is shadowed by a no-op and `draftDetached` is
// set, so the agent's command neither enters the human's input history nor
// clears the human's draft. The outcome goes back as a custom message
// (`attribution: "agent"`) that starts a turn.
//
// The extension API has no handle on InteractiveMode. `ctx.ui.setEditorComponent`
// in the TUI forwards to `InteractiveMode#setEditorComponent` with the live
// instance as `this`, so the prototype method is swapped for a recorder for
// that one synchronous call and restored before anything else runs; the real
// editor swap never happens.
//
// Relies on omp internals (InteractiveMode's prototype and public members,
// the extension UI context forwarding, `executeBuiltinSlashCommand`, the
// `/wt` and `/move` TUI handlers, `planWorktreeExit`, `AgentRegistry`);
// re-verify in a real TUI after every omp upgrade.
// ============================================================================
// TUI-main-only tools wt and wt_remove; hooks: session_start/switch/shutdown, agent_start/end.
// Reads git worktree state; built-in /wt and /move write git/session state, and confirmed removal deletes the worktree.
// No extension config files. Failures are returned to the agent; hook failures are logged without escaping into omp.
import * as fs from "node:fs/promises";
import { type AgentEndEvent, type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgWorktreeCleanSource } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { captureInteractiveMode, describeShown, runSlashCommand } from "./interactive.ts";
import { formatCheck, git, inspect, parsePorcelain, realpathOr, recheck, type WorktreeCheck } from "./worktree.ts";

const CREATE_TOOL = "wt";
const REMOVE_TOOL = "wt_remove";
const MESSAGE_TYPE = "wt-tool";
const IDLE_POLL_MS = 50;

const CREATE_DESCRIPTION = [
	"Create a new git worktree for this session and move the session into it: a new branch `branch` (default `wt/<yyyymmdd-hhmmss>`) at the current HEAD, uncommitted changes carried along; the session's cwd becomes the new worktree.",
	"Use this tool for session worktrees; never create, switch to, or remove worktrees yourself with `git worktree` or by changing directories.",
	"When the working tree holds changes you did not make (another agent, another person), propose this tool; ask the human first when unsure whether they are interference.",
	"If the session is already in a worktree, nothing is created: you get that worktree's path, branch, HEAD, uncommitted changes, and a `confirm` value. Keep working there unless you really need another worktree branched from it; then call again with that `confirm` value.",
	"The worktree is created after your turn ends: end your turn right after a call that creates, without further tool calls. The result (new path and branch, or the error) arrives as the next message.",
].join("\n");

const REMOVE_DESCRIPTION = [
	"Remove the worktree this session is in and move the session back to the repository's main checkout. The branch is kept.",
	"Use this tool to leave a session worktree; never remove or leave worktrees yourself with `git worktree` or by changing directories.",
	"Call it twice. First without `confirm`: a dry run that changes nothing and reports whether removal is safe, the staged, unstaged, untracked and ignored entries it would delete (up to 50 per category, with the total), branch commits not in the main checkout, anything blocking removal, and a `confirm` value.",
	"Read the report and decide. To remove, call again with that `confirm` value; it stops matching once files are added, removed or edited (by size or modification time), HEAD or the branch moves, or the ignored-entry list changes, and then you must check again.",
	"The removal happens after your turn ends: end your turn right after the confirming call, without further tool calls. It is checked once more first; any change or blocker stops it. The result arrives as the next message.",
].join("\n");

const createParams = z.object({
	branch: z.string().optional().describe("New branch name; omit for the default `wt/<timestamp>`."),
	confirm: z
		.string()
		.optional()
		.describe(
			"Only when the session is already in a linked worktree: the `confirm` value from the previous call, to create a worktree anyway.",
		),
});

const removeParams = z.object({
	confirm: z.string().optional().describe("Omit to check. To remove, the `confirm` value from the latest check."),
});

type Request =
	| { readonly kind: "create"; readonly sessionId: string; readonly branch: string | undefined }
	| { readonly kind: "remove"; readonly sessionId: string; readonly check: WorktreeCheck };

/** Lifecycle of the one queued request: queued by a tool, armed after a terminal `agent_end`, then run once. */
type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly request: Request }
	| { readonly kind: "armed"; readonly request: Request; readonly timer: Timer }
	| { readonly kind: "running"; readonly request: Request };

const requestLabel = (request: Request): string => (request.kind === "create" ? "`/wt`" : "worktree removal");

const isEligible = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.agent.kind === "main";

type Runtime = { readonly pi: ExtensionAPI; state: State };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

function unexpected(value: never): never {
	throw new Error(`Unexpected wt state: ${String(value)}`);
}

function reset(runtime: Runtime, ctx: ExtensionContext): void {
	switch (runtime.state.kind) {
		case "armed":
			ctx.clearTimer(runtime.state.timer);
			break;
		case "idle":
		case "queued":
		case "running":
			break;
		default:
			unexpected(runtime.state);
	}
	runtime.state = { kind: "idle" };
}

function report(pi: ExtensionAPI, content: string, options: { triggerTurn: true } | { deliverAs: "nextTurn" }): void {
	pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, attribution: "agent" }, options);
}

async function runCreate(pi: ExtensionAPI, mode: InteractiveModeContext, branch: string | undefined): Promise<string> {
	const before = mode.sessionManager.getCwd();
	const shown = await runSlashCommand(mode, branch ? `/wt ${branch}` : "/wt");
	const after = mode.sessionManager.getCwd();
	pi.logger.info("wt: queued /wt ran", { before, after, moved: after !== before });
	return after !== before
		? `New worktree created; this session moved from \`${before}\` to \`${after}\`. Continue the task there.\n${describeShown(shown)}`
		: `No worktree was created; the session is still in \`${before}\`.\n${describeShown(shown)}`;
}

async function runRemove(pi: ExtensionAPI, ctx: ExtensionContext, mode: InteractiveModeContext, check: WorktreeCheck): Promise<string> {
	const beforeMove = await recheck(pi, ctx, check);
	if (beforeMove.kind === "stop") {
		return `Worktree removal stopped before anything changed: ${beforeMove.why}\nThe session is still in \`${mode.sessionManager.getCwd()}\` and \`${check.worktree}\` is untouched.`;
	}
	const shown = await runSlashCommand(mode, `/move ${check.mainDir}`);
	const cwd = await realpathOr(mode.sessionManager.getCwd());
	if (cwd !== check.mainDir) {
		return `Worktree removal stopped: \`/move ${check.mainDir}\` did not move the session; it is in \`${cwd}\` and \`${check.worktree}\` is untouched. What /move showed the user:\n${describeShown(shown)}`;
	}
	const moved = `The session moved to the main checkout \`${check.mainDir}\`. Continue the task there.`;
	const afterMove = await recheck(pi, ctx, check);
	if (afterMove.kind === "stop") return `${moved}\nThe worktree was NOT removed: ${afterMove.why}\n\`${check.worktree}\` is untouched.`;
	try {
		const removed = await vcs.requireGit(check.mainDir).worktreeRemove(check.worktree, true);
		const exists = await fs.stat(check.worktree).then(
			() => true,
			() => false,
		);
		pi.logger.info("wt_remove: removal ran", { worktree: check.worktree, removed, exists });
		if (!removed || exists) {
			return `${moved}\nRemoving the worktree failed: the removal ${removed ? "reported success but the directory still exists" : "was refused"}; \`${check.worktree}\` ${exists ? "still exists" : "is gone"}.`;
		}
	} catch (error) {
		const exists = await fs.stat(check.worktree).then(
			() => true,
			() => false,
		);
		return `${moved}\nRemoving the worktree failed: ${errorText(error)}; \`${check.worktree}\` ${exists ? "still exists" : "is gone"}.`;
	}
	const removedText = `${moved}\nRemoved the worktree \`${check.worktree}\`.`;
	const branchKept = await vcs
		.requireGit(check.mainDir)
		.resolveRef(`refs/heads/${check.branch}`)
		.then(
			(ref) => Boolean(ref),
			() => undefined,
		);
	if (branchKept === undefined) return `${removedText} Could not check whether branch \`${check.branch}\` still exists.`;
	if (!branchKept) return `${removedText} Branch \`${check.branch}\` no longer exists.`;
	const unmerged = afterMove.check.unmergedCommits;
	const commits =
		unmerged.length > 0
			? `It has ${unmerged.length} commit(s) not reachable from the main checkout's HEAD.`
			: "All its commits are reachable from the main checkout's HEAD.";
	return `${removedText} Branch \`${check.branch}\` is kept. ${commits}`;
}

async function execute(runtime: Runtime, ctx: ExtensionContext, request: Request): Promise<void> {
	runtime.state = { kind: "running", request };
	try {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) return;
		const capture = captureInteractiveMode(ctx);
		if (capture.kind === "error") {
			runtime.pi.logger.warn("wt: queued request not run", { kind: request.kind, reason: capture.reason });
			report(runtime.pi, `The queued ${requestLabel(request)} did not run: ${capture.reason}`, { triggerTurn: true });
			return;
		}
		let outcome: string;
		switch (request.kind) {
			case "create":
				outcome = await runCreate(runtime.pi, capture.mode, request.branch);
				break;
			case "remove":
				outcome = await runRemove(runtime.pi, ctx, capture.mode, request.check);
				break;
			default:
				return unexpected(request);
		}
		report(runtime.pi, outcome, { triggerTurn: true });
	} catch (error) {
		runtime.pi.logger.warn("wt: queued request failed", { error: errorText(error) });
		report(runtime.pi, `The queued ${requestLabel(request)} failed: ${errorText(error)}`, { triggerTurn: true });
	} finally {
		runtime.state = { kind: "idle" };
	}
}

function arm(runtime: Runtime, ctx: ExtensionContext, request: Request): void {
	const tick = (): void => {
		if (runtime.state.kind !== "armed" || runtime.state.request !== request) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			runtime.state = { kind: "armed", request, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
			return;
		}
		void execute(runtime, ctx, request);
	};
	runtime.state = { kind: "armed", request, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
}

async function activate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!isEligible(ctx)) return;
	const active = new Set(pi.getActiveTools());
	if (active.has(CREATE_TOOL) && active.has(REMOVE_TOOL)) return;
	active.add(CREATE_TOOL);
	active.add(REMOVE_TOOL);
	await pi.setActiveTools([...active]);
}

/** Why the calling session cannot queue a request, if it cannot. */
function queueBlocker(runtime: Runtime, ctx: ExtensionContext, tool: string): string | undefined {
	if (!isEligible(ctx)) return `${tool}: only the main session of the interactive TUI can use this tool.`;
	switch (runtime.state.kind) {
		case "idle":
			break;
		case "armed":
		case "queued":
		case "running":
			return `${tool}: ${requestLabel(runtime.state.request)} is already queued for the end of this turn; end your turn.`;
		default:
			return unexpected(runtime.state);
	}
	const capture = captureInteractiveMode(ctx);
	if (capture.kind === "error") return `${tool}: ${capture.reason}`;
	if (capture.mode.collabGuest) return `${tool}: session moves are host-only during a collab session.`;
	return undefined;
}

/** The current linked worktree and what /wt would do from it; undefined outside one. */
async function currentWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ readonly confirm: string; readonly report: string } | undefined> {
	const cwd = ctx.sessionManager.getCwd();
	const linked = vcs.git(cwd)?.linkedWorktree();
	if (!linked) return undefined;
	const worktree = await realpathOr(linked.root);
	const mainDir = await realpathOr(linked.primaryRoot);
	const branch = (await git(pi, worktree, ["branch", "--show-current"])).trim();
	const head = (await git(pi, worktree, ["log", "-1", "--format=%h %s"])).trim();
	const changed = parsePorcelain(await git(pi, worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length;
	const capture = captureInteractiveMode(ctx);
	const cleanSource = capture.kind === "ok" && cfgWorktreeCleanSource.get(capture.mode.settings) === true;
	const report = [
		`Worktree: ${worktree}`,
		`Branch: ${branch || "(detached HEAD)"}`,
		`HEAD: ${head}`,
		`Uncommitted entries: ${changed}`,
		`Main checkout: ${mainDir}`,
		`Creating anyway forks a new worktree from this one: a new branch at this HEAD, carrying these ${changed} uncommitted entries; this worktree stays.${cleanSource ? " `worktree.cleanSource` is on, so this worktree is then reset and cleaned: its uncommitted changes survive only in the new one." : ""}`,
	].join("\n");
	return { confirm: Bun.hash(`wt\0${worktree}\0${branch}`).toString(16), report };
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): ToolResult => ({ ...text(value), isError: true });

async function create(runtime: Runtime, ctx: ExtensionContext, rawParams: unknown): Promise<ToolResult> {
	const blocked = queueBlocker(runtime, ctx, CREATE_TOOL);
	if (blocked !== undefined) return fail(blocked);
	const params = createParams.parse(rawParams);
	const branch = params.branch?.trim() || undefined;
	const current = await currentWorktree(runtime.pi, ctx);
	if (current !== undefined && params.confirm?.trim() !== current.confirm) {
		const mismatch = params.confirm === undefined ? "" : "The given confirm value does not match this worktree, so nothing was queued.\n";
		return text(
			`${mismatch}Nothing was created: this session is already in a linked worktree.\n${current.report}\nUsually keep working here. To create a new worktree from this one anyway, call ${CREATE_TOOL} again with confirm="${current.confirm}".`,
		);
	}
	runtime.state = { kind: "queued", request: { kind: "create", sessionId: ctx.sessionManager.getSessionId(), branch } };
	return text(
		`Queued: a new worktree${branch ? ` on branch \`${branch}\`` : ""} is created once this turn ends. End your turn now without further tool calls; the outcome arrives as the next message.`,
	);
}

async function remove(runtime: Runtime, ctx: ExtensionContext, rawParams: unknown): Promise<ToolResult> {
	const blocked = queueBlocker(runtime, ctx, REMOVE_TOOL);
	if (blocked !== undefined) return fail(blocked);
	const confirm = removeParams.parse(rawParams).confirm?.trim() || undefined;
	const result = await inspect(runtime.pi, ctx, ctx.sessionManager.getCwd());
	if (result.kind === "error") return fail(`${REMOVE_TOOL}: ${result.reason}`);
	const check = result.check;
	if (confirm === undefined) {
		return text(
			`Check only; nothing changed.\n${formatCheck(check)}\nTo remove, call ${REMOVE_TOOL} again with confirm="${check.confirm}". The value stops matching once the worktree changes.`,
		);
	}
	if (confirm !== check.confirm) {
		return fail(
			`${REMOVE_TOOL}: confirm does not match the worktree's current state, so nothing was queued. Either the value is from another state, or the worktree changed since the check: a file was added, removed or edited, HEAD or the branch moved, or the ignored-entry list changed. Current state:\n${formatCheck(check)}`,
		);
	}
	if (check.blockers.length > 0) return fail(`${REMOVE_TOOL}: the worktree is in use; nothing was queued.\n${check.blockers.join("\n")}`);
	runtime.state = { kind: "queued", request: { kind: "remove", sessionId: ctx.sessionManager.getSessionId(), check } };
	return text(
		`Queued removal of \`${check.worktree}\` (branch \`${check.branch}\` is kept). End your turn now without further tool calls: once the session is idle it moves to \`${check.mainDir}\` and the worktree is removed, unless anything in it changed since the check. The outcome arrives as the next message.`,
	);
}

function disarm(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "armed") return;
	ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "queued", request: runtime.state.request };
}

function onAgentEnd(runtime: Runtime, event: AgentEndEvent, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "queued") return;
	// A continuation the session schedules itself (reminder, retry, compaction) keeps the request queued;
	// waiting only on background jobs leaves the session idle, where the human could run the command too.
	if (event.willContinue === true && event.awaitingAsyncWork !== true) return;
	const request = runtime.state.request;
	const last = event.messages.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "aborted" && isUserInterruptAbort(last)) {
		runtime.state = { kind: "idle" };
		ctx.ui.notify(
			tr(
				`Queued ${requestLabel(request).replaceAll("`", "")} cancelled: the turn was interrupted.`,
				`已取消排队的 ${request.kind === "create" ? "/wt" : "工作树移除"}：本轮被中断。`,
			),
			"info",
		);
		report(runtime.pi, `The queued ${requestLabel(request)} was cancelled because the user interrupted the turn; nothing changed.`, {
			deliverAs: "nextTurn",
		});
		return;
	}
	arm(runtime, ctx, request);
}

async function guardHook(pi: ExtensionAPI, label: string, handler: () => void | Promise<void>): Promise<void> {
	try {
		await handler();
	} catch (error) {
		pi.logger.warn(`wt: ${label} hook failed`, { error: errorText(error) });
	}
}

export default function wtTool(pi: ExtensionAPI): void {
	const runtime: Runtime = { pi, state: { kind: "idle" } };
	pi.on("session_start", (_event, ctx) => guardHook(pi, "session_start", () => activate(pi, ctx)));
	pi.on("session_switch", (_event, ctx) =>
		guardHook(pi, "session_switch", async () => {
			reset(runtime, ctx);
			await activate(pi, ctx);
		}),
	);
	pi.on("session_shutdown", (_event, ctx) => guardHook(pi, "session_shutdown", () => reset(runtime, ctx)));
	pi.on("agent_start", (_event, ctx) => guardHook(pi, "agent_start", () => disarm(runtime, ctx)));
	pi.on("agent_end", (event, ctx) => guardHook(pi, "agent_end", () => onAgentEnd(runtime, event, ctx)));
	pi.registerTool({
		name: CREATE_TOOL,
		label: tr("Worktree", "工作树"),
		description: CREATE_DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: createParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			try {
				return await create(runtime, ctx, rawParams);
			} catch (error) {
				pi.logger.warn("wt: tool failed", { error: errorText(error) });
				return fail(errorText(error));
			}
		},
	});
	pi.registerTool({
		name: REMOVE_TOOL,
		label: tr("Remove Worktree", "移除工作树"),
		description: REMOVE_DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: removeParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			try {
				return await remove(runtime, ctx, rawParams);
			} catch (error) {
				pi.logger.warn("wt_remove: tool failed", { error: errorText(error) });
				return fail(errorText(error));
			}
		},
	});
}
