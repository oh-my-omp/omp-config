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
// lists OMP's delegation-bias tiers (`eager`, `balanced`, `restrained`, `gated`) of the
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
const DIGIT = /^[0-9]$/;

const mappingSchema = z.record(z.string(), z.unknown()).refine((value) => !Array.isArray(value));
const CONDITION_KEY_SET: ReadonlySet<string> = new Set(CONDITION_KEYS);

type Matcher =
	| { readonly kind: "literal"; readonly text: string }
	| { readonly kind: "regex"; readonly pattern: RegExp; readonly tokens: readonly Token[] };

/** One piece of a regex rule's `replace` template: literal text, or a substitution `String.prototype.replace` spells with `$`. */
type Token =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "match" }
	| { readonly kind: "before" }
	| { readonly kind: "after" }
	/** `$1`–`$99` as written: which capture it names depends on the pattern's group count, known per match. */
	| { readonly kind: "group"; readonly digits: string }
	/** `$<name>`, with the `<name>` text re-read as a template when the pattern has no named groups. */
	| { readonly kind: "named"; readonly name: string; readonly fallback: readonly Token[] };

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

function parseMatcher(record: Readonly<Record<string, unknown>>, at: string, replace: string): Parse<Matcher> {
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
		return { kind: "ok", value: { kind: "regex", pattern: new RegExp(regex, "g"), tokens: parseTemplate(replace) } };
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
	const matcher = parseMatcher(record, at, record.replace);
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

/** The tokens of one `replace` template: literal text and the `$` substitutions `String.prototype.replace` defines. */
function parseTemplate(template: string): readonly Token[] {
	const tokens: Token[] = [];
	let text = "";
	let at = 0;
	const flush = (): void => {
		if (text === "") return;
		tokens.push({ kind: "text", text });
		text = "";
	};
	while (at < template.length) {
		const char = template.charAt(at);
		const next = template.charAt(at + 1);
		if (char !== "$" || next === "") {
			text += char;
			at += 1;
			continue;
		}
		switch (next) {
			case "$":
				text += "$";
				at += 2;
				continue;
			case "&":
				flush();
				tokens.push({ kind: "match" });
				at += 2;
				continue;
			case "`":
				flush();
				tokens.push({ kind: "before" });
				at += 2;
				continue;
			case "'":
				flush();
				tokens.push({ kind: "after" });
				at += 2;
				continue;
			case "<": {
				const close = template.indexOf(">", at + 2);
				if (close < 0) {
					text += "$";
					at += 1;
					continue;
				}
				flush();
				const name = template.slice(at + 2, close);
				tokens.push({ kind: "named", name, fallback: parseTemplate(`<${name}>`) });
				at = close + 1;
				continue;
			}
			default: {
				if (!DIGIT.test(next)) {
					text += "$";
					at += 1;
					continue;
				}
				const second = template.charAt(at + 2);
				const digits = DIGIT.test(second) ? `${next}${second}` : next;
				flush();
				tokens.push({ kind: "group", digits });
				at += 1 + digits.length;
				continue;
			}
		}
	}
	flush();
	return tokens;
}

/** Whether `value` is the named-captures object `String.prototype.replace` passes when a pattern names its groups. */
function isNamedCaptures(value: unknown): value is Readonly<Record<string, string | undefined>> {
	return typeof value === "object" && value !== null;
}

/** `value` as text: an absent capture, or any other non-string, contributes nothing. */
function textAt(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** `tokens` applied to one replacer call: `args` as `String.prototype.replace` passed them, `block` the text being replaced. */
function expand(tokens: readonly Token[], args: readonly unknown[], block: string): string {
	const last = args[args.length - 1];
	const groups = isNamedCaptures(last) ? last : undefined;
	// `args` is the matched text, its captures, the offset and the input, then the named captures.
	const captures = args.length - 3 - (groups === undefined ? 0 : 1);
	const offsetArg = args[captures + 1];
	const offset = typeof offsetArg === "number" ? offsetArg : 0;
	const matched = textAt(args[0]);
	let out = "";
	for (const token of tokens) {
		switch (token.kind) {
			case "text":
				out += token.text;
				break;
			case "match":
				out += matched;
				break;
			case "before":
				out += block.slice(0, offset);
				break;
			case "after":
				out += block.slice(offset + matched.length);
				break;
			case "group": {
				// `$nn` needs a group that exists; otherwise `$n` plus the second digit as text.
				const two = token.digits.length === 2 ? Number(token.digits) : 0;
				if (two > 0 && two <= captures) {
					out += textAt(args[two]);
					break;
				}
				const one = Number(token.digits.charAt(0));
				if (one > 0 && one <= captures) {
					out += textAt(args[one]);
					if (token.digits.length === 2) out += token.digits.charAt(1);
					break;
				}
				out += `$${token.digits}`;
				break;
			}
			case "named":
				out += groups === undefined ? `$${expand(token.fallback, args, block)}` : (groups[token.name] ?? "");
				break;
			default: {
				const unreachable: never = token;
				return unreachable;
			}
		}
	}
	return out;
}

/** One rule applied to one block, recording each matched passage, and how often it matched there. */
function replaceIn(
	block: string,
	rule: Rule,
	record: (original: string, replacement: string) => void,
): { readonly text: string; readonly hits: number } {
	const matcher = rule.matcher;
	switch (matcher.kind) {
		case "literal": {
			const pieces = block.split(matcher.text);
			if (pieces.length === 1) return { text: block, hits: 0 };
			record(matcher.text, rule.replace);
			return { text: pieces.join(rule.replace), hits: pieces.length - 1 };
		}
		case "regex": {
			let hits = 0;
			const text = block.replace(matcher.pattern, (...args: unknown[]): string => {
				hits += 1;
				const replacement = expand(matcher.tokens, args, block);
				record(textAt(args[0]), replacement);
				return replacement;
			});
			return { text, hits };
		}
		default: {
			const unreachable: never = matcher;
			return unreachable;
		}
	}
}

/** The blocks after `rule`, how many times it matched, and its distinct edits in match order. */
function applyRule(
	blocks: readonly string[],
	rule: Rule,
): { readonly blocks: readonly string[]; readonly hits: number; readonly edits: Edit[] } {
	let hits = 0;
	const edits: Edit[] = [];
	const known = new Map<string, Set<string>>();
	const record = (original: string, replacement: string): void => {
		if (original === replacement) return;
		const replacements = known.get(original);
		if (replacements === undefined) known.set(original, new Set([replacement]));
		else if (replacements.has(replacement)) return;
		else replacements.add(replacement);
		edits.push({ original, replacement });
	};
	// Unmatched blocks stay the same references, and a rule that matches nothing copies no array.
	let next: string[] | undefined;
	for (const [index, block] of blocks.entries()) {
		const applied = replaceIn(block, rule, record);
		hits += applied.hits;
		if (applied.hits === 0) continue;
		next ??= [...blocks];
		next[index] = applied.text;
	}
	return { blocks: next ?? blocks, hits, edits };
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
	if (edits.length === 0) return { kind: "none" };
	let body = PREAMBLE;
	for (const edit of edits) body += `\n\n${renderEdit(edit)}`;
	return { kind: "text", body };
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
