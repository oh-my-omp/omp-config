import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { NoulQuestion } from "@oh-my-pi/pi-ai";
import { tr } from "../_shared/i18n.ts";
import {
	type FilterKeys,
	type FilterProblem,
	type InjectMode,
	parseInjectMode,
	parseSessionFilter,
	type SessionFilter,
} from "../_shared/session-filter.ts";
import { isEnabled, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const QUESTION_KEY = /^question\.([a-z0-9_]+)(?:\.(true|false))?$/;
const RULE_KEY = /^when\.([a-z0-9_]+)$/;
const COMPARISON = /^([a-z0-9_]+)\s*(>=|<)\s*(\d*\.?\d+)$/;
const DEFAULT_MAX_BYTES = 30_000;
const MAX_BYTES_LIMIT = 65_536;
const FILTER_KEYS: FilterKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider" };

export type Comparison = { readonly question: string; readonly op: "atLeast" | "below"; readonly value: number };

type Rule = { readonly name: string; readonly conditions: readonly Comparison[] };

export type TurnJudgeSpec = {
	readonly name: string;
	readonly questions: Readonly<Record<string, NoulQuestion>>;
	readonly rules: readonly Rule[];
	readonly prompt: string;
	readonly maxBytes: number;
	readonly skipTools: ReadonlySet<string>;
	readonly filter: SessionFilter;
	readonly inject: InjectMode;
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: TurnJudgeSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

type Invalid = { readonly kind: "invalid"; readonly reason: string };

type Parsed<T> = { readonly kind: "ok"; readonly value: T } | Invalid;

function invalid(en: string, zh: string): Invalid {
	return { kind: "invalid", reason: tr(en, zh) };
}

function parseMaxBytes(raw: string | undefined): Parsed<number> {
	if (raw === undefined) return { kind: "ok", value: DEFAULT_MAX_BYTES };
	const value = Number(unquote(raw));
	if (!Number.isInteger(value) || value <= 0) return invalid("maxBytes must be a positive integer", "maxBytes 必须是正整数");
	if (value > MAX_BYTES_LIMIT)
		return invalid(`maxBytes must be at most ${MAX_BYTES_LIMIT} (64KB)`, `maxBytes 不能超过 ${MAX_BYTES_LIMIT}（64KB）`);
	return { kind: "ok", value };
}

function parseQuestions(fields: Readonly<Record<string, string>>): Parsed<Record<string, NoulQuestion>> {
	const instructions = new Map<string, string>();
	const criteria = new Map<string, { true?: string; false?: string }>();
	for (const [key, raw] of Object.entries(fields)) {
		const m = key.match(QUESTION_KEY);
		const id = m?.[1];
		if (m === null || id === undefined) continue;
		const value = unquote(raw);
		if (value === "") return invalid(`${key} is empty`, `${key} 为空`);
		const side = m[2];
		if (side === "true" || side === "false") criteria.set(id, { ...criteria.get(id), [side]: value });
		else instructions.set(id, value);
	}
	if (instructions.size === 0) return invalid("needs at least one question.<id> entry", "至少需要一个 question.<id> 条目");
	for (const id of criteria.keys()) {
		if (!instructions.has(id)) return invalid(`question.${id} is not declared`, `question.${id} 未声明`);
	}
	const questions = [...instructions].map(([id, text]): [string, NoulQuestion] => {
		const sides = criteria.get(id);
		return [id, sides === undefined ? { type: "noul", instructions: text } : { type: "noul", instructions: text, criteria: sides }];
	});
	return { kind: "ok", value: Object.fromEntries(questions) };
}

function parseComparison(key: string, part: string, declared: Readonly<Record<string, NoulQuestion>>): Parsed<Comparison> {
	const [, question, op, rawValue] = part.match(COMPARISON) ?? [];
	if (question === undefined || op === undefined || rawValue === undefined)
		return invalid(`${key}: "${part}" is not <question> >= p or <question> < p`, `${key}：“${part}”不是 <question> >= p 或 <question> < p`);
	if (!Object.hasOwn(declared, question))
		return invalid(`${key}: question.${question} is not declared`, `${key}：question.${question} 未声明`);
	const value = Number(rawValue);
	if (!(value > 0 && value <= 1)) return invalid(`${key}: ${rawValue} must be in (0, 1]`, `${key}：${rawValue} 必须在 (0, 1] 范围内`);
	return { kind: "ok", value: { question, op: op === ">=" ? "atLeast" : "below", value } };
}

function parseRules(fields: Readonly<Record<string, string>>, questions: Readonly<Record<string, NoulQuestion>>): Parsed<Rule[]> {
	const used = new Set<string>();
	const rules: Rule[] = [];
	for (const [key, raw] of Object.entries(fields)) {
		const name = key.match(RULE_KEY)?.[1];
		if (name === undefined) continue;
		const conditions: Comparison[] = [];
		for (const part of unquote(raw).split("&")) {
			const comparison = parseComparison(key, part.trim(), questions);
			if (comparison.kind === "invalid") return comparison;
			used.add(comparison.value.question);
			conditions.push(comparison.value);
		}
		rules.push({ name, conditions });
	}
	if (rules.length === 0) return invalid("needs at least one when.<name> rule", "至少需要一条 when.<name> 规则");
	const unused = Object.keys(questions).find((id) => !used.has(id));
	if (unused !== undefined)
		return invalid(`question.${unused} is used by no when.<name> rule`, `没有 when.<name> 规则使用 question.${unused}`);
	return { kind: "ok", value: rules };
}

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
			return tr(
				`${problem.key} must be system or user, not "${problem.value}"`,
				`${problem.key} 只能是 system 或 user，不能是“${problem.value}”`,
			);
		default: {
			const unreachable: never = problem;
			return unreachable;
		}
	}
}

function parseSkipTools(raw: string | undefined): Parsed<ReadonlySet<string>> {
	if (raw === undefined) return { kind: "ok", value: new Set() };
	const tools = raw
		.split(",")
		.map((item) => unquote(item))
		.filter((item) => item !== "");
	if (tools.length === 0) return invalid("skipTools lists nothing", "skipTools 未列出任何工具");
	return { kind: "ok", value: new Set(tools) };
}

export function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const detail = String(error);
		return invalid(`unreadable: ${detail}`, `无法读取：${detail}`);
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return invalid("missing frontmatter", "缺少 frontmatter");
	const { fields, body } = parsed;
	if (!isEnabled(fields)) return { kind: "disabled" };
	if (body.trim() !== "")
		return invalid("the body must be empty: questions are question.<id> keys", "正文必须为空：问题写在 question.<id> 键中");
	const prompt = fields.prompt === undefined ? "" : unquote(fields.prompt);
	if (prompt === "") return invalid("prompt is missing or empty", "缺少 prompt 或 prompt 为空");
	const maxBytes = parseMaxBytes(fields.maxbytes);
	if (maxBytes.kind === "invalid") return maxBytes;
	const filter = parseSessionFilter(fields, FILTER_KEYS, { kind: "default", targets: [{ kind: "main" }] }, "frontmatter");
	if (filter.kind === "invalid") return { kind: "invalid", reason: describeProblem(filter.problem) };
	const inject = parseInjectMode(fields.inject);
	if (inject.kind === "invalid") return { kind: "invalid", reason: describeProblem(inject.problem) };
	const skipTools = parseSkipTools(fields.skiptools);
	if (skipTools.kind === "invalid") return skipTools;
	const questions = parseQuestions(fields);
	if (questions.kind === "invalid") return questions;
	const rules = parseRules(fields, questions.value);
	if (rules.kind === "invalid") return rules;
	const label = basename(path)
		.replace(/^TURN-JUDGE-/i, "")
		.replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			questions: questions.value,
			rules: rules.value,
			prompt,
			maxBytes: maxBytes.value,
			filter: filter.value,
			inject: inject.value,
			skipTools: skipTools.value,
		},
	};
}
