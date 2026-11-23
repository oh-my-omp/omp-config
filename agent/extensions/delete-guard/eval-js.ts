import type { Node } from "@babel/types";
import {
	isBunFile,
	type JsCarry,
	type JsCell,
	type JsLaunch,
	jsLaunchOf,
	parseJs,
	propertyName,
	receiverModule,
	walk,
} from "../_shared/eval-js-launches.ts";
import { classifyScript } from "./classify.ts";
import { classifyPosix, classifyPosixArgv } from "./posix.ts";
import { ALLOW, absurd, block, type Dialect, type Verdict } from "./verdict.ts";

const DISTINCTIVE_DELETE: ReadonlySet<string> = new Set(["rmSync", "unlinkSync", "rmdirSync", "unlink", "rmdir"]);

type Context = {
	readonly code: string;
	readonly bindings: JsCell["bindings"];
	readonly shell: Dialect;
	readonly depth: number;
};

export type JsJudgement = { readonly verdict: Verdict; readonly carry: JsCarry };

function judgeLaunch(launch: JsLaunch, fragment: string, ctx: Context): Verdict {
	const nonLiteral = (what: string): Verdict => block("nonLiteral", fragment, `${what} is not a literal string`);
	const depth = ctx.depth + 1;
	switch (launch.kind) {
		case "childScript":
			return launch.text === null ? nonLiteral("the command handed to a shell") : classifyScript(ctx.shell, launch.text, depth);
		case "childSpawn": {
			const words = launch.words;
			if (words === null) return nonLiteral("the argument list");
			if (launch.shell) {
				if (words.some((word) => !word.literal)) return nonLiteral("the command handed to a shell");
				return classifyScript(ctx.shell, words.map((word) => word.text).join(" "), depth);
			}
			return classifyPosixArgv(words, depth);
		}
		case "bunSpawn":
			return launch.words === null ? nonLiteral("the command list") : classifyPosixArgv(launch.words, depth);
		case "shellHelper":
			return launch.text === null ? nonLiteral("the command handed to `sh`") : classifyPosix(launch.text, depth);
		case "bunShell":
			return launch.text === null
				? block("nonLiteral", fragment, "the `Bun.$` template interpolates values, so it is not a literal command")
				: classifyPosix(launch.text, depth);
		case "bridge":
			return launch.command === null ? nonLiteral("the bash bridge command") : classifyPosix(launch.command, depth);
		case "indeterminate":
			return block("nonLiteral", fragment, `${launch.what} is not statically known`);
		default:
			return absurd(launch);
	}
}

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

function judgeNode(node: Node, parent: Node | null, statement: Node, ctx: Context): Verdict {
	const fragment = (target: Node): string => ctx.code.slice(target.start ?? 0, target.end ?? 0);
	const quoted = fragment(statement);
	const { bindings } = ctx;
	if (node.type === "Identifier" && isReference(node, parent)) {
		if (DISTINCTIVE_DELETE.has(node.name)) return block("delete", quoted, `\`${node.name}\` deletes files`);
		const member = bindings.members.get(node.name) ?? bindings.prior.members.get(node.name);
		const exported = member?.slice(member.lastIndexOf(".") + 1) ?? "";
		const fromFs = member?.startsWith("fs.") === true || member?.startsWith("fs/promises.") === true;
		if (fromFs && (exported === "rm" || DISTINCTIVE_DELETE.has(exported))) return block("delete", quoted, `\`${member}\` deletes files`);
	}
	if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
		const property = propertyName(node);
		if (property !== null && DISTINCTIVE_DELETE.has(property)) return block("delete", quoted, `\`${property}\` deletes files`);
		if ((property === "remove" || property === "removeSync") && node.object.type === "Identifier" && node.object.name === "Deno")
			return block("delete", quoted, `\`Deno.${property}\` deletes files`);
		if (property === "rm") {
			const module = receiverModule(node.object, bindings);
			if (module === "fs" || module === "fs/promises") return block("delete", quoted, `\`${module}.rm\` deletes files`);
		}
		if (property === "delete" && isBunFile(node.object, bindings)) return block("delete", quoted, "`Bun.file(…).delete()` deletes files");
	}
	const launch = jsLaunchOf(node, bindings);
	return launch === null ? ALLOW : judgeLaunch(launch, fragment(node), ctx);
}

export function classifyJs(code: string, shell: Dialect, carry: JsCarry, depth = 0): JsJudgement {
	const cell = parseJs(code, carry);
	const ctx: Context = { code, bindings: cell.bindings, shell, depth };
	let verdict: Verdict = ALLOW;
	for (const statement of cell.program.body) {
		walk(statement, cell.program, (node, parent) => {
			verdict = judgeNode(node, parent, statement, ctx);
			return verdict.kind === "block";
		});
		if (verdict.kind === "block") break;
	}
	return { verdict, carry: cell.carry };
}
