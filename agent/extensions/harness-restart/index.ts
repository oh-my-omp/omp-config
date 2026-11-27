import { type AgentEndEvent, type AgentToolResult, type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { captureInteractiveMode, type InteractiveModeFailure } from "../_shared/interactive-mode.ts";
import { applyActiveTools } from "../_shared/omomp-shared/active-tools.ts";
import { omompTool } from "../_shared/omomp-shared/tool-entry.ts";

const TOOL = "harness_restart";
const MARKER_TYPE = "mouriya.omp.harness-restart.request";
const NOTICE_TYPE = "mouriya.omp.harness-restart.notice";
const IDLE_POLL_MS = 50;

const DESCRIPTION = [
	"Restart the omp harness itself with the same launch flags, resuming this session: the human's /restart.",
	"Use it when new config, extensions or plugins need a restart to load, or the harness is in a bad state.",
	"The restart happens after your turn ends: end your turn right after the call, without further tool calls.",
	"After the restart the session opens with a message that the restart completed and why.",
	"Optional `reason`: one line, recorded durably and repeated back after the restart.",
].join("\n");

const params = z.object({
	reason: z.string().optional().describe("One line: why the restart is needed. Repeated back after the restart."),
});

type Marker = { readonly reason: string; readonly at: number };
type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly marker: Marker }
	| { readonly kind: "armed"; readonly marker: Marker; readonly timer: Timer }
	| { readonly kind: "running"; readonly marker: Marker };

type Runtime = { readonly pi: ExtensionAPI; state: State };

const markerSchema = z.object({ reason: z.string(), at: z.number() });
const consumedSchema = z.object({ consumed: z.literal(true) });

function captureFailureText(failure: InteractiveModeFailure): string {
	switch (failure.kind) {
		case "missing-setToolsExpanded":
			return "the InteractiveMode setToolsExpanded method is missing (omp internals changed).";
		case "unreachable":
			return "the interactive TUI instance is not reachable from this session.";
		case "other-session":
			return "the interactive TUI is attached to a different session.";
		default: {
			const unreachable: never = failure;
			throw new Error(`Unexpected capture failure: ${String(unreachable)}`);
		}
	}
}

function pendingMarker(ctx: ExtensionContext): Marker | undefined {
	let found: Marker | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
			found = undefined;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== MARKER_TYPE) continue;
		if (consumedSchema.safeParse(entry.data).success) {
			found = undefined;
			continue;
		}
		const parsed = markerSchema.safeParse(entry.data);
		if (parsed.success) found = parsed.data;
	}
	return found;
}

function consume(pi: ExtensionAPI): void {
	pi.appendEntry(MARKER_TYPE, { consumed: true, at: Date.now() });
}

async function announce(pi: ExtensionAPI, ctx: ExtensionContext, marker: Marker): Promise<void> {
	try {
		const reason = marker.reason ? `Reason was: ${marker.reason}.` : "No reason was recorded.";
		const text = `Harness restart completed (${new Date(marker.at).toISOString()}). ${reason} Continue what you were doing.`;
		await pi.sendUserMessage(text, { attribution: "agent" });
		const pending = pendingMarker(ctx);
		if (pending?.at === marker.at && pending.reason === marker.reason) consume(pi);
	} catch (error) {
		pi.logger.warn("harness-restart: completion notice failed", { error: errorText(error) });
	}
}

async function relaunch(pi: ExtensionAPI, ctx: ExtensionContext, marker: Marker): Promise<string> {
	const live = captureInteractiveMode(ctx);
	if (live.kind !== "ok") return `it did not run: ${captureFailureText(live)}`;
	pi.appendEntry(MARKER_TYPE, marker);
	try {
		ctx.ui.notify(tr("Restarting omp…", "正在重启 omp…"), "info");
		await live.mode.restart();
		return "InteractiveMode.restart() returned without relaunching omp.";
	} catch (error) {
		return errorText(error);
	} finally {
		// Every path that does not relaunch must consume the marker, or the next start reports a restart that never happened.
		consume(pi);
	}
}

async function execute(runtime: Runtime, ctx: ExtensionContext, marker: Marker): Promise<void> {
	runtime.state = { kind: "running", marker };
	let failure: string;
	try {
		failure = await relaunch(runtime.pi, ctx, marker);
	} catch (error) {
		failure = errorText(error);
	}
	runtime.state = { kind: "idle" };
	runtime.pi.logger.warn("harness-restart: queued restart failed", { error: failure });
	void runtime.pi
		.sendUserMessage(`The queued harness restart failed: ${failure}`, { attribution: "agent" })
		.catch((error: unknown) => runtime.pi.logger.warn("harness-restart: failure notice not delivered", { error: errorText(error) }));
}

function arm(runtime: Runtime, ctx: ExtensionContext, marker: Marker): void {
	const tick = (): void => {
		if (runtime.state.kind !== "armed" || runtime.state.marker !== marker) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			runtime.state = { kind: "armed", marker, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
			return;
		}
		void execute(runtime, ctx, marker);
	};
	runtime.state = { kind: "armed", marker, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
}

function disarm(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "armed") return;
	ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "queued", marker: runtime.state.marker };
}

function reset(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind === "armed") ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "idle" };
}

async function activate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main") return;
	const marker = pendingMarker(ctx);
	if (marker !== undefined) void announce(pi, ctx, marker);
	if (ctx.mode !== "tui") return;
	const active = pi.getActiveTools();
	if (!active.includes(TOOL)) await applyActiveTools(pi, [...active, TOOL]);
}

function blocker(runtime: Runtime, ctx: ExtensionContext): string | undefined {
	if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return `${TOOL}: only the main session of the interactive TUI can use this tool.`;
	switch (runtime.state.kind) {
		case "idle":
			break;
		case "armed":
		case "queued":
		case "running":
			return `${TOOL}: a harness restart is already queued for the end of this turn; end your turn.`;
		default: {
			const unreachable: never = runtime.state;
			throw new Error(`Unexpected harness-restart state: ${String(unreachable)}`);
		}
	}
	const live = captureInteractiveMode(ctx);
	if (live.kind !== "ok") return `${TOOL}: ${captureFailureText(live)}`;
	if (live.mode.collabGuest) return `${TOOL}: restarts are host-only during a collab session.`;
	return undefined;
}

function restart(runtime: Runtime, ctx: ExtensionContext, reason: string | undefined): AgentToolResult<undefined> {
	const blocked = blocker(runtime, ctx);
	if (blocked !== undefined) return { content: [{ type: "text", text: blocked }], isError: true };
	runtime.state = { kind: "queued", marker: { reason: reason?.trim() ?? "", at: Date.now() } };
	return {
		content: [
			{
				type: "text",
				text: "Queued: the omp harness restarts once this turn ends. End your turn now without further tool calls; after the restart the session opens with a restart-completed message.",
			},
		],
	};
}

function onAgentEnd(runtime: Runtime, event: AgentEndEvent, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "queued") return;
	if (event.willContinue && !event.awaitingAsyncWork) return;
	const marker = runtime.state.marker;
	const last = event.messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant" || last.stopReason !== "aborted" || !isUserInterruptAbort(last)) {
		arm(runtime, ctx, marker);
		return;
	}
	runtime.state = { kind: "idle" };
	ctx.ui.notify(tr("Queued harness restart cancelled: the turn was interrupted.", "已取消排队的 Harness 重启：本轮被中断。"), "info");
	runtime.pi.sendMessage(
		{
			customType: NOTICE_TYPE,
			content: "The queued harness restart was cancelled because the user interrupted the turn; nothing changed.",
			display: false,
			attribution: "agent",
		},
		{ deliverAs: "nextTurn" },
	);
}

async function guardHook(pi: ExtensionAPI, label: string, handler: () => void | Promise<void>): Promise<void> {
	try {
		await handler();
	} catch (error) {
		pi.logger.warn(`harness-restart: ${label} hook failed`, { error: errorText(error) });
	}
}

export default function harnessRestart(pi: ExtensionAPI): void {
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
	pi.registerTool(
		omompTool({
			name: TOOL,
			label: tr("Harness Restart", "重启 Harness"),
			description: DESCRIPTION,
			approval: "exec",
			loadMode: "essential",
			defaultInactive: true,
			parameters: params,
			async execute(_toolCallId, toolParams: z.infer<typeof params>, _signal, _onUpdate, ctx) {
				try {
					return restart(runtime, ctx, toolParams.reason);
				} catch (error) {
					pi.logger.warn("harness-restart: tool failed", { error: errorText(error) });
					return { content: [{ type: "text", text: errorText(error) }], isError: true };
				}
			},
		}),
	);
}
