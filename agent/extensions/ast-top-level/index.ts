// ============================================================================
// ast-top-level — keep OMP's built-in `ast_grep` and `ast_edit` as top-level
// function tools instead of `xd://` devices.
//
// WHY. With `tools.xdev` on, OMP mounts every enabled tool whose `loadMode` is
// "discoverable" (both AST tools are) under `xd://`, reached by writing JSON
// to `xd://<tool>`, unless its name is in the host's process-wide
// `XDEV_KEEP_TOP_LEVEL` table. Every partition (session build,
// `setActiveTools`, settings reconcile, MCP refresh, plan mode, late tool
// registration, subagent sessions) asks `isMountableUnderXdev`, which reads
// that table on each call. No setting pins a single tool.
//
// HOW. At load the extension adds both names to the table and checks that
// `isMountableUnderXdev` now keeps them top-level. The host still owns the
// tool instances, their settings gates (`astGrep.enabled`, `astEdit.enabled`)
// and `ast_edit`'s preview; applying a preview still goes through
// `xd://resolve`.
//
// LATE BINDING. OMP may bind an extension that registers nothing needed
// before the first frame after the session already partitioned its tools
// (startup deferral), and a table change alone does not re-partition. So on
// `session_start`, which OMP replays to late-bound extensions, a session that
// has either tool re-applies its own active set once in registration order,
// re-partitioning it against the table. New and resumed sessions then list
// the tools in the same order, whenever the table took effect.
//
// LIFETIME. The table is process-wide and outlives the extension: disabling
// the extension takes effect after a restart.
//
// Relies on OMP internals (`@oh-my-pi/pi-coding-agent/tools/xdev`:
// `XDEV_KEEP_TOP_LEVEL`, `isMountableUnderXdev`); re-verify after every OMP
// upgrade.
// ============================================================================
// Hook: session_start (main and sub, full and light). No tools, commands or files.
// FAILURE. A renamed export fails the load. A table that rejects the names or
// is no longer consulted is logged at load and shown on each main session
// start; the tools then stay devices. Hook failures are logged without
// escaping into omp.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isMountableUnderXdev, XDEV_KEEP_TOP_LEVEL } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { applyActiveTools } from "../_shared/active-tools.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

const TOOLS = ["ast_grep", "ast_edit"] as const;

type Pin = { readonly kind: "pinned" } | { readonly kind: "failed"; readonly reason: string };

/** Adds the AST tools to the host's keep-top-level table and checks the host now honors it. */
function pinTopLevel(): Pin {
	try {
		for (const name of TOOLS) XDEV_KEEP_TOP_LEVEL[name] = true;
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
	const mounted = TOOLS.filter((name) => isMountableUnderXdev({ name, loadMode: "discoverable" }));
	if (mounted.length === 0) return { kind: "pinned" };
	return { kind: "failed", reason: `OMP still mounts ${mounted.join(", ")} under xd://` };
}

export default function astTopLevel(pi: ExtensionAPI): void {
	const pin = pinTopLevel();
	if (pin.kind === "failed") pi.logger.warn(`ast-top-level: ${pin.reason}`);

	pi.on("session_start", async (_event, ctx) => {
		try {
			switch (pin.kind) {
				case "pinned": {
					const active = pi.getActiveTools();
					if (TOOLS.some((name) => active.includes(name))) await applyActiveTools(pi, active);
					return;
				}
				case "failed":
					if (ctx.agent.kind === "main" && ctx.hasUI)
						ctx.ui.notify(
							tr(
								`ast-top-level: ast_grep/ast_edit stay xd:// devices (${pin.reason})`,
								`ast-top-level：ast_grep/ast_edit 仍是 xd:// 设备（${pin.reason}）`,
							),
							"warning",
						);
					return;
				default: {
					const unreachable: never = pin;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("ast-top-level: session_start failed", { error: errorText(error) });
		}
	});
}
