import { classifyCmd } from "./cmd.ts";
import { classifyPosix, classifyPosixArgv } from "./posix.ts";
import { classifyPowershell } from "./powershell.ts";
import type { Dialect, Verdict } from "./verdict.ts";

export type ArgvWord = { readonly text: string; readonly literal: boolean };

type CommandInput = { readonly kind: "script"; readonly text: string } | { readonly kind: "argv"; readonly words: readonly ArgvWord[] };

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
