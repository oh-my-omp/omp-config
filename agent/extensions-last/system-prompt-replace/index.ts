// ============================================================================
// system-prompt-replace — wording-level edits of OMP's system prompt, from
// rule files with per-rule session conditions, delivered as a delta message
// beside the system prompt, which stays as OMP built it.
//
// WHY THIS EXISTS. SYSTEM_TEMPLATE.md owns the base workflow. Whole tool
// descriptions belong to the tool-topics extension (surface + topic index,
// keyed by tool name); this extension states the remaining wording-level
// edits — template lines, and sentences inside tool descriptions that keep
// their native text — instead of repeating them in the base template or
// APPEND_SYSTEM.md. A new rule, global or for one model or agent, is a file
// edit, not new code.
//
// ORDER. This file lives outside `<agent dir>/extensions/` and is the LAST
// `extensions` entry of config.yml and of config-light.yml
// (agent/extensions-last/README.md), so its `before_agent_start` runs after
// every path-loaded extension and its delta follows theirs in a prompt's
// messages. Placing this file in `extensions/` would load it with the native
// batch, and the config entry would be dropped as a duplicate path.
//
// FILES. `REPLACE-SYSTEM-<label>.yml` (or `.yaml`), discovered by
// `_shared/spec-files.ts`: beside this module (rule files the repo ships and
// machine-local ones), then <dir>/ and <dir>/.omp/ from the session cwd up to
// the git root. Each file is one YAML sequence of rules:
//
//   - literal: "exact text"
//     replace: "new text"
//   - regex: "JS regex source"
//     replace: "new text, $1 allowed"
//     target: subagents
//     model: ^claude-opus
//     delegation: eager
//     exclude.target: mentor:default
//
// A rule sets exactly one of `literal` / `regex` (non-empty) plus `replace`.
// A literal replaces every occurrence verbatim (no `$` handling). A regex is
// compiled with the `g` flag and uses String.prototype.replace substitution
// patterns. Optional condition keys, string values, follow
// `_shared/prompt-conditions.ts` (shared with append-system-model): `target`,
// `cwd`, `model`, `provider`, `mode`, `delegation` and the same keys under
// `exclude.`; without `target` a rule applies to every session. `delegation`
// lists OMP's delegation-bias tiers (`eager`, `restrained`, `gated`) of the
// current model, for text OMP renders only under some tiers. A `model` /
// `provider` string is the regex source exactly as YAML decodes it. Any other
// key makes the file invalid. Files apply in discovery order and rules in file
// order, each to the text the previous one left, across every system-prompt
// block; that text exists only to find the next rule's matches.
//
// INPUT. The system prompt this extension is handed, never changed:
// `event.systemPrompt` at a prompt, `ctx.getSystemPrompt()` after a tool call.
//
// TIMING. Rules are re-read and matched at every prompt (`before_agent_start`)
// and after every tool call (`tool_result`), in the main session and in every
// subagent, each matched against its own identity, cwd, model and mode. Edits
// to rule files and `/model` switches apply from the next of those points;
// until then requests keep the delta already in the conversation. A revive's
// `before_agent_start` is skipped, because OMP discards its result.
//
// OUTPUT. One delta of `_shared/context-delta.ts` with source
// `omp-config/system-prompt-replace`: a hidden `<system-reminder>` message
// appended to the conversation (after the prompt, or after the tool batch)
// that lists, in rule order, each distinct matched passage and its replaced
// text, or that the passage does not apply when the replacement is empty. A
// rule without a match adds nothing. It is sent only when it differs from the
// source's effective delta in the current context; a changed list supersedes
// the earlier delta, and when no rule matches any longer a delta saying so
// supersedes it.
//
// FAILURE POLICY. No file means no delta. An unreadable or invalid file is
// skipped on its own and warned once per path and reason; the other files
// still apply. A rule that applies to the main session and finds no target
// (template drift after an OMP upgrade, or a typo) warns once per rule per
// process. Subagents are not checked: their prompts legitimately lack text
// such as the `task` tool description. Warnings are a UI notification, or
// stderr when headless, plus a log line. The prompt and tool results are
// never blocked. It registers `before_agent_start`, `tool_result` and the
// delta stream's `turn_start`, and writes no files.
// ============================================================================

import { readFileSync } from "node:fs";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../../extensions/_shared/context-delta.ts";
import { errorText } from "../../extensions/_shared/errors.ts";
import { tr } from "../../extensions/_shared/i18n.ts";
import {
	CONDITION_KEYS,
	type ConditionProblem,
	conditionsApply,
	parseSessionConditions,
	type SessionConditions,
} from "../../extensions/_shared/prompt-conditions.ts";
import { discoverSpecFiles } from "../../extensions/_shared/spec-files.ts";

const FILE_PATTERN = /^REPLACE-SYSTEM-.+\.ya?ml$/i;

const mappingSchema = z.record(z.string(), z.unknown()).refine((value) => !Array.isArray(value));
const CONDITION_KEY_SET: ReadonlySet<string> = new Set(CONDITION_KEYS);

type Matcher = { readonly kind: "literal"; readonly text: string } | { readonly kind: "regex"; readonly pattern: RegExp };

interface Rule {
	/** `path#index matcher`, the warning and dedupe identity. */
	readonly label: string;
	readonly matcher: Matcher;
	readonly replace: string;
	readonly conditions: SessionConditions;
}

/** One distinct passage a rule matched and the text it becomes; an empty replacement removes the passage. */
interface Edit {
	readonly original: string;
	readonly replacement: string;
}

type Parse<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly reason: string };

const PREAMBLE = "OMP's system prompt keeps its original text. In this session, read it with these edits, applied in the order listed:";

/** `path\0reason` of invalid files and labels of target-less rules already reported, shared by every session in this process. */
const reported = new Set<string>();

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

function parseMatcher(record: Readonly<Record<string, unknown>>, at: string): Parse<Matcher> {
	const { literal, regex } = record;
	if ((literal === undefined) === (regex === undefined)) {
		return { kind: "invalid", reason: tr(`${at}: set exactly one of literal and regex`, `${at}：literal 与 regex 必须且只能设置一个`) };
	}
	if (literal !== undefined) {
		if (typeof literal !== "string" || literal === "") {
			return { kind: "invalid", reason: tr(`${at}: literal must be a non-empty string`, `${at}：literal 必须是非空字符串`) };
		}
		return { kind: "ok", value: { kind: "literal", text: literal } };
	}
	if (typeof regex !== "string" || regex === "") {
		return { kind: "invalid", reason: tr(`${at}: regex must be a non-empty string`, `${at}：regex 必须是非空字符串`) };
	}
	try {
		return { kind: "ok", value: { kind: "regex", pattern: new RegExp(regex, "g") } };
	} catch (error) {
		const detail = errorText(error);
		return { kind: "invalid", reason: tr(`${at}: invalid regex: ${detail}`, `${at}：正则无效：${detail}`) };
	}
}

function parseRule(value: unknown, path: string, index: number): Parse<Rule> {
	const at = `[${index}]`;
	const mapping = mappingSchema.safeParse(value);
	if (!mapping.success) return { kind: "invalid", reason: tr(`${at} is not a mapping`, `${at} 不是映射`) };
	const record = mapping.data;
	const fields: Record<string, string> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (key === "literal" || key === "regex" || key === "replace") continue;
		if (!CONDITION_KEY_SET.has(key)) return { kind: "invalid", reason: tr(`${at}: unknown key ${key}`, `${at}：未知键 ${key}`) };
		if (typeof raw !== "string") return { kind: "invalid", reason: tr(`${at}: ${key} must be a string`, `${at}：${key} 必须是字符串`) };
		fields[key] = raw;
	}
	if (typeof record.replace !== "string") {
		return { kind: "invalid", reason: tr(`${at}: replace must be a string`, `${at}：replace 必须是字符串`) };
	}
	const matcher = parseMatcher(record, at);
	if (matcher.kind === "invalid") return matcher;
	const conditions = parseSessionConditions(fields, { kind: "default", targets: [{ kind: "all" }] }, "yaml");
	if (conditions.kind === "invalid") return { kind: "invalid", reason: `${at}: ${describeProblem(conditions.problem)}` };
	const shown = matcher.value.kind === "literal" ? `literal ${JSON.stringify(matcher.value.text)}` : `regex ${matcher.value.pattern}`;
	return {
		kind: "ok",
		value: { label: `${path}${at} ${shown}`, matcher: matcher.value, replace: record.replace, conditions: conditions.value },
	};
}

function parseRuleFile(path: string): Parse<readonly Rule[]> {
	let data: unknown;
	try {
		data = Bun.YAML.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		const detail = errorText(error);
		return { kind: "invalid", reason: tr(`unreadable or not YAML: ${detail}`, `无法读取或不是 YAML：${detail}`) };
	}
	if (!Array.isArray(data))
		return { kind: "invalid", reason: tr("the file must be a YAML sequence of rules", "文件必须是规则组成的 YAML 序列") };
	const rules: Rule[] = [];
	for (const [index, value] of data.entries()) {
		const rule = parseRule(value, path, index);
		if (rule.kind === "invalid") return rule;
		rules.push(rule.value);
	}
	return { kind: "ok", value: rules };
}

function warn(pi: ExtensionAPI, ctx: ExtensionContext, key: string, english: string, chinese: string): void {
	if (reported.has(key)) return;
	reported.add(key);
	pi.logger.warn(english);
	const notice = tr(english, chinese);
	if (ctx.hasUI) ctx.ui.notify(notice, "warning");
	else process.stderr.write(`${notice}\n`);
}

/** What `pattern` with `replace` turns its match `match` of `block` into; a sticky copy keeps `$\``, `$'` and lookarounds exact. */
function replacementOf(block: string, pattern: RegExp, match: RegExpExecArray, replace: string): string {
	const at = new RegExp(pattern.source, "y");
	at.lastIndex = match.index;
	const replaced = block.replace(at, replace);
	return replaced.slice(match.index, replaced.length - (block.length - match.index - match[0].length));
}

/** The blocks after `rule`, how many times it matched, and its distinct edits in match order. */
function applyRule(blocks: readonly string[], rule: Rule): { readonly blocks: string[]; readonly hits: number; readonly edits: Edit[] } {
	let hits = 0;
	const edits = new Map<string, Edit>();
	const record = (original: string, replacement: string): void => {
		if (original !== replacement) edits.set(`${original}\0${replacement}`, { original, replacement });
	};
	const matcher = rule.matcher;
	const next = blocks.map((block) => {
		switch (matcher.kind) {
			case "literal": {
				const pieces = block.split(matcher.text);
				if (pieces.length === 1) return block;
				hits += pieces.length - 1;
				record(matcher.text, rule.replace);
				return pieces.join(rule.replace);
			}
			case "regex": {
				const matches = [...block.matchAll(matcher.pattern)];
				if (matches.length === 0) return block;
				hits += matches.length;
				for (const match of matches) record(match[0], replacementOf(block, matcher.pattern, match, rule.replace));
				return block.replace(matcher.pattern, rule.replace);
			}
			default: {
				const unreachable: never = matcher;
				return unreachable;
			}
		}
	});
	return { blocks: next, hits, edits: [...edits.values()] };
}

function renderEdit(edit: Edit): string {
	const passage = `The passage\n<original>\n${edit.original}\n</original>\n`;
	return edit.replacement === ""
		? `${passage}does not apply in this session.`
		: `${passage}reads instead\n<replacement>\n${edit.replacement}\n</replacement>`;
}

/** The edits of every rule that applies to this session, matched against `systemPrompt`, as one delta. */
function replacementDelta(pi: ExtensionAPI, ctx: ExtensionContext, systemPrompt: readonly string[]): Delta {
	let blocks = systemPrompt;
	const edits: Edit[] = [];
	const delegation = ctx.model === undefined ? undefined : resolveDelegationBias(ctx.model);
	for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
		const parsed = parseRuleFile(path);
		if (parsed.kind === "invalid") {
			warn(
				pi,
				ctx,
				`${path}\0${parsed.reason}`,
				`system-prompt-replace: skipped ${path}: ${parsed.reason}`,
				`system-prompt-replace：跳过 ${path}：${parsed.reason}`,
			);
			continue;
		}
		for (const rule of parsed.value) {
			if (!conditionsApply(rule.conditions, ctx, delegation)) continue;
			const result = applyRule(blocks, rule);
			blocks = result.blocks;
			edits.push(...result.edits);
			if (result.hits === 0 && ctx.agent.kind === "main") {
				warn(
					pi,
					ctx,
					rule.label,
					`system-prompt-replace: ${rule.label} found no target in the system prompt`,
					`system-prompt-replace：系统提示词中未找到 ${rule.label} 的目标`,
				);
			}
		}
	}
	return edits.length === 0 ? { kind: "none" } : { kind: "text", body: [PREAMBLE, ...edits.map(renderEdit)].join("\n\n") };
}

export default function systemPromptReplace(pi: ExtensionAPI): void {
	const deltas = createDeltaStream(pi, "system-prompt-replace");
	pi.on("before_agent_start", (event, ctx) => {
		// OMP discards the result of a revive.
		if (event.reason === "revive") return;
		try {
			return deltas.atPrompt(ctx, replacementDelta(pi, ctx, event.systemPrompt));
		} catch (error) {
			pi.logger.warn("system-prompt-replace: cannot deliver edits", { error: errorText(error) });
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			return deltas.afterTools(ctx, replacementDelta(pi, ctx, ctx.getSystemPrompt()));
		} catch (error) {
			pi.logger.warn("system-prompt-replace: cannot deliver edits", { error: errorText(error) });
		}
	});
}
