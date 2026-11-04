// ============================================================================
// append-system-model — system-prompt fragments with inject / not-inject
// conditions, one file per fragment.
//
// WHY THIS EXISTS. OMP's APPEND_SYSTEM.md / SYSTEM.md / SYSTEM_TEMPLATE.md and
// the rulebook cannot be conditioned on the session (main or subagent, cwd,
// full or light mode) or on its model, so a rule meant for one case reaches
// every case. A new conditional rule here is a new file, not new code.
//
// FILES. `APPEND-SYSTEM-<label>.md`, discovered by `_shared/spec-files.ts`:
//   - beside this module: fragments the repo ships and machine-local ones;
//   - <dir>/APPEND-SYSTEM-*.md and <dir>/.omp/APPEND-SYSTEM-*.md, walking from
//     the session cwd up to the git root.
// Every file that applies is appended; there is no override by name.
// Frontmatter (between `---` fences), one `key: value` per line; whole-line
// `#` comments are skipped, and text after a value, `#` included, is part of
// the value. The body, everything after the closing fence, is the prompt text
// and may contain `---` lines. Every key is optional:
//   enabled:          false
//   target:           main
//   cwd:              ~/code/app{,/**}
//   model:            ^gpt-
//   provider:         ^openai
//   mode:             full
//   exclude.target:   task:mid
//   exclude.cwd:      ~/scratch/**
//   exclude.model:    ^claude-opus-5-5$
//   exclude.provider: ^anthropic$
//   exclude.mode:     light
// `enabled` keeps the file on only for true/yes/on/1; `target` defaults to
// main; `cwd` lists absolute or ~/ globs; `model` / `provider` are regexes on
// the model and provider ids; `mode` lists full and/or light; each `exclude.*`
// key has the grammar of its inclusion key. Any other key makes the file
// invalid.
//
// MATCHING. `_shared/prompt-conditions.ts` (shared with system-prompt-replace):
// items inside a key are alternatives, keys AND; `mode` lists `full` and/or
// `light` (`omp-light` sets `OMOMP_MODE=light`). A fragment is injected when
// its inclusion keys match the session and its `exclude.*` keys, if it sets
// any, do not all match. Without `exclude.target` the exclusion covers every
// session. With no current model a model or provider constraint never
// matches, on either side. Without `target` a fragment targets `main`.
//
// TIMING. `before_agent_start`, in the main session and in every subagent, each
// matched against its own identity, cwd and model. Files are re-read per
// prompt, so edits and `/model` switches apply from the next prompt. A model
// switched mid-run by auto-retry keeps the fragments chosen when the prompt
// started, and a subagent turn woken by IRC does not run this hook.
//
// OUTPUT. The bodies of every applying fragment, in discovery order, joined
// into one extra system-prompt block appended after the existing blocks.
//
// FAILURE POLICY. An invalid or unreadable file is skipped on its own and
// warned once per path and reason (UI notification, or stderr when headless,
// plus a log line); the other files still apply. The prompt is never blocked.
// It registers only `before_agent_start` and writes no files.
// ============================================================================

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
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

/** `path\0reason` of invalid files already reported, so a broken file warns once per process. */
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
		case "badMode":
			return tr(
				`${problem.key} must list full and/or light, not "${problem.value}"`,
				`${problem.key} 只能列出 full 和/或 light，不能是“${problem.value}”`,
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
	const parsed = parseFrontmatter(raw.replace(/^\uFEFF/, ""));
	if (!parsed) return { kind: "invalid", reason: tr("missing frontmatter", "缺少 frontmatter") };
	const { fields, body } = parsed;
	const unknown = Object.keys(fields).find((key) => !ALLOWED_KEYS.has(key));
	if (unknown !== undefined) return { kind: "invalid", reason: tr(`unknown key ${unknown}`, `未知键 ${unknown}`) };
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	const text = body.trim();
	if (text === "") return { kind: "invalid", reason: tr("empty body", "正文为空") };
	const conditions = parseSessionConditions(fields, { kind: "default", targets: [{ kind: "main" }] }, "frontmatter");
	if (conditions.kind === "invalid") return { kind: "invalid", reason: describeProblem(conditions.problem) };
	return { kind: "ok", fragment: { conditions: conditions.value, body: text } };
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

export default function appendSystemModel(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const bodies: string[] = [];
			for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
				const parsed = parseFragment(path);
				switch (parsed.kind) {
					case "ok":
						if (conditionsApply(parsed.fragment.conditions, ctx)) bodies.push(parsed.fragment.body);
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
			if (bodies.length === 0) return;
			return { systemPrompt: [...event.systemPrompt, bodies.join("\n\n")] };
		} catch (error) {
			pi.logger.warn("append-system-model: cannot append system prompt", { error: errorText(error) });
		}
	});
}
