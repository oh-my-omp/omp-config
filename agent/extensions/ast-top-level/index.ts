// The pin is process-wide and never undone: disabling this extension only takes effect after an omp restart.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isMountableAsToolCommand, TOOL_COMMAND_KEEP_TOP_LEVEL } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { applyActiveTools } from "../_shared/omomp-shared/active-tools.ts";

const TOOLS = ["ast_grep", "ast_edit"] as const;

type Pin =
	| { readonly kind: "pinned" }
	| { readonly kind: "rejected"; readonly error: string }
	| { readonly kind: "ignored"; readonly mounted: readonly string[] };

function pinTopLevel(): Pin {
	try {
		for (const name of TOOLS) TOOL_COMMAND_KEEP_TOP_LEVEL[name] = true;
	} catch (error) {
		return { kind: "rejected", error: errorText(error) };
	}
	const mounted = TOOLS.filter((name) => isMountableAsToolCommand({ name, loadMode: "discoverable" }));
	return mounted.length === 0 ? { kind: "pinned" } : { kind: "ignored", mounted };
}

function failureNotice(pin: Exclude<Pin, { kind: "pinned" }>): string {
	switch (pin.kind) {
		case "rejected":
			return tr(
				`ast-top-level: OMP rejected the top-level pin (${pin.error}); ast_grep/ast_edit stay bash tool commands`,
				`ast-top-level：OMP 拒绝了置顶写入（${pin.error}），ast_grep/ast_edit 仍是 bash 里的 tool command`,
			);
		case "ignored": {
			const tools = pin.mounted.join("/");
			return tr(
				`ast-top-level: OMP no longer honors the top-level pin; ${tools} stay bash tool commands`,
				`ast-top-level：OMP 不再读取置顶表，${tools} 仍是 bash 里的 tool command`,
			);
		}
		default: {
			const unreachable: never = pin;
			return unreachable;
		}
	}
}

export default function astTopLevel(pi: ExtensionAPI): void {
	const pin = pinTopLevel();
	if (pin.kind !== "pinned") pi.logger.warn("ast-top-level: ast_grep/ast_edit stay bash tool commands", { pin });

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (pin.kind !== "pinned") {
				if (ctx.agent.kind === "main" && ctx.hasUI) ctx.ui.notify(failureNotice(pin), "warning");
				return;
			}
			const active = pi.getActiveTools();
			if (TOOLS.some((name) => active.includes(name))) await applyActiveTools(pi, active);
		} catch (error) {
			pi.logger.warn("ast-top-level: session_start failed", { error: errorText(error) });
		}
	});
}
