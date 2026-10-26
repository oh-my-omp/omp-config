// ============================================================================
// harness-restart — expose the human's /restart to the agent as `harness_restart`.
//
// The tool queues the human's own `/restart` (TUI `InteractiveMode.restart()`:
// same launch flags, session resumed from disk) instead of reimplementing it.
// `/restart` refuses while streaming, and a tool call always runs while
// streaming, so the call only queues the request; a terminal `agent_end` (not
// `willContinue`) starts an idle poll and runs it once the session is idle
// with no queued messages. `agent_start` disarms the poll back to queued; a
// terminal end interrupted by the user (Esc) cancels; session switch and
// shutdown drop the request. This mirrors `wt-tool`'s queue/arm shape.
//
// The restart is process-wide, so the tool result never reaches the caller:
// just before restarting, the request (reason, timestamp) is appended as a
// durable `custom` session entry. On `session_start` the extension scans the
// branch for a pending marker and injects it as an attributed user message,
// so the restarted session opens with "restart completed: <reason>".
//
// TUI-main-only. Hook failures are logged without escaping into omp.
// ============================================================================
// TUI-main-only tool harness_restart; hooks: session_start/switch/shutdown, agent_start/end.
// Reads the live InteractiveMode; writes one durable custom session entry per restart.
// No extension config files. Failures are returned to the agent; hook failures are logged.
import { type AgentEndEvent, type ExtensionAPI, type ExtensionContext, InteractiveMode, z } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

const TOOL = "harness_restart";
const ENTRY_TYPE = "mouriya.omp.harness-restart.request";
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
type Request = { readonly sessionId: string; readonly marker: Marker };
type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly request: Request }
	| { readonly kind: "armed"; readonly request: Request; readonly timer: Timer }
	| { readonly kind: "running"; readonly request: Request };

type Runtime = { readonly pi: ExtensionAPI; state: State };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const markerSchema = z.object({ reason: z.string(), at: z.number() }).passthrough();
const consumedSchema = z.object({ consumed: z.literal(true) }).passthrough();

function reset(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind === "armed") ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "idle" };
}

/** Live InteractiveMode behind ctx.ui, read through one recorded setEditorComponent call. */
function capture(ctx: ExtensionContext): { kind: "ok"; mode: InteractiveModeContext } | { kind: "error"; reason: string } {
	const proto = InteractiveMode.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, "setEditorComponent");
	if (typeof original?.value !== "function") {
		return { kind: "error", reason: "InteractiveMode.prototype.setEditorComponent is missing (omp internals changed)." };
	}
	let captured: unknown;
	Object.defineProperty(proto, "setEditorComponent", {
		...original,
		value: function (this: unknown): void {
			captured = this;
		},
	});
	try {
		ctx.ui.setEditorComponent(undefined);
	} finally {
		Object.defineProperty(proto, "setEditorComponent", original);
	}
	if (!(captured instanceof InteractiveMode)) {
		return { kind: "error", reason: "the interactive TUI instance is not reachable from this session." };
	}
	// Unchecked: the host hides the live instance behind a private member; instanceof already proved it.
	const mode = captured as unknown as InteractiveModeContext;
	if (mode.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
		return { kind: "error", reason: "the interactive TUI is attached to a different session." };
	}
	return { kind: "ok", mode };
}

function pendingMarker(ctx: ExtensionContext): Marker | undefined {
	let found: Marker | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
			found = undefined;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !("data" in entry)) continue;
		if (consumedSchema.safeParse(entry.data).success) {
			found = undefined;
			continue;
		}
		const parsed = markerSchema.safeParse(entry.data);
		if (parsed.success) found = { reason: parsed.data.reason.trim(), at: parsed.data.at };
	}
	return found;
}

async function execute(runtime: Runtime, ctx: ExtensionContext, request: Request): Promise<void> {
	runtime.state = { kind: "running", request };
	try {
		if (ctx.sessionManager.getSessionId() !== request.sessionId) return;
		const live = capture(ctx);
		if (live.kind === "error") {
			runtime.pi.logger.warn("harness-restart: queued restart not run", { reason: live.reason });
			runtime.pi.sendUserMessage(`The queued harness restart did not run: ${live.reason}`, { attribution: "agent" });
			return;
		}
		runtime.pi.appendEntry(ENTRY_TYPE, request.marker);
		if (ctx.hasUI) ctx.ui.notify(tr("Restarting omp…", "正在重启 omp…"), "info");
		await live.mode.restart();
	} catch (error) {
		runtime.pi.logger.warn("harness-restart: restart failed", { error: errorText(error) });
		runtime.pi.sendUserMessage(`The queued harness restart failed: ${errorText(error)}`, { attribution: "agent" });
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
	if (ctx.agent.kind === "main") {
		const marker = pendingMarker(ctx);
		if (marker !== undefined) {
			const when = Number.isFinite(marker.at) ? new Date(marker.at).toISOString() : "unknown time";
			pi.sendUserMessage(
				`Harness restart completed (${when}). ${marker.reason ? `Reason was: ${marker.reason}.` : "No reason was recorded."} Continue what you were doing.`,
				{ attribution: "agent" },
			);
			pi.appendEntry(ENTRY_TYPE, { consumed: true, at: Date.now() });
		}
	}
	if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
	const active = pi.getActiveTools();
	if (active.includes(TOOL)) return;
	await pi.setActiveTools([...active, TOOL]);
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
	const live = capture(ctx);
	if (live.kind === "error") return `${TOOL}: ${live.reason}`;
	if (live.mode.collabGuest) return `${TOOL}: restarts are host-only during a collab session.`;
	return undefined;
}

async function restart(runtime: Runtime, ctx: ExtensionContext, rawParams: unknown): Promise<ToolResult> {
	const blocked = blocker(runtime, ctx);
	if (blocked !== undefined) return { content: [{ type: "text", text: blocked }], isError: true };
	const reason = params.parse(rawParams).reason?.trim() ?? "";
	const marker: Marker = { reason, at: Date.now() };
	runtime.state = { kind: "queued", request: { sessionId: ctx.sessionManager.getSessionId(), marker } };
	return {
		content: [
			{
				type: "text",
				text: "Queued: the omp harness restarts once this turn ends. End your turn now without further tool calls; after the restart the session opens with a restart-completed message.",
			},
		],
	};
}

function disarm(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "armed") return;
	ctx.clearTimer(runtime.state.timer);
	runtime.state = { kind: "queued", request: runtime.state.request };
}

function onAgentEnd(runtime: Runtime, event: AgentEndEvent, ctx: ExtensionContext): void {
	if (runtime.state.kind !== "queued" || event.willContinue === true) return;
	const request = runtime.state.request;
	const last = event.messages.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "aborted" && isUserInterruptAbort(last)) {
		runtime.state = { kind: "idle" };
		ctx.ui.notify(tr("Queued harness restart cancelled: the turn was interrupted.", "已取消排队的 Harness 重启：本轮被中断。"), "info");
		runtime.pi.sendUserMessage("The queued harness restart was cancelled because the user interrupted the turn; nothing changed.", {
			attribution: "agent",
		});
		return;
	}
	arm(runtime, ctx, request);
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
	pi.registerTool({
		name: TOOL,
		label: tr("Harness Restart", "重启 Harness"),
		description: DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: params,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			try {
				return await restart(runtime, ctx, rawParams);
			} catch (error) {
				pi.logger.warn("harness-restart: tool failed", { error: errorText(error) });
				return { content: [{ type: "text", text: errorText(error) }], isError: true };
			}
		},
	});
}
