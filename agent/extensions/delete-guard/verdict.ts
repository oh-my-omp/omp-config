export type Dialect = { readonly kind: "posix" } | { readonly kind: "powershell" } | { readonly kind: "cmd" };

export type Rule = "delete" | "nonLiteral";

export type Verdict =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly rule: Rule; readonly fragment: string; readonly detail: string };

export const ALLOW: Verdict = { kind: "allow" };

export type Fragment = string | { readonly src: string; readonly start: number; readonly end: number };

export const block = (rule: Rule, fragment: Fragment, detail: string): Verdict => ({
	kind: "block",
	rule,
	fragment: typeof fragment === "string" ? fragment : fragment.src.slice(fragment.start, fragment.end).trim(),
	detail,
});

export const MAX_DEPTH = 8;

export const tooDeep = (fragment: Fragment): Verdict =>
	block("nonLiteral", fragment, `scripts nested more than ${MAX_DEPTH} levels deep are not classified`);

export const AMBIGUITY_BUDGET = 4;

export const absurd = (value: never): never => value;

export const SYSTEM_SHELL: Dialect = process.platform === "win32" ? { kind: "cmd" } : { kind: "posix" };
