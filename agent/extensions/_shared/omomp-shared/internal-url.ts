// `registerInternalScheme` stamps the brand on the passed handler object with
// `Object.defineProperty`, so the handler must be extensible (not frozen).
import type { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";

export type SchemeHolder = { readonly kind: "owner"; readonly id: string } | { readonly kind: "unbranded" };

export type RegisterSchemeResult =
	| { readonly kind: "registered" }
	| { readonly kind: "builtin"; readonly reason: string }
	| { readonly kind: "held"; readonly holder: SchemeHolder; readonly reason: string };

export function registerInternalScheme(router: InternalUrlRouter, owner: string, handler: ProtocolHandler): RegisterSchemeResult {
	const ownerBrand = Symbol.for("omomp-shared/internal-url");
	const scheme = handler.scheme;
	if (router.isBuiltin(scheme)) return { kind: "builtin", reason: `omp owns ${scheme}://` };
	const existing = router.getHandler(scheme);
	if (existing !== undefined) {
		const holder: unknown = Reflect.get(existing, ownerBrand);
		if (typeof holder !== "string") {
			return { kind: "held", holder: { kind: "unbranded" }, reason: `a handler with no owner already holds ${scheme}://` };
		}
		if (holder !== owner) {
			return { kind: "held", holder: { kind: "owner", id: holder }, reason: `${holder} already holds ${scheme}://` };
		}
	}
	Object.defineProperty(handler, ownerBrand, { value: owner, enumerable: false, writable: false, configurable: false });
	router.register(handler);
	const ordered = [...router.specs().keys()].filter((registeredScheme) => !router.isBuiltin(registeredScheme)).sort();
	for (const registeredScheme of ordered) {
		const registeredHandler = router.getHandler(registeredScheme);
		if (!registeredHandler) continue;
		router.unregister(registeredScheme);
		router.register(registeredHandler);
	}
	return { kind: "registered" };
}
