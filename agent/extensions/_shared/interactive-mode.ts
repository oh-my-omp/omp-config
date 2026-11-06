import { type ExtensionContext, InteractiveMode } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// The extension API has no handle on the live InteractiveMode. `ctx.ui.setEditorComponent`
// in the TUI forwards to `InteractiveMode#setEditorComponent` with the live instance as
// `this`, so the prototype method is swapped for a recorder for that one synchronous call
// and restored before anything else runs; the real editor swap never happens. This is the
// only place that touches the host mechanism; callers own the wording of each failure.
//
// Relies on omp internals (InteractiveMode's prototype, the extension UI context forwarding);
// re-verify in a real TUI after every omp upgrade.

export type InteractiveModeFailure =
	| { readonly kind: "missing-setEditorComponent" }
	| { readonly kind: "unreachable" }
	| { readonly kind: "other-session" };

export type InteractiveModeCapture = { readonly kind: "ok"; readonly mode: InteractiveModeContext } | InteractiveModeFailure;

export function captureInteractiveMode(ctx: ExtensionContext): InteractiveModeCapture {
	const proto = InteractiveMode.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, "setEditorComponent");
	if (typeof original?.value !== "function") {
		return { kind: "missing-setEditorComponent" };
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
		return { kind: "unreachable" };
	}
	// The host hides its runtime structural context behind private members; instanceof proves the live instance.
	const mode = captured as unknown as InteractiveModeContext;
	if (mode.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
		return { kind: "other-session" };
	}
	return { kind: "ok", mode };
}
