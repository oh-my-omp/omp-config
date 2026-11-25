import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// Relies on omp internals (InteractiveMode's prototype, the extension UI context forwarding
// `setToolsExpanded` to it); re-verify in a real TUI after every omp upgrade.

export type InteractiveModeFailure =
	| { readonly kind: "missing-setToolsExpanded" }
	| { readonly kind: "unreachable" }
	| { readonly kind: "other-session" };

export type InteractiveModeCapture = { readonly kind: "ok"; readonly mode: InteractiveModeContext } | InteractiveModeFailure;

export function captureInteractiveMode(ctx: ExtensionContext): InteractiveModeCapture {
	const proto = InteractiveMode.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, "setToolsExpanded");
	if (typeof original?.value !== "function") {
		return { kind: "missing-setToolsExpanded" };
	}
	let captured: InteractiveMode | undefined;
	Object.defineProperty(proto, "setToolsExpanded", {
		...original,
		value: function (this: InteractiveMode): void {
			captured = this;
		},
	});
	try {
		ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
	} finally {
		Object.defineProperty(proto, "setToolsExpanded", original);
	}
	if (!(captured instanceof InteractiveMode)) {
		return { kind: "unreachable" };
	}
	const mode: InteractiveModeContext = captured;
	if (mode.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
		return { kind: "other-session" };
	}
	return { kind: "ok", mode };
}
