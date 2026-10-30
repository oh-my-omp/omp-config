/** The shell language a command text is written in; #69 adds `powershell` and `cmd`. */
export type Dialect = { readonly kind: "posix" };

/** `delete`: a deletion command. `nonLiteral`: what runs cannot be read from the text. */
export type Rule = "delete" | "nonLiteral";

export type Verdict =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly rule: Rule; readonly fragment: string; readonly detail: string };

export const ALLOW: Verdict = { kind: "allow" };

/** Nested shells, `eval`, `trap` and `alias` bodies deeper than this are blocked as non-literal. */
export const MAX_DEPTH = 8;
