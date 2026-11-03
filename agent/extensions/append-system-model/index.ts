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
// `#` comments are skipped. The body, everything after the closing fence, is
// the prompt text and may contain `---` lines.
//   enabled:          false            # optional; only true/yes/on/1 keep it on
//   target:           main             # optional; default main
//   cwd:              ~/code/app{,/**} # optional; absolute or ~/ globs
//   model:            ^gpt-            # optional; regex on the model id
//   provider:         ^openai          # optional; regex on the provider id
//   mode:             full             # optional; full and/or light
//   exclude.target:   task:mid         # optional; same grammar as target
//   exclude.cwd:      ~/scratch/**     # optional
//   exclude.model:    ^claude-opus-5-5$
//   exclude.provider: ^anthropic$
//   exclude.mode:     light
// Any other key makes the file invalid.
//
// MATCHING. `target`, `cwd`, `model` and `provider` follow
// `_shared/session-filter.ts`: items inside a key are alternatives, keys AND.
// `mode` is a comma list of `full` and `light`: `omp-light` starts omp with
// `OMOMP_MODE=light`, and any other value or none is `full`. A fragment is
// injected when its inclusion keys match the session and its `exclude.*` keys,
// if it sets any, do not all match. Without `exclude.target` the exclusion
// covers every session. `model` / `provider` are tested against the session's
// current model (`ctx.model.id`, `ctx.model.provider`); with no current model
// a model or provider constraint never matches, on either side.
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
	type FilterKeys,
	type FilterProblem,
	parseSessionFilter,
	producerMatches,
	type SessionFilter,
	type TargetDefault,
	targetsSession,
} from "../_shared/session-filter.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const FILE_PATTERN = /^APPEND-SYSTEM-.+\.md$/i;

type Mode = "full" | "light";

type SideKeys = FilterKeys & { readonly mode: string };

const INCLUDE_KEYS: SideKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider", mode: "mode" };
const EXCLUDE_KEYS: SideKeys = {
	target: "exclude.target",
	cwd: "exclude.cwd",
	model: "exclude.model",
	provider: "exclude.provider",
	mode: "exclude.mode",
};
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["enabled", ...Object.values(INCLUDE_KEYS), ...Object.values(EXCLUDE_KEYS)]);

/** One side of a fragment's condition; `modes` null means any mode. */
interface Conditions {
	readonly filter: SessionFilter;
	readonly modes: readonly Mode[] | null;
}

/** `none`: the file sets no `exclude.*` key, so nothing excludes it. */
type Exclusion = { readonly kind: "none" } | { readonly kind: "conditions"; readonly conditions: Conditions };

interface Fragment {
	readonly include: Conditions;
	readonly exclusion: Exclusion;
	readonly body: string;
}

type FragmentParse =
	| { readonly kind: "ok"; readonly fragment: Fragment }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

type ConditionsParse = { readonly kind: "ok"; readonly conditions: Conditions } | { readonly kind: "invalid"; readonly reason: string };

/** `path\0reason` of invalid files already reported, so a broken file warns once per process. */
const warnedFiles = new Set<string>();

function describeProblem(problem: FilterProblem): string {
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
		case "badInject":
			return tr(`${problem.key} is not accepted here`, `此处不接受 ${problem.key}`);
		default: {
			const unreachable: never = problem;
			return unreachable;
		}
	}
}

function parseModes(
	raw: string | undefined,
	key: string,
): { readonly kind: "ok"; readonly modes: readonly Mode[] | null } | { readonly kind: "invalid"; readonly reason: string } {
	if (raw === undefined) return { kind: "ok", modes: null };
	const modes: Mode[] = [];
	for (const item of unquote(raw).split(",")) {
		const value = unquote(item).toLowerCase();
		switch (value) {
			case "full":
			case "light":
				modes.push(value);
				break;
			default:
				return {
					kind: "invalid",
					reason: tr(`${key} must list full and/or light, not "${value}"`, `${key} 只能列出 full 和/或 light，不能是“${value}”`),
				};
		}
	}
	return { kind: "ok", modes };
}

function parseConditions(fields: Readonly<Record<string, string>>, keys: SideKeys, fallback: TargetDefault): ConditionsParse {
	const filter = parseSessionFilter(fields, keys, fallback);
	if (filter.kind === "invalid") return { kind: "invalid", reason: describeProblem(filter.problem) };
	const modes = parseModes(fields[keys.mode], keys.mode);
	if (modes.kind === "invalid") return modes;
	return { kind: "ok", conditions: { filter: filter.value, modes: modes.modes } };
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
	const include = parseConditions(fields, INCLUDE_KEYS, { kind: "default", targets: [{ kind: "main" }] });
	if (include.kind === "invalid") return include;
	let exclusion: Exclusion = { kind: "none" };
	if (Object.values(EXCLUDE_KEYS).some((key) => fields[key] !== undefined)) {
		const exclude = parseConditions(fields, EXCLUDE_KEYS, { kind: "default", targets: [{ kind: "all" }] });
		if (exclude.kind === "invalid") return exclude;
		exclusion = { kind: "conditions", conditions: exclude.conditions };
	}
	return { kind: "ok", fragment: { include: include.conditions, exclusion, body: text } };
}

/** Whether the session's identity, cwd, current model and mode satisfy every key the side sets. */
function sessionMatches(conditions: Conditions, ctx: ExtensionContext, mode: Mode): boolean {
	if (conditions.modes !== null && !conditions.modes.includes(mode)) return false;
	const { filter } = conditions;
	if (!targetsSession(filter, ctx.agent, ctx.cwd)) return false;
	if (filter.models.length === 0) return true;
	const model = ctx.model;
	if (model === undefined) return false;
	return producerMatches(filter, { model: model.id, provider: model.provider });
}

function applies(fragment: Fragment, ctx: ExtensionContext, mode: Mode): boolean {
	if (!sessionMatches(fragment.include, ctx, mode)) return false;
	switch (fragment.exclusion.kind) {
		case "none":
			return true;
		case "conditions":
			return !sessionMatches(fragment.exclusion.conditions, ctx, mode);
		default: {
			const unreachable: never = fragment.exclusion;
			return unreachable;
		}
	}
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
			const mode: Mode = process.env.OMOMP_MODE === "light" ? "light" : "full";
			const bodies: string[] = [];
			for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
				const parsed = parseFragment(path);
				switch (parsed.kind) {
					case "ok":
						if (applies(parsed.fragment, ctx, mode)) bodies.push(parsed.fragment.body);
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
