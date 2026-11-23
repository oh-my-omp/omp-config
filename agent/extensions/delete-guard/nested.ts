import type { ArgvWord } from "./classify.ts";
import { classifyCmd } from "./cmd.ts";
import { classifyInterpreter, interpreterKind } from "./interpreter.ts";
import { classifyPosixArgv } from "./posix.ts";
import type { StdinSource } from "./posix-parse.ts";
import { classifyPowershell } from "./powershell.ts";
import { ALLOW, absurd, block, type Fragment, MAX_DEPTH, tooDeep, type Verdict } from "./verdict.ts";

type ShellKind = "posix" | "powershell" | "cmd";

export function programName(text: string): string {
	const base = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1).toLowerCase();
	return base.endsWith(".exe") || base.endsWith(".com") ? base.slice(0, -4) : base;
}

export const SHELLS: ReadonlyMap<string, ShellKind> = new Map([
	["sh", "posix"],
	["bash", "posix"],
	["zsh", "posix"],
	["dash", "posix"],
	["ksh", "posix"],
	["powershell", "powershell"],
	["pwsh", "powershell"],
	["cmd", "cmd"],
]);

const PS_VALUE_PARAMS = [
	"executionpolicy",
	"windowstyle",
	"inputformat",
	"outputformat",
	"workingdirectory",
	"configurationname",
	"settingsfile",
	"custompipename",
];

function classifyPowershellInvocation(args: readonly ArgvWord[], depth: number, fragment: Fragment): Verdict {
	if (depth > MAX_DEPTH) return tooDeep(fragment);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (!arg.literal) return block("nonLiteral", fragment, "a PowerShell argument comes from an expansion");
		const text = arg.text;
		if (!text.startsWith("-") && !text.startsWith("/")) return scriptVerdict(args.slice(i), depth, fragment);
		const name = text.slice(1).toLowerCase();
		if (name.length === 0) return block("nonLiteral", fragment, "PowerShell reads its script from stdin");
		if (name === "e" || name === "ec" || (name.length >= 2 && "encodedcommand".startsWith(name))) {
			return block("nonLiteral", fragment, "`-EncodedCommand` hides the script");
		}
		if ("command".startsWith(name)) return scriptVerdict(args.slice(i + 1), depth, fragment);
		if ("file".startsWith(name)) return ALLOW;
		if (name === "ep" || name === "wd" || PS_VALUE_PARAMS.some((param) => param.startsWith(name))) i++;
	}
	return block("nonLiteral", fragment, "PowerShell has no script argument, so it reads its script from stdin");
}

function scriptVerdict(words: readonly ArgvWord[], depth: number, fragment: Fragment): Verdict {
	if (words.length === 0) return block("nonLiteral", fragment, "PowerShell `-Command` has no script");
	if (words.some((word) => !word.literal)) return block("nonLiteral", fragment, "the PowerShell script is not literal");
	const script = words.map((word) => word.text).join(" ");
	return script.trim() === "-"
		? block("nonLiteral", fragment, "PowerShell reads its script from stdin")
		: classifyPowershell(script, depth + 1);
}

function classifyCmdInvocation(args: readonly ArgvWord[], depth: number, fragment: Fragment): Verdict {
	if (depth > MAX_DEPTH) return tooDeep(fragment);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (!arg.literal) return block("nonLiteral", fragment, "a cmd argument comes from an expansion");
		const flag = arg.text.toLowerCase();
		if (flag === "/c" || flag === "/k" || flag === "/r") {
			const rest = args.slice(i + 1);
			if (rest.some((word) => !word.literal)) return block("nonLiteral", fragment, "the cmd command line is not literal");
			return classifyCmd(rest.map((word) => word.text).join(" "), depth + 1);
		}
		if (!flag.startsWith("/")) break;
	}
	return block("nonLiteral", fragment, "cmd has no `/c` or `/k` command line, so it reads commands from stdin");
}

function classifyShellInvocation(kind: ShellKind, name: ArgvWord, args: readonly ArgvWord[], depth: number, fragment: Fragment): Verdict {
	switch (kind) {
		case "posix":
			return classifyPosixArgv([name, ...args], depth);
		case "powershell":
			return classifyPowershellInvocation(args, depth, fragment);
		case "cmd":
			return classifyCmdInvocation(args, depth, fragment);
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

export function classifyNestedProgram(
	name: ArgvWord,
	args: readonly ArgvWord[],
	depth: number,
	fragment: Fragment,
	stdin: StdinSource | null,
): Verdict | null {
	const program = programName(name.text);
	const shell = SHELLS.get(program);
	if (shell !== undefined) return classifyShellInvocation(shell, name, args, depth, fragment);
	const interpreter = interpreterKind(program);
	if (interpreter !== null) return classifyInterpreter(interpreter, args, { depth, fragment, stdin });
	return null;
}
