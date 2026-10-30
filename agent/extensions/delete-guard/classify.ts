import { classifyPosix } from "./posix.ts";
import type { Dialect, Verdict } from "./verdict.ts";

/** Classifies command text written in `dialect`; `depth` counts enclosing nested scripts. */
export function classify(dialect: Dialect, text: string, depth: number): Verdict {
	switch (dialect.kind) {
		case "posix":
			return classifyPosix(text, depth);
		default: {
			const unreachable: never = dialect.kind;
			return unreachable;
		}
	}
}
