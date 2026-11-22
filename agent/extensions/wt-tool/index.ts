// Relies on omp internals (InteractiveMode's prototype and public members,
// the extension UI context forwarding, `executeBuiltinSlashCommand`, the
// `/wt` and `/move` TUI handlers, `planWorktreeExit`, `AgentRegistry`);
// re-verify in a real TUI after every omp upgrade.
import * as fs from "node:fs/promises";
import { type AgentEndEvent, type AgentToolResult, type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
	type SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgWorktreeCleanSource } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { captureInteractiveMode, type InteractiveModeFailure } from "../_shared/interactive-mode.ts";
import { applyActiveTools } from "../_shared/omomp-shared/active-tools.ts";
import { registerInternalScheme } from "../_shared/omomp-shared/internal-url.ts";
import { describeShown, runSlashCommand } from "./interactive.ts";
import { formatCheck, git, inspect, porcelainCount, porcelainLists, realpathOr, recheck, type WorktreeCheck } from "./worktree.ts";

const CREATE_TOOL = "wt";
const REMOVE_TOOL = "wt_remove";
const MESSAGE_TYPE = "wt-tool";
const WORKTREE_URL_OWNER = "omp-config/wt-tool";
const IDLE_POLL_MS = 50;
const DIRTY_PREVIEW_LIMIT = 20;

const CREATE_DESCRIPTION = [
	"Create a new git worktree for this session and move the session into it: a new branch `branch` (default `wt/<yyyymmdd-hhmmss>`) at the current HEAD, uncommitted changes carried along; the session's cwd becomes the new worktree.",
	"Read `worktree://` first to inspect whether this session is already in a linked worktree, its current HEAD, and dirty-file summary.",
	"Use this tool for session worktrees; never create, switch to, or remove worktrees yourself with `git worktree` or by changing directories.",
	"When the working tree holds changes you did not make (another agent, another person), propose this tool; ask the human first when unsure whether they are interference.",
	"If the session is already in a worktree, nothing is created: you get that worktree's path, branch, HEAD, uncommitted changes, and a `confirm` value. Keep working there unless you really need another worktree branched from it; then call again with that `confirm` value.",
	"The worktree is created after your turn ends: end your turn right after a call that creates, without further tool calls. The result (new path and branch, or the error) arrives as the next message.",
].join("\n");

const REMOVE_DESCRIPTION = [
	"Remove the worktree this session is in and move the session back to the repository's main checkout. The branch is kept.",
	"Read `worktree://` for a quick read-only snapshot of linked-worktree status, current HEAD, and dirty files.",
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

type ConfirmedRemoval = Pick<WorktreeCheck, "worktree" | "branch" | "mainDir" | "confirm">;

type Request =
	| { readonly kind: "create"; readonly sessionId: string; readonly branch: string | undefined }
	| { readonly kind: "remove"; readonly sessionId: string; readonly check: ConfirmedRemoval };

type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly request: Request }
	| { readonly kind: "armed"; readonly request: Request; readonly timer: Timer }
	| { readonly kind: "running"; readonly request: Request };

const requestLabel = (request: Request): string => (request.kind === "create" ? "`/wt`" : "worktree removal");

const isEligible = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.agent.kind === "main";

type Runtime = { readonly pi: ExtensionAPI; state: State; cwd: string | undefined };
type ToolResult = AgentToolResult<undefined>;

async function renderWorktreeSnapshot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const resolvedCwd = await realpathOr(cwd);
	const repo = vcs.git(resolvedCwd);
	if (!repo) {
		return ["# worktree://", "", `- Linked worktree: no (not inside a git repository)`, `- CWD: ${resolvedCwd}`, ""].join("\n");
	}
	const linked = repo.linkedWorktree();
	const root = linked
		? await realpathOr(linked.root)
		: await realpathOr((await git(pi, resolvedCwd, ["rev-parse", "--show-toplevel"])).trim());
	const mainDir = linked ? await realpathOr(linked.primaryRoot) : root;
	const branch = (await git(pi, root, ["branch", "--show-current"])).trim() || "(detached HEAD)";
	const head = await git(pi, root, ["log", "-1", "--format=%h %s"]).then(
		(out) => out.trim() || "(no commits)",
		() => "(no commits)",
	);
	const { staged, unstaged, untracked } = porcelainLists(await git(pi, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
	const totalDirty = staged.length + unstaged.length + untracked.length;
	const lines = [
		"# worktree://",
		"",
		`- Linked worktree: ${linked ? "yes" : "no (main checkout)"}`,
		`- Path: ${root}`,
		...(linked ? [`- Main checkout: ${mainDir}`] : []),
		`- Branch: ${branch}`,
		`- HEAD: ${head}`,
		`- Dirty entries: ${totalDirty} (staged: ${staged.length}, unstaged: ${unstaged.length}, untracked: ${untracked.length})`,
	];
	const preview = [
		...staged.map((item) => `staged: ${item}`),
		...unstaged.map((item) => `unstaged: ${item}`),
		...untracked.map((item) => `untracked: ${item}`),
	];
	if (preview.length > 0) {
		lines.push("", "## Dirty summary");
		for (const item of preview.slice(0, DIRTY_PREVIEW_LIMIT)) lines.push(`- ${item}`);
		if (preview.length > DIRTY_PREVIEW_LIMIT) lines.push(`- … and ${preview.length - DIRTY_PREVIEW_LIMIT} more`);
	}
	lines.push("");
	return lines.join("\n");
}

function createWorktreeUrlHandler(runtime: Runtime): ProtocolHandler {
	const spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true, compactTranscript: true };
	return {
		scheme: "worktree",
		spec,
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const host = (url.rawHost || url.hostname).trim();
			const segments = (url.rawPathname ?? url.pathname).split("/").filter((segment) => segment.length > 0);
			const validHost = host === "" || host === "status";
			if (!validHost || segments.length > 0 || url.search || url.hash) {
				throw new ToolError(`Invalid worktree:// URL: ${url.href}. Use worktree:// to inspect current worktree status.`);
			}
			const content = await renderWorktreeSnapshot(runtime.pi, runtime.cwd ?? process.cwd());
			return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content, "utf-8") };
		},
	};
}

function unexpected(value: never): never {
	throw new Error(`Unexpected wt state: ${String(value)}`);
}

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

async function runRemove(pi: ExtensionAPI, ctx: ExtensionContext, mode: InteractiveModeContext, check: ConfirmedRemoval): Promise<string> {
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
	const unmerged = afterMove.check.unmergedCount;
	const commits =
		unmerged > 0
			? `It has ${unmerged} commit(s) not reachable from the main checkout's HEAD.`
			: "All its commits are reachable from the main checkout's HEAD.";
	return `${removedText} Branch \`${check.branch}\` is kept. ${commits}`;
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
		runtime.state = { kind: "idle" };
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

async function activate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!isEligible(ctx)) return;
	const active = pi.getActiveTools();
	if (active.includes(CREATE_TOOL) && active.includes(REMOVE_TOOL)) return;
	await applyActiveTools(pi, [...active, CREATE_TOOL, REMOVE_TOOL]);
}

function queueBlocker(runtime: Runtime, ctx: ExtensionContext, tool: string): string | undefined {
	if (!isEligible(ctx)) return `${tool}: only the main session of the interactive TUI can use this tool.`;
	if (ctx.sessionModes?.getState().vibe.status === "active")
		return `${tool}: the session is in vibe mode, so nothing was queued: exit vibe mode first, then call ${tool} again.`;
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
	if (capture.kind !== "ok") return `${tool}: ${captureFailureText(capture)}`;
	if (capture.mode.collabGuest) return `${tool}: session moves are host-only during a collab session.`;
	return undefined;
}

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
	const changed = porcelainCount(await git(pi, worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
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
			`${mismatch}Nothing was created: this session is already in a linked worktree (inspect anytime with \`read worktree://\`).\n${current.report}\nUsually keep working here. To create a new worktree from this one anyway, call ${CREATE_TOOL} again with confirm="${current.confirm}".`,
		);
	}
	runtime.state = { kind: "queued", request: { kind: "create", sessionId: ctx.sessionManager.getSessionId(), branch } };
	return text(
		`Queued: a new worktree${branch ? ` on branch \`${branch}\`` : ""} is created once this turn ends. End your turn now without further tool calls; the outcome arrives as the next message (inspect live status anytime with \`read worktree://\`).`,
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
			`Check only; nothing changed (for quick status snapshots, use \`read worktree://\`).\n${formatCheck(check)}\nTo remove, call ${REMOVE_TOOL} again with confirm="${check.confirm}". The value stops matching once the worktree changes.`,
		);
	}
	if (confirm !== check.confirm) {
		return fail(
			`${REMOVE_TOOL}: confirm does not match the worktree's current state, so nothing was queued. Either the value is from another state, or the worktree changed since the check: a file was added, removed or edited, HEAD or the branch moved, or the ignored-entry list changed. Current state:\n${formatCheck(check)}`,
		);
	}
	if (check.blockers.length > 0) return fail(`${REMOVE_TOOL}: the worktree is in use; nothing was queued.\n${check.blockers.join("\n")}`);
	runtime.state = {
		kind: "queued",
		request: {
			kind: "remove",
			sessionId: ctx.sessionManager.getSessionId(),
			check: { worktree: check.worktree, branch: check.branch, mainDir: check.mainDir, confirm: check.confirm },
		},
	};
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
	const runtime: Runtime = { pi, state: { kind: "idle" }, cwd: undefined };
	const syncCwd = (ctx: ExtensionContext): void => {
		runtime.cwd = ctx.sessionManager.getCwd();
	};
	const schemeResult = registerInternalScheme(InternalUrlRouter.instance(), WORKTREE_URL_OWNER, createWorktreeUrlHandler(runtime));
	if (schemeResult.kind !== "registered") {
		pi.logger.warn("wt: worktree:// scheme not registered", { reason: schemeResult.reason });
	}
	pi.on("session_start", (_event, ctx) =>
		guardHook(pi, "session_start", async () => {
			syncCwd(ctx);
			await activate(pi, ctx);
		}),
	);
	pi.on("session_switch", (_event, ctx) =>
		guardHook(pi, "session_switch", async () => {
			syncCwd(ctx);
			reset(runtime, ctx);
			await activate(pi, ctx);
		}),
	);
	pi.on("before_agent_start", (_event, ctx) => {
		syncCwd(ctx);
	});
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
