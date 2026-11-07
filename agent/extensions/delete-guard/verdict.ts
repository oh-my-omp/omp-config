/** The shell language a command text is written in. */
export type Dialect = { readonly kind: "posix" } | { readonly kind: "powershell" } | { readonly kind: "cmd" };

/** `delete`: a deletion command. `nonLiteral`: what runs cannot be read from the text. */
export type Rule = "delete" | "nonLiteral";

export type Verdict =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly rule: Rule; readonly fragment: string; readonly detail: string };

export const ALLOW: Verdict = { kind: "allow" };

/**
 * The text a block reason quotes. A command passes its source range as `{ src, start, end }`; the text is copied
 * with the parser's `slice(...).trim()` only when a block is actually built.
 */
export type Fragment = string | { readonly src: string; readonly start: number; readonly end: number };

/** The text of a fragment, copied from its source range only at this point. */
export const fragmentText = (fragment: Fragment): string =>
	typeof fragment === "string" ? fragment : fragment.src.slice(fragment.start, fragment.end).trim();

/** Nested shells, `eval`, `trap` and `alias` bodies deeper than this are blocked as non-literal. */
export const MAX_DEPTH = 8;

/**
 * The shell an eval cell's `shell=True`, `os.system`, `!cmd` or `child_process.exec` string reaches: `/bin/sh` on
 * macOS and Linux, `cmd.exe` (`ComSpec`) on Windows. `%%bash`, `Bun.$`, `Bun.spawn` and `tool.bash` stay posix.
 */
export const SYSTEM_SHELL: Dialect = process.platform === "win32" ? { kind: "cmd" } : { kind: "posix" };

/** The bash tool runs omp's embedded pi-shell engine on every platform; it, `Bun.$`, `Bun.spawn` and the `tool.bash` bridge are posix. */
export const BRUSH: Dialect = { kind: "posix" };
