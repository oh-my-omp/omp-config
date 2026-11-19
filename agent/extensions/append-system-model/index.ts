import { readFileSync } from "node:fs";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { createDeltaStream, type Delta } from "../_shared/omomp-shared/context-delta.ts";
import {
	CONDITION_KEYS,
	type ConditionProblem,
	conditionsApply,
	parseSessionConditions,
	type SessionConditions,
} from "../_shared/prompt-conditions.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const FILE_PATTERN = /^APPEND-SYSTEM-.+\.md$/i;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["enabled", ...CONDITION_KEYS]);

interface Fragment {
	readonly conditions: SessionConditions;
	readonly body: string;
}

type FragmentParse =
	| { readonly kind: "ok"; readonly fragment: Fragment }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

const warnedFiles = new Set<string>();

function describeProblem(problem: ConditionProblem): string {
	switch (problem.kind) {
		case "missing":
			return tr(`${problem.key} is missing`, `缺少 ${problem.key}`);
		case "empty":
			return tr(`${problem.key} lists nothing`, `${problem.key} 未列出任何值`);
		case "relative":
			return tr(
				`${problem.key} pattern "${problem.pattern}" must be absolute or start with ~/`,
				`${problem.key} 模式“${problem.pattern}”必须是绝对路径或以 ~/ 开头`,
			);
		case "badRegex":
			return tr(`${problem.key} is not a valid regex: ${problem.detail}`, `${problem.key} 不是有效正则表达式：${problem.detail}`);
		case "badChoice":
			return tr(
				`${problem.key} may list only ${problem.allowed.join(", ")}, not "${problem.value}"`,
				`${problem.key} 只能列出 ${problem.allowed.join("、")}，不能是“${problem.value}”`,
			);
		case "badInject":
			return tr(`${problem.key} is not accepted here`, `此处不接受 ${problem.key}`);
		default: {
			const unreachable: never = problem;
			return unreachable;
		}
	}
}

function parseFragment(path: string): FragmentParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const detail = errorText(error);
		return { kind: "invalid", reason: tr(`unreadable: ${detail}`, `无法读取：${detail}`) };
	}
	const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const parsed = parseFrontmatter(stripped);
	if (!parsed) return { kind: "invalid", reason: tr("missing frontmatter", "缺少 frontmatter") };
	const { fields, body } = parsed;
	const unknown = Object.keys(fields).find((key) => !ALLOWED_KEYS.has(key));
	if (unknown !== undefined) return { kind: "invalid", reason: tr(`unknown key ${unknown}`, `未知键 ${unknown}`) };
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	if (!/\S/.test(body)) return { kind: "invalid", reason: tr("empty body", "正文为空") };
	const conditions = parseSessionConditions(fields, { kind: "default", targets: [{ kind: "main" }] }, "frontmatter");
	if (conditions.kind === "invalid") return { kind: "invalid", reason: describeProblem(conditions.problem) };
	return { kind: "ok", fragment: { conditions: conditions.value, body } };
}

function warn(pi: ExtensionAPI, ctx: ExtensionContext, path: string, reason: string): void {
	const key = `${path}\0${reason}`;
	if (warnedFiles.has(key)) return;
	warnedFiles.add(key);
	pi.logger.warn(`append-system-model: skipped ${path}: ${reason}`);
	const notice = tr(`append-system-model: skipped ${path}: ${reason}`, `append-system-model：跳过 ${path}：${reason}`);
	if (ctx.hasUI) ctx.ui.notify(notice, "warning");
	else process.stderr.write(`${notice}\n`);
}

function fragmentDelta(pi: ExtensionAPI, ctx: ExtensionContext): Delta {
	const bodies: string[] = [];
	const delegation = ctx.model === undefined ? undefined : resolveDelegationBias(ctx.model);
	for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
		const parsed = parseFragment(path);
		switch (parsed.kind) {
			case "ok":
				if (conditionsApply(parsed.fragment.conditions, ctx, delegation)) bodies.push(parsed.fragment.body.trim());
				break;
			case "disabled":
				break;
			case "invalid":
				warn(pi, ctx, path, parsed.reason);
				break;
			default: {
				const unreachable: never = parsed;
				return unreachable;
			}
		}
	}
	return bodies.length === 0 ? { kind: "none" } : { kind: "text", body: bodies.join("\n\n") };
}

export default function appendSystemModel(pi: ExtensionAPI): void {
	const deltas = createDeltaStream("omp-config/append-system-model");
	pi.on("turn_start", () => {
		deltas.turnStarted();
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			return deltas.atPrompt(ctx, fragmentDelta(pi, ctx));
		} catch (error) {
			pi.logger.warn("append-system-model: cannot deliver fragments", { error: errorText(error) });
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			return deltas.afterTools(ctx, fragmentDelta(pi, ctx));
		} catch (error) {
			pi.logger.warn("append-system-model: cannot deliver fragments", { error: errorText(error) });
		}
	});
}
