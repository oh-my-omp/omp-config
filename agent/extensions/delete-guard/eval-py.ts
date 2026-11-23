import { isOp, type PyLaunch, type PyScan, pyLaunchAt, scanPy } from "../_shared/eval-py-launches.ts";
import { classifyScript } from "./classify.ts";
import { classifyPosix, classifyPosixArgv } from "./posix.ts";
import { ALLOW, absurd, block, type Dialect, MAX_DEPTH, type Verdict } from "./verdict.ts";

const DISTINCTIVE_DELETE: ReadonlySet<string> = new Set(["rmtree", "removedirs", "unlink", "rmdir"]);

type Context = {
	readonly code: string;
	readonly scan: PyScan;
	readonly shell: Dialect;
	readonly depth: number;
};

function lineAt(code: string, at: number): string {
	const start = code.lastIndexOf("\n", at - 1) + 1;
	const end = code.indexOf("\n", at);
	return code.slice(start, end === -1 ? code.length : end).trim();
}

function judgeLaunch(ctx: Context, launch: PyLaunch, at: number): Verdict {
	const nonLiteral = (what: string): Verdict => block("nonLiteral", lineAt(ctx.code, at), `${what} is not a literal string`);
	const depth = ctx.depth + 1;
	switch (launch.kind) {
		case "bridge":
			return launch.command === null ? nonLiteral("the bash bridge command") : classifyPosix(launch.command, depth);
		case "script":
			return launch.text === null ? nonLiteral("the command handed to a shell") : classifyScript(ctx.shell, launch.text, depth);
		case "shellHelper":
			return launch.text === null ? nonLiteral("the command handed to `sh`") : classifyPosix(launch.text, depth);
		case "argv":
			return launch.words === null ? nonLiteral("the command") : classifyPosixArgv(launch.words, depth);
		case "execEval":
			return launch.code === null ? nonLiteral(`the code given to \`${launch.api}\``) : classifyPy(launch.code, ctx.shell, depth);
		case "opaque":
			return nonLiteral(`the module loaded by \`${launch.api}\``);
		default:
			return absurd(launch);
	}
}

function judgeTokens(ctx: Context): Verdict {
	const { tokens, bindings } = ctx.scan;
	for (let k = 0; k < tokens.length; k++) {
		const token = tokens[k];
		if (token?.kind !== "name") continue;
		const previous = tokens[k - 1];
		const next = tokens[k + 1];
		const declares = previous?.kind === "name" && (previous.value === "def" || previous.value === "class");
		const assignedTo = isOp(next, "=");
		if (DISTINCTIVE_DELETE.has(token.value) && !declares && !assignedTo)
			return block("delete", lineAt(ctx.code, token.start), `\`${token.value}\` deletes files`);
		if (!declares && !isOp(previous, ".") && bindings.members.get(token.value) === "os.remove")
			return block("delete", lineAt(ctx.code, token.start), `\`${token.value}\` is \`os.remove\`, which deletes files`);
		if (token.value === "remove" && !declares && isOp(previous, ".")) {
			const receiver = tokens[k - 2];
			if (receiver?.kind === "name" && (receiver.value === "os" || bindings.modules.get(receiver.value) === "os"))
				return block("delete", lineAt(ctx.code, token.start), "`os.remove` deletes files");
		}
		const launch = pyLaunchAt(ctx.scan, k);
		if (launch !== null) {
			const verdict = judgeLaunch(ctx, launch, token.start);
			if (verdict.kind === "block") return verdict;
		}
	}
	return ALLOW;
}

export function classifyPy(code: string, shell: Dialect, depth = 0): Verdict {
	const scanned = scanPy(code);
	if (scanned.kind === "unlexable") return block("nonLiteral", code, `the cell cannot be tokenized (${scanned.reason})`);
	const { scan } = scanned;
	for (const script of scan.shellScripts) {
		const verdict = classifyScript(shell, script, depth + 1);
		if (verdict.kind === "block") return verdict;
	}
	const verdict = judgeTokens({ code, scan, shell, depth });
	if (verdict.kind === "block") return verdict;
	for (const snippet of scan.pythonSnippets) {
		if (depth >= MAX_DEPTH) return block("nonLiteral", code, `Python code nested more than ${MAX_DEPTH} levels deep is not classified`);
		const nested = classifyPy(snippet, shell, depth + 1);
		if (nested.kind === "block") return nested;
	}
	return ALLOW;
}
