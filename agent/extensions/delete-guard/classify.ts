import { classifyCmd } from "./cmd.ts";
import { classifyPosix } from "./posix.ts";
import { classifyPowershell } from "./powershell.ts";
import { absurd, type Dialect, type Verdict } from "./verdict.ts";

export type ArgvWord = { readonly text: string; readonly literal: boolean };

export function classifyScript(dialect: Dialect, text: string, depth: number): Verdict {
	switch (dialect.kind) {
		case "posix":
			return classifyPosix(text, depth);
		case "powershell":
			return classifyPowershell(text, depth);
		case "cmd":
			return classifyCmd(text, depth);
		default:
			return absurd(dialect);
	}
}
