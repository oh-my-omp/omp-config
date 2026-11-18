// Register a handler for an internal URL scheme (`<scheme>://`) on the host `InternalUrlRouter`,
// with ownership arbitration and a canonical scheme order. Every plugin carries its own copy of
// this file, so the owner of a registered scheme is stored on the handler object itself: a
// `Symbol.for("omomp-shared/internal-url")` property holding the owner id. `Symbol.for` reads the
// process-global symbol registry, which every module copy shares, so a copy loaded later (plugin
// reload, subagent, separate import) recognizes a handler another copy registered.
// Guarantees:
// - A host built-in scheme is never registered; refusal reports the reason.
// - A scheme held by another owner is never replaced; refusal reports that owner. A handler with no
//   brand (foreign code) is treated the same, reported as an unbranded holder.
// - The same owner registering again replaces its handler.
// - After a successful registration every non-built-in scheme is ordered by name, behind the
//   built-ins which keep the host's order; the result does not depend on plugin load timing.
// `registerInternalScheme` stamps the brand on the passed handler object with
// `Object.defineProperty`, so the handler must be extensible (not frozen).
import type { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";

/**
 * Who holds a scheme when {@link registerInternalScheme} refuses with `held`.
 * - `owner`: a handler registered through this file; `id` is the owner passed to it.
 * - `unbranded`: a handler foreign code registered without the ownership brand.
 */
export type SchemeHolder = { readonly kind: "owner"; readonly id: string } | { readonly kind: "unbranded" };

/**
 * Outcome of {@link registerInternalScheme}.
 * - `registered`: the handler now serves the scheme (fresh or replacing the same owner's handler).
 * - `builtin`: refused; the scheme belongs to the host. `reason` says why.
 * - `held`: refused; `holder` says who holds the scheme and `reason` says why.
 */
export type RegisterSchemeResult =
	| { readonly kind: "registered" }
	| { readonly kind: "builtin"; readonly reason: string }
	| { readonly kind: "held"; readonly holder: SchemeHolder; readonly reason: string };

/**
 * Register `handler` on `router` under `owner`, an id chosen by the caller to identify itself
 * (convention: `<package>/<component>`). Refuses without touching the router when the scheme is a
 * host built-in or is held by another owner. On success the brand is stamped on `handler` as a
 * non-enumerable read-only property (a frozen handler throws a TypeError), the handler is
 * registered, and every non-built-in scheme is moved behind the built-ins in name order.
 */
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
	// Canonical scheme order: built-ins keep the host order first; every other scheme sorts by name.
	// Re-registering in sorted order moves each entry to the tail (Map delete + set), so the
	// non-built-in segment ends up sorted no matter which plugin registered last. Only positions
	// change; handlers are untouched.
	const ordered = [...router.specs().keys()].filter((registeredScheme) => !router.isBuiltin(registeredScheme)).sort();
	for (const registeredScheme of ordered) {
		const registeredHandler = router.getHandler(registeredScheme);
		if (!registeredHandler) continue;
		router.unregister(registeredScheme);
		router.register(registeredHandler);
	}
	return { kind: "registered" };
}
