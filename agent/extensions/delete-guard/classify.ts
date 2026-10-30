import { classifyPosix, classifyPosixArgv } from "./posix.ts";
import type { Dialect, Verdict } from "./verdict.ts";

/** One argv word; `literal` is false when its runtime text cannot be read from the source. */
export type ArgvWord = { readonly text: string; readonly literal: boolean };

/** What is handed to a shell: command text, or an argv list run without a shell. */
export type CommandInput =
	| { readonly kind: "script"; readonly text: string }
	| { readonly kind: "argv"; readonly words: readonly ArgvWord[] };

/** Classifies a command input in `dialect`; `depth` counts enclosing nested scripts. */
export function classify(dialect: Dialect, input: CommandInput, depth: number): Verdict {
	switch (dialect.kind) {
		case "posix":
			switch (input.kind) {
				case "script":
					return classifyPosix(input.text, depth);
				case "argv":
					return classifyPosixArgv(input.words, depth);
				default: {
					const unreachable: never = input;
					return unreachable;
				}
			}
		default: {
			const unreachable: never = dialect.kind;
			return unreachable;
		}
	}
}
