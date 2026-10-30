import { classifyCmd } from "./cmd.ts";
import { classifyPosix, classifyPosixArgv } from "./posix.ts";
import { classifyPowershell } from "./powershell.ts";
import type { Dialect, Verdict } from "./verdict.ts";

/** One argv word; `literal` is false when its runtime text cannot be read from the source. */
export type ArgvWord = { readonly text: string; readonly literal: boolean };

/** What is handed to a shell: command text, or an argv list run without a shell. */
export type CommandInput =
	| { readonly kind: "script"; readonly text: string }
	| { readonly kind: "argv"; readonly words: readonly ArgvWord[] };

/**
 * Classifies a command input; `depth` counts enclosing nested scripts. An argv list runs without a shell, so
 * its program is resolved the same way in every dialect (`cmd`/`powershell` programs recurse into their dialect).
 */
export function classify(dialect: Dialect, input: CommandInput, depth: number): Verdict {
	switch (input.kind) {
		case "argv":
			return classifyPosixArgv(input.words, depth);
		case "script":
			break;
		default: {
			const unreachable: never = input;
			return unreachable;
		}
	}
	switch (dialect.kind) {
		case "posix":
			return classifyPosix(input.text, depth);
		case "powershell":
			return classifyPowershell(input.text, depth);
		case "cmd":
			return classifyCmd(input.text, depth);
		default: {
			const unreachable: never = dialect;
			return unreachable;
		}
	}
}
