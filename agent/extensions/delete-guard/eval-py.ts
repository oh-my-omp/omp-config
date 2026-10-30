import { isOp, type PyLaunch, type PyScan, pyLaunchAt, scanPy } from "../_shared/eval-py-launches.ts";
import { classify } from "./classify.ts";
import { ALLOW, type Dialect, type Rule, type Verdict } from "./verdict.ts";

/** API names only filesystem deletion uses: blocked wherever code names them, so aliases from earlier cells are caught too. */
const DISTINCTIVE_DELETE: ReadonlySet<string> = new Set(["rmtree", "removedirs", "unlink", "rmdir"]);

type Context = {
	readonly code: string;
	readonly scan: PyScan;
	readonly shell: Dialect;
	readonly brush: Dialect;
};

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

/** The source line holding offset `at`, for the reason. */
function lineAt(code: string, at: number): string {
	const start = code.lastIndexOf("\n", at - 1) + 1;
	const end = code.indexOf("\n", at);
	return code.slice(start, end === -1 ? code.length : end).trim();
}

/** Every launch is judged whatever its binding; a command that is not literal blocks. */
function judgeLaunch(ctx: Context, launch: PyLaunch, fragment: string): Verdict {
	const nonLiteral = (what: string): Verdict => block("nonLiteral", fragment, `${what} is not a literal string`);
	switch (launch.kind) {
		case "bridge":
			return launch.command === null
				? nonLiteral("the bash bridge command")
				: classify(ctx.brush, { kind: "script", text: launch.command }, 1);
		case "script":
			return launch.text === null
				? nonLiteral("the command handed to a shell")
				: classify(ctx.shell, { kind: "script", text: launch.text }, 1);
		case "argv":
			return launch.words === null ? nonLiteral("the command") : classify(ctx.brush, { kind: "argv", words: launch.words }, 1);
		default: {
			const unreachable: never = launch;
			return unreachable;
		}
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
		// `os.remove` under any local name (`from os import remove as erase`), or `.remove` on `os` or an alias of it.
		if (!declares && !isOp(previous, ".") && bindings.members.get(token.value) === "os.remove")
			return block("delete", lineAt(ctx.code, token.start), `\`${token.value}\` is \`os.remove\`, which deletes files`);
		if (token.value === "remove" && !declares && isOp(previous, ".")) {
			const receiver = tokens[k - 2];
			if (receiver?.kind === "name" && (receiver.value === "os" || bindings.modules.get(receiver.value) === "os"))
				return block("delete", lineAt(ctx.code, token.start), "`os.remove` deletes files");
		}
		const launch = pyLaunchAt(ctx.scan, k);
		if (launch !== null) {
			const verdict = judgeLaunch(ctx, launch, lineAt(ctx.code, token.start));
			if (verdict.kind === "block") return verdict;
		}
	}
	return ALLOW;
}

/**
 * Classifies a py eval cell: filesystem deletion APIs block, and every command
 * handed to a shell or launched is classified — `subprocess`/`os`/`asyncio`
 * launches, `!cmd` and `%%bash` (rewritten by the kernel into shell calls), and
 * the `tool.bash` bridge. `%time`/`%timeit` arguments, `%%capture`/`%%timeit`
 * bodies and f-string placeholders are classified as Python. Text that cannot
 * be tokenized (unterminated string or bracket) is blocked: it cannot run.
 */
export function classifyPy(code: string, shell: Dialect, brush: Dialect, depth = 0): Verdict {
	const scanned = scanPy(code);
	if (scanned.kind === "unlexable") return block("nonLiteral", code, `the cell cannot be tokenized (${scanned.reason})`);
	const { scan } = scanned;
	for (const script of scan.shellScripts) {
		const verdict = classify(shell, { kind: "script", text: script }, 1);
		if (verdict.kind === "block") return verdict;
	}
	const verdict = judgeTokens({ code, scan, shell, brush });
	if (verdict.kind === "block") return verdict;
	if (depth >= 8)
		return scan.pythonSnippets.length > 0
			? block("nonLiteral", code, "Python code nested more than 8 levels deep is not classified")
			: ALLOW;
	for (const snippet of scan.pythonSnippets) {
		const nested = classifyPy(snippet, shell, brush, depth + 1);
		if (nested.kind === "block") return nested;
	}
	return ALLOW;
}
