// Relies on omp internals (InteractiveMode's prototype and public members,
// the extension UI context forwarding, `executeBuiltinSlashCommand`, the
// `/wt` and `/move` TUI handlers, `planWorktreeExit`, `AgentRegistry`);
// re-verify in a real TUI after every omp upgrade.
import * as fs from "node:fs/promises";
import {
	type AgentEndEvent,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	z,
} from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgWorktreeCleanSource } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { captureInteractiveMode, type InteractiveModeFailure } from "../_shared/interactive-mode.ts";
import { applyActiveTools } from "../_shared/omomp-shared/active-tools.ts";
import { describeShown, runSlashCommand } from "./interactive.ts";
import {
	CONFIRM_INVALIDATION,
	formatCheck,
	inspect,
	locate,
	realpathOr,
	recheck,
	uncommittedCount,
	type WorktreeCheck,
} from "./worktree.ts";

const CREATE_TOOL = "wt";
const REMOVE_TOOL = "wt_remove";
const MESSAGE_TYPE = "wt-tool";
const IDLE_POLL_MS = 50;

const CREATE_DESCRIPTION = [
	"Create a new git worktree for this session and move the session into it: a new branch at the current HEAD, uncommitted changes carried along; the session's cwd becomes the new worktree.",
	"Use this tool for session worktrees; never create, switch to, or remove worktrees yourself with `git worktree` or by changing directories.",
	"When the working tree holds changes you did not make (another agent, another person), propose this tool; ask the human first when unsure whether they are interference.",
	"",
	"Topics — read the one a call needs before making it:",
	`- \`help://${CREATE_TOOL}/lifecycle\` — before calling, or when the session is already in a linked worktree`,
].join("\n");

const REMOVE_DESCRIPTION = [
	"Remove the worktree this session is in and move the session back to the repository's main checkout. The branch is kept.",
	"Use this tool to leave a session worktree; never remove or leave worktrees yourself with `git worktree` or by changing directories.",
	"",
	"Topics — read the one a call needs before making it:",
	`- \`help://${REMOVE_TOOL}/lifecycle\` — before the first call`,
].join("\n");

const CREATE_TOPICS: Readonly<Record<string, string>> = {
	lifecycle: [
		`# ${CREATE_TOOL} lifecycle`,
		"",
		"- A call only queues `/wt`. It runs once your turn ends and the session is idle: end your turn right after a call that queues, without further tool calls. The outcome (new path and branch, or the error) arrives as the next message.",
		"- Interrupting that turn cancels the queued request; the cancellation arrives as the next message and nothing changes.",
		"- Already in a linked worktree: the first call creates nothing and returns that worktree's path, branch, HEAD, uncommitted entries, the main checkout and a `confirm` value. Keep working there unless you really need another worktree branched from it; then call again with that `confirm` value. The new worktree starts at this HEAD and carries these uncommitted entries; with `worktree.cleanSource` on, this worktree is then reset and cleaned.",
		"- Only the main session of the interactive TUI can use it; vibe mode and collab guests are refused.",
	].join("\n"),
};

const REMOVE_TOPICS: Readonly<Record<string, string>> = {
	lifecycle: [
		`# ${REMOVE_TOOL} lifecycle`,
		"",
		"- Call it twice. First without `confirm`: a dry run that changes nothing and reports SAFE, UNSAFE or BLOCKED, the staged, unstaged, untracked and ignored entries removal would delete (up to 50 per category, with the total), branch commits not reachable from the main checkout, anything blocking removal, and a `confirm` value.",
		`- Read the report and decide. To remove, call again with that \`confirm\` value. It stops matching once ${CONFIRM_INVALIDATION}; then check again.`,
		"- The confirmed call only queues the removal: end your turn right after it, without further tool calls. Once the session is idle the state is checked again, the session moves to the main checkout with `/move`, the state is checked once more, and the worktree is force-removed; any change or blocker stops it. The outcome arrives as the next message.",
		"- Interrupting that turn cancels the queued removal and nothing changes.",
	].join("\n"),
};

const createParams = z.object({
	branch: z.string().optional().describe("New branch name; omit for the default `wt/<yyyymmdd-hhmmss>`."),
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

type ConfirmedRemoval = Pick<WorktreeCheck, "worktree" | "branch" | "mainDir" | "confirm">;

type Request =
	| { readonly kind: "create"; readonly sessionId: string; readonly branch: string | undefined }
	| { readonly kind: "remove"; readonly sessionId: string; readonly check: ConfirmedRemoval };

type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly request: Request }
	| { readonly kind: "armed"; readonly request: Request; readonly timer: Timer }
	| { readonly kind: "running"; readonly request: Request };

type Readiness = { readonly kind: "ready"; readonly mode: InteractiveModeContext } | { readonly kind: "blocked"; readonly reason: string };

type BranchState = "kept" | "gone" | "unknown";

type Runtime = { readonly pi: ExtensionAPI; state: State };
type ToolResult = AgentToolResult<undefined>;
type WithTopics<TTool> = TTool & { docTopics(): Readonly<Record<string, string>> };

function unexpected(value: never): never {
	throw new Error(`Unexpected wt variant: ${String(value)}`);
}

function requestLabel(request: Request): string {
	switch (request.kind) {
		case "create":
			return "/wt";
		case "remove":
			return "worktree removal";
		default:
			return unexpected(request);
	}
}

const isEligible = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.agent.kind === "main";

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): ToolResult => ({ ...text(value), isError: true });

function captureFailureText(failure: InteractiveModeFailure): string {
	switch (failure.kind) {
		case "missing-setEditorComponent":
			return "the InteractiveMode setEditorComponent method is missing (omp internals changed).";
		case "unreachable":
			return "the interactive TUI instance is not reachable from this session.";
		case "other-session":
			return "the interactive TUI is attached to a different session.";
		default:
			return unexpected(failure);
	}
}

function reset(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind === "armed") ctx.clearTimer(runtime.state.timer);
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

async function forceRemove(pi: ExtensionAPI, check: ConfirmedRemoval): Promise<string | undefined> {
	const repository = vcs.requireGit(check.mainDir);
	let failure: string | undefined;
	try {
		if (!(await repository.worktreeRemove(check.worktree, true))) failure = "the removal was refused";
		else await repository.worktreePrune();
	} catch (error) {
		failure = errorText(error);
	}
	const exists = await fs.stat(check.worktree).then(
		() => true,
		() => false,
	);
	pi.logger.info("wt_remove: removal ran", { worktree: check.worktree, failure, exists });
	if (failure === undefined && !exists) return undefined;
	return `${failure ?? "the removal reported success but the directory still exists"}; \`${check.worktree}\` ${exists ? "still exists" : "is gone"}.`;
}

async function branchState(mainDir: string, branch: string): Promise<BranchState> {
	try {
		return (await vcs.requireGit(mainDir).refExists(`refs/heads/${branch}`)) ? "kept" : "gone";
	} catch {
		return "unknown";
	}
}

function branchReport(branch: string, state: BranchState, unmerged: number): string {
	switch (state) {
		case "unknown":
			return `Could not check whether branch \`${branch}\` still exists.`;
		case "gone":
			return `Branch \`${branch}\` no longer exists.`;
		case "kept":
			return `Branch \`${branch}\` is kept. ${
				unmerged > 0
					? `It has ${unmerged} commit(s) not reachable from the main checkout's HEAD.`
					: "All its commits are reachable from the main checkout's HEAD."
			}`;
		default:
			return unexpected(state);
	}
}

async function runRemove(pi: ExtensionAPI, ctx: ExtensionContext, mode: InteractiveModeContext, check: ConfirmedRemoval): Promise<string> {
	const untouched = `\`${check.worktree}\` is untouched.`;
	const beforeMove = await recheck(pi, ctx, check);
	if (beforeMove.kind === "stop") {
		return `Worktree removal stopped before anything changed: ${beforeMove.why}\nThe session is still in \`${mode.sessionManager.getCwd()}\` and ${untouched}`;
	}
	const shown = await runSlashCommand(mode, `/move ${check.mainDir}`);
	const cwd = await realpathOr(mode.sessionManager.getCwd());
	if (cwd !== check.mainDir) {
		return `Worktree removal stopped: \`/move ${check.mainDir}\` did not move the session; it is in \`${cwd}\` and ${untouched} What /move showed the user:\n${describeShown(shown)}`;
	}
	const moved = `The session moved to the main checkout \`${check.mainDir}\`. Continue the task there.`;
	const afterMove = await recheck(pi, ctx, check);
	if (afterMove.kind === "stop") return `${moved}\nThe worktree was NOT removed: ${afterMove.why}\n${untouched}`;
	const failure = await forceRemove(pi, check);
	if (failure !== undefined) return `${moved}\nRemoving the worktree failed: ${failure}`;
	const branch = branchReport(check.branch, await branchState(check.mainDir, check.branch), afterMove.check.unmerged.length);
	return `${moved}\nRemoved the worktree \`${check.worktree}\`. ${branch}`;
}

async function execute(runtime: Runtime, ctx: ExtensionContext, request: Request): Promise<void> {
	runtime.state = { kind: "running", request };
	try {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) return;
		const capture = captureInteractiveMode(ctx);
		if (capture.kind !== "ok") {
			const reason = captureFailureText(capture);
			runtime.pi.logger.warn("wt: queued request not run", { kind: request.kind, reason });
			report(runtime.pi, `The queued ${requestLabel(request)} did not run: ${reason}`, { triggerTurn: true });
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
		if (runtime.state.kind === "running" && runtime.state.request === request) runtime.state = { kind: "idle" };
	}
}

function arm(runtime: Runtime, ctx: ExtensionContext, request: Request): void {
	const tick = (): void => {
		if (runtime.state.kind !== "armed" || runtime.state.request !== request) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		ctx.clearTimer(runtime.state.timer);
		void execute(runtime, ctx, request);
	};
	runtime.state = { kind: "armed", request, timer: ctx.setInterval(tick, IDLE_POLL_MS) };
}

function disarm(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "armed") return;
	ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "queued", request: runtime.state.request };
}

async function activate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!isEligible(ctx)) return;
	const active = pi.getActiveTools();
	if (active.includes(CREATE_TOOL) && active.includes(REMOVE_TOOL)) return;
	await applyActiveTools(pi, [...active, CREATE_TOOL, REMOVE_TOOL]);
}

function readiness(runtime: Runtime, ctx: ExtensionContext, tool: string): Readiness {
	const blocked = (reason: string): Readiness => ({ kind: "blocked", reason: `${tool}: ${reason}` });
	if (!isEligible(ctx)) return blocked("only the main session of the interactive TUI can use this tool.");
	if (ctx.sessionModes?.getState().vibe.status === "active")
		return blocked(`the session is in vibe mode, so nothing was queued: exit vibe mode first, then call ${tool} again.`);
	if (runtime.state.kind !== "idle")
		return blocked(`${requestLabel(runtime.state.request)} is already queued for the end of this turn; end your turn.`);
	const capture = captureInteractiveMode(ctx);
	if (capture.kind !== "ok") return blocked(captureFailureText(capture));
	if (capture.mode.collabGuest) return blocked("session moves are host-only during a collab session.");
	return { kind: "ready", mode: capture.mode };
}

async function currentWorktree(
	ctx: ExtensionContext,
	mode: InteractiveModeContext,
): Promise<{ readonly confirm: string; readonly report: string } | undefined> {
	const location = await locate(ctx.sessionManager.getCwd());
	if (location.kind !== "linked") return undefined;
	const { repository, worktree, mainDir } = location;
	const branch = (await repository.currentBranch()) ?? "";
	const head = (await repository.logOnelines(1))[0] ?? "(no commits)";
	const changed = await uncommittedCount(repository);
	const cleanSource = cfgWorktreeCleanSource.get(mode.settings) === true;
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

async function create(runtime: Runtime, ctx: ExtensionContext, rawParams: unknown): Promise<ToolResult> {
	const ready = readiness(runtime, ctx, CREATE_TOOL);
	if (ready.kind === "blocked") return fail(ready.reason);
	const params = createParams.parse(rawParams);
	const branch = params.branch?.trim() || undefined;
	const current = await currentWorktree(ctx, ready.mode);
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
	const ready = readiness(runtime, ctx, REMOVE_TOOL);
	if (ready.kind === "blocked") return fail(ready.reason);
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
			`${REMOVE_TOOL}: confirm does not match the worktree's current state, so nothing was queued. Either the value is from another state, or the worktree changed since the check: ${CONFIRM_INVALIDATION}. Current state:\n${formatCheck(check)}`,
		);
	}
	if (check.blockers.length > 0) return fail(`${REMOVE_TOOL}: the worktree is in use; nothing was queued.\n${check.blockers.join("\n")}`);
	const { worktree, branch, mainDir } = check;
	runtime.state = {
		kind: "queued",
		request: { kind: "remove", sessionId: ctx.sessionManager.getSessionId(), check: { worktree, branch, mainDir, confirm } },
	};
	return text(
		`Queued removal of \`${worktree}\` (branch \`${branch}\` is kept). End your turn now without further tool calls: once the session is idle it moves to \`${mainDir}\` and the worktree is removed, unless anything in it changed since the check. The outcome arrives as the next message.`,
	);
}

function onAgentEnd(runtime: Runtime, event: AgentEndEvent, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "queued") return;
	if (event.willContinue === true && event.awaitingAsyncWork !== true) return;
	const request = runtime.state.request;
	const last = event.messages.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "aborted" && isUserInterruptAbort(last)) {
		runtime.state = { kind: "idle" };
		ctx.ui.notify(
			tr(
				`Queued ${requestLabel(request)} cancelled: the turn was interrupted.`,
				`已取消排队的${request.kind === "create" ? " /wt" : "工作树移除"}：本轮被中断。`,
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

async function guardTool(pi: ExtensionAPI, tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await run();
	} catch (error) {
		pi.logger.warn(`${tool}: tool failed`, { error: errorText(error) });
		return fail(`${tool}: ${errorText(error)}`);
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
	const createTool = {
		name: CREATE_TOOL,
		label: tr("Worktree", "工作树"),
		description: CREATE_DESCRIPTION,
		docTopics: () => CREATE_TOPICS,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: createParams,
		execute: (_toolCallId, rawParams, _signal, _onUpdate, ctx) => guardTool(pi, CREATE_TOOL, () => create(runtime, ctx, rawParams)),
	} satisfies WithTopics<ToolDefinition<typeof createParams>>;
	const removeTool = {
		name: REMOVE_TOOL,
		label: tr("Remove Worktree", "移除工作树"),
		description: REMOVE_DESCRIPTION,
		docTopics: () => REMOVE_TOPICS,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: removeParams,
		execute: (_toolCallId, rawParams, _signal, _onUpdate, ctx) => guardTool(pi, REMOVE_TOOL, () => remove(runtime, ctx, rawParams)),
	} satisfies WithTopics<ToolDefinition<typeof removeParams>>;
	pi.registerTool(createTool);
	pi.registerTool(removeTool);
}
