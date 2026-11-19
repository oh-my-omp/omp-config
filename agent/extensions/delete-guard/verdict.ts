export type Dialect = { readonly kind: "posix" } | { readonly kind: "powershell" } | { readonly kind: "cmd" };

export type Rule = "delete" | "nonLiteral";

export type Verdict =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly rule: Rule; readonly fragment: string; readonly detail: string };

export const ALLOW: Verdict = { kind: "allow" };

export type Fragment = string | { readonly src: string; readonly start: number; readonly end: number };

export const fragmentText = (fragment: Fragment): string =>
	typeof fragment === "string" ? fragment : fragment.src.slice(fragment.start, fragment.end).trim();

export const MAX_DEPTH = 8;

export const SYSTEM_SHELL: Dialect = process.platform === "win32" ? { kind: "cmd" } : { kind: "posix" };

export const BRUSH: Dialect = { kind: "posix" };
