import type { Node } from "@babel/types";
import {
	isBunFile,
	type JsCell,
	type JsLaunch,
	jsLaunchOf,
	parseJs,
	propertyName,
	receiverModule,
	walk,
} from "../_shared/eval-js-launches.ts";
import { classify } from "./classify.ts";
import { ALLOW, type Dialect, type Rule, type Verdict } from "./verdict.ts";

/** API names only fs uses: blocked wherever code names them, so aliases made in earlier cells are caught too. */
const DISTINCTIVE_DELETE: ReadonlySet<string> = new Set(["rmSync", "unlinkSync", "rmdirSync", "unlink", "rmdir"]);

type Context = { readonly code: string; readonly bindings: JsCell["bindings"]; readonly shell: Dialect; readonly brush: Dialect };

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

/** Every launch is judged whatever its binding; a command that is not literal blocks. */
function judgeLaunch(launch: JsLaunch, fragment: string, ctx: Context): Verdict {
	const nonLiteral = (what: string): Verdict => block("nonLiteral", fragment, `${what} is not a literal string`);
	switch (launch.kind) {
		case "childScript":
			return launch.text === null
				? nonLiteral("the command handed to a shell")
				: classify(ctx.shell, { kind: "script", text: launch.text }, 1);
		case "childSpawn": {
			const words = launch.words;
			if (words === null) return nonLiteral("the argument list");
			if (launch.shell) {
				if (words.some((word) => !word.literal)) return nonLiteral("the command handed to a shell");
				return classify(ctx.shell, { kind: "script", text: words.map((word) => word.text).join(" ") }, 1);
			}
			return classify(ctx.brush, { kind: "argv", words }, 1);
		}
		case "bunSpawn":
			return launch.words === null ? nonLiteral("the command list") : classify(ctx.brush, { kind: "argv", words: launch.words }, 1);
		case "bunShell":
			return launch.text === null
				? block("nonLiteral", fragment, "the `Bun.$` template interpolates values, so it is not a literal command")
				: classify(ctx.brush, { kind: "script", text: launch.text }, 1);
		case "bridge":
			if (launch.command !== null) return classify(ctx.brush, { kind: "script", text: launch.command }, 1);
			return nonLiteral(launch.source === "bash" ? "the bash bridge command" : "the xd://bash payload");
		default: {
			const unreachable: never = launch;
			return unreachable;
		}
	}
}

/** Whether a name in this position refers to something, rather than declaring a property or method key. */
function isReference(node: Node, parent: Node | null): boolean {
	if (parent === null) return true;
	if (
		(parent.type === "ObjectProperty" ||
			parent.type === "ObjectMethod" ||
			parent.type === "ClassMethod" ||
			parent.type === "ClassProperty") &&
		parent.key === node &&
		!parent.computed
	) {
		return false;
	}
	return !(
		(parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
		parent.property === node &&
		!parent.computed
	);
}

/** Judges one node; `statement` is the top-level statement holding it, quoted for deletion APIs. */
function judgeNode(node: Node, parent: Node | null, statement: Node, ctx: Context): Verdict {
	const fragment = (target: Node): string => ctx.code.slice(target.start ?? 0, target.end ?? 0);
	const quoted = fragment(statement);
	const { bindings } = ctx;
	if (node.type === "Identifier" && isReference(node, parent)) {
		if (DISTINCTIVE_DELETE.has(node.name)) return block("delete", quoted, `\`${node.name}\` deletes files`);
		const member = bindings.members.get(node.name);
		const exported = member?.slice(member.lastIndexOf(".") + 1) ?? "";
		const fromFs = member?.startsWith("fs.") === true || member?.startsWith("fs/promises.") === true;
		if (fromFs && (exported === "rm" || DISTINCTIVE_DELETE.has(exported))) return block("delete", quoted, `\`${member}\` deletes files`);
	}
	if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
		const property = propertyName(node);
		if (property !== null && DISTINCTIVE_DELETE.has(property)) return block("delete", quoted, `\`${property}\` deletes files`);
		if (property === "rm") {
			const module = receiverModule(node.object, bindings);
			if (module === "fs" || module === "fs/promises") return block("delete", quoted, `\`${module}.rm\` deletes files`);
		}
		if (property === "delete" && isBunFile(node.object, bindings)) return block("delete", quoted, "`Bun.file(…).delete()` deletes files");
	}
	const launch = jsLaunchOf(node, bindings);
	return launch === null ? ALLOW : judgeLaunch(launch, fragment(node), ctx);
}

/**
 * Classifies a js eval cell: fs deletion APIs block, and every command handed to
 * a shell or spawned is classified (`shell` for child_process strings, `brush`
 * for `Bun.$`, `Bun.spawn` argv and the `tool.bash` bridge). Parse failures throw
 * to the hook boundary, which blocks the call.
 */
export async function classifyJs(code: string, shell: Dialect, brush: Dialect): Promise<Verdict> {
	const { program, bindings } = await parseJs(code);
	const ctx: Context = { code, bindings, shell, brush };
	let verdict: Verdict = ALLOW;
	for (const statement of program.body) {
		walk(statement, program, (node, parent) => {
			if (verdict.kind === "block") return;
			verdict = judgeNode(node, parent, statement, ctx);
		});
		if (verdict.kind === "block") return verdict;
	}
	return verdict;
}
