// LIFETIME. The table is process-wide and outlives the extension: disabling
// the extension takes effect after a restart.
//
// Relies on OMP internals (`@oh-my-pi/pi-coding-agent` package root:
// `XDEV_KEEP_TOP_LEVEL`, `isMountableUnderXdev`); re-verify after every OMP
// upgrade.
import { type ExtensionAPI, isMountableUnderXdev, XDEV_KEEP_TOP_LEVEL } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { applyActiveTools } from "../_shared/omomp-shared/active-tools.ts";

const TOOLS = ["ast_grep", "ast_edit"] as const;

type Pin = { readonly kind: "pinned" } | { readonly kind: "failed"; readonly reason: string };

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
