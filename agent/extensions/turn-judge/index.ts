import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, NoulQuestion } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { askAnswers, formatAskAnswers } from "../_shared/ask-answers.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import {
	type FilterKeys,
	type FilterProblem,
	type InjectMode,
	parseInjectMode,
	parseSessionFilter,
	producerMatches,
	type SessionFilter,
	targetsSession,
} from "../_shared/session-filter.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { fitState, parseMaxBytes, type TimelineEntry, type TurnState } from "./state.ts";

const FILE_PATTERN = /^TURN-JUDGE-.+\.md$/i;
const QUESTION_KEY = /^question\.([a-z0-9_]+)(?:\.(true|false))?$/;
const RULE_KEY = /^when\.([a-z0-9_]+)$/;
const COMPARISON = /^([a-z0-9_]+)\s*(>=|<)\s*(\d*\.?\d+)$/;
const DEFAULT_MAX_BYTES = 30_000;
const JUDGE_TIMEOUT_MS = 90_000;
const SUB_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const REMINDER_MAX_CHARS = 400;
const FILTER_KEYS: FilterKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider" };
const PROMPT_CUSTOM_TYPE = "turn-judge";
const REMINDER_CUSTOM_TYPES: ReadonlySet<string> = new Set(["watchdog", PROMPT_CUSTOM_TYPE]);

type NoulCriteria = { readonly true?: string; readonly false?: string };

type TurnQuestion = { readonly id: string; readonly instructions: string; readonly criteria: NoulCriteria | null };

type Comparison = { readonly question: string; readonly op: "atLeast" | "below"; readonly value: number };

type Rule = { readonly name: string; readonly conditions: readonly Comparison[] };

type TurnJudgeSpec = {
	readonly name: string;
	readonly filePath: string;
	readonly questions: readonly TurnQuestion[];
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

type Before = { readonly timeline: readonly TimelineEntry[]; readonly toolCalls: readonly string[] };

type Verdict = Readonly<Record<string, number>>;

type JudgeResult = { readonly kind: "ok"; readonly verdict: Verdict } | { readonly kind: "failed"; readonly reason: string };

type Action = { readonly kind: "prompt"; readonly rule: string; readonly prompt: string } | { readonly kind: "info" };

type Judged =
	| { readonly kind: "failed"; readonly line: string }
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "prompt"; readonly line: string; readonly prompt: string; readonly inject: InjectMode };

type Report =
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "warning"; readonly line: string }
	| { readonly kind: "sent" };

type Delivery = { readonly kind: "sent" } | { readonly kind: "unsent"; readonly reason: string } | { readonly kind: "unconfirmed" };

const warnedFiles = new Set<string>();

type QuestionsParse =
	| { readonly kind: "ok"; readonly questions: readonly TurnQuestion[] }
	| { readonly kind: "invalid"; readonly reason: string };

function parseQuestions(fields: Readonly<Record<string, string>>): QuestionsParse {
	const instructions = new Map<string, string>();
	const yes = new Map<string, string>();
	const no = new Map<string, string>();
	for (const [key, raw] of Object.entries(fields)) {
		const m = key.match(QUESTION_KEY);
		const id = m?.[1];
		if (!m || id === undefined) continue;
		const value = unquote(raw);
		if (!value) return { kind: "invalid", reason: tr(`${key} is empty`, `${key} 为空`) };
		const side = m[2];
		if (side === undefined) instructions.set(id, value);
		else if (side === "true") yes.set(id, value);
		else no.set(id, value);
	}
	if (instructions.size === 0)
		return { kind: "invalid", reason: tr("needs at least one question.<id> entry", "至少需要一个 question.<id> 条目") };
	for (const id of [...yes.keys(), ...no.keys()]) {
		if (!instructions.has(id)) return { kind: "invalid", reason: tr(`question.${id} is not declared`, `question.${id} 未声明`) };
	}
	const questions: TurnQuestion[] = [];
	for (const [id, text] of instructions) {
		const whenYes = yes.get(id);
		const whenNo = no.get(id);
		const criteria: NoulCriteria | null =
			whenYes === undefined && whenNo === undefined
				? null
				: { ...(whenYes === undefined ? {} : { true: whenYes }), ...(whenNo === undefined ? {} : { false: whenNo }) };
		questions.push({ id, instructions: text, criteria });
	}
	return { kind: "ok", questions };
}

type RulesParse = { readonly kind: "ok"; readonly rules: readonly Rule[] } | { readonly kind: "invalid"; readonly reason: string };

function parseRules(fields: Readonly<Record<string, string>>, questions: readonly TurnQuestion[]): RulesParse {
	const declared = new Set(questions.map((q) => q.id));
	const used = new Set<string>();
	const rules: Rule[] = [];
	for (const [key, raw] of Object.entries(fields)) {
		const name = key.match(RULE_KEY)?.[1];
		if (name === undefined) continue;
		const conditions: Comparison[] = [];
		for (const part of unquote(raw).split("&")) {
			const m = part.trim().match(COMPARISON);
			const [, question, op, rawValue] = m ?? [];
			if (question === undefined || op === undefined || rawValue === undefined)
				return {
					kind: "invalid",
					reason: tr(
						`${key}: "${part.trim()}" is not <question> >= p or <question> < p`,
						`${key}：“${part.trim()}”不是 <question> >= p 或 <question> < p`,
					),
				};
			if (!declared.has(question))
				return { kind: "invalid", reason: tr(`${key}: question.${question} is not declared`, `${key}：question.${question} 未声明`) };
			const value = Number(rawValue);
			if (!(value > 0 && value <= 1))
				return { kind: "invalid", reason: tr(`${key}: ${rawValue} must be in (0, 1]`, `${key}：${rawValue} 必须在 (0, 1] 范围内`) };
			used.add(question);
			conditions.push({ question, op: op === ">=" ? "atLeast" : "below", value });
		}
		rules.push({ name, conditions });
	}
	if (rules.length === 0) return { kind: "invalid", reason: tr("needs at least one when.<name> rule", "至少需要一条 when.<name> 规则") };
	const unused = questions.find((q) => !used.has(q.id));
	if (unused !== undefined)
		return {
			kind: "invalid",
			reason: tr(`question.${unused.id} is used by no when.<name> rule`, `没有 when.<name> 规则使用 question.${unused.id}`),
		};
	return { kind: "ok", rules };
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

type SkipToolsParse = { readonly kind: "ok"; readonly tools: ReadonlySet<string> } | { readonly kind: "invalid"; readonly reason: string };

function parseSkipTools(raw: string | undefined): SkipToolsParse {
	if (raw === undefined) return { kind: "ok", tools: new Set() };
	const tools = raw
		.split(",")
		.map((item) => unquote(item))
		.filter((item) => item !== "");
	if (tools.length === 0) return { kind: "invalid", reason: tr("skipTools lists nothing", "skipTools 未列出任何工具") };
	return { kind: "ok", tools: new Set(tools) };
}

function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const detail = String(error);
		return { kind: "invalid", reason: tr(`unreadable: ${detail}`, `无法读取：${detail}`) };
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return { kind: "invalid", reason: tr("missing frontmatter", "缺少 frontmatter") };
	const { fields, body } = parsed;
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	if (body.trim() !== "")
		return {
			kind: "invalid",
			reason: tr("the body must be empty: questions are question.<id> keys", "正文必须为空：问题写在 question.<id> 键中"),
		};
	const prompt = fields.prompt === undefined ? "" : unquote(fields.prompt);
	if (prompt === "") return { kind: "invalid", reason: tr("prompt is missing or empty", "缺少 prompt 或 prompt 为空") };
	if (fields.maxchars !== undefined)
		return {
			kind: "invalid",
			reason: tr("maxChars was renamed to maxBytes", "maxChars 已改名为 maxBytes（maxChars was renamed to maxBytes）"),
		};
	let maxBytes = DEFAULT_MAX_BYTES;
	if (fields.maxbytes !== undefined) {
		const parsed = parseMaxBytes(unquote(fields.maxbytes));
		if (parsed.kind === "invalid") return parsed;
		maxBytes = parsed.value;
	}
	const filter = parseSessionFilter(fields, FILTER_KEYS, { kind: "default", targets: [{ kind: "main" }] }, "frontmatter");
	if (filter.kind === "invalid") return { kind: "invalid", reason: describeProblem(filter.problem) };
	const inject = parseInjectMode(fields.inject);
	if (inject.kind === "invalid") return { kind: "invalid", reason: describeProblem(inject.problem) };
	const skipTools = parseSkipTools(fields.skiptools);
	if (skipTools.kind === "invalid") return skipTools;
	const questions = parseQuestions(fields);
	if (questions.kind === "invalid") return questions;
	const rules = parseRules(fields, questions.questions);
	if (rules.kind === "invalid") return rules;
	const label = basename(path)
		.replace(/^TURN-JUDGE-/i, "")
		.replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			filePath: path,
			questions: questions.questions,
			rules: rules.rules,
			prompt,
			maxBytes,
			filter: filter.value,
			inject: inject.value,
			skipTools: skipTools.tools,
		},
	};
}

function notify(pi: ExtensionAPI, ctx: ExtensionContext, lines: readonly string[], level: "info" | "warning"): void {
	if (lines.length === 0) return;
	const text = lines.join("\n");
	if (ctx.hasUI) ctx.ui.notify(text, level);
	if (level === "warning") pi.logger.warn(text);
	else pi.logger.info(text);
}

function applyingSpecs(pi: ExtensionAPI, ctx: ExtensionContext, message: AssistantMessage): TurnJudgeSpec[] {
	const specs: TurnJudgeSpec[] = [];
	const warnings: string[] = [];
	for (const path of discoverSpecFiles(FILE_PATTERN, import.meta.dir, ctx.cwd)) {
		const parsed = parseSpecFile(path);
		switch (parsed.kind) {
			case "ok":
				if (targetsSession(parsed.spec.filter, ctx.agent, ctx.cwd) && producerMatches(parsed.spec.filter, message)) specs.push(parsed.spec);
				break;
			case "disabled":
				break;
			case "invalid": {
				const key = `${path}\0${parsed.reason}`;
				if (warnedFiles.has(key)) break;
				warnedFiles.add(key);
				warnings.push(tr(`turn-judge: skipped ${path}: ${parsed.reason}`, `turn-judge：跳过 ${path}：${parsed.reason}`));
				break;
			}
			default: {
				const unreachable: never = parsed;
				return unreachable;
			}
		}
	}
	notify(pi, ctx, warnings, "warning");
	return specs;
}

function assistantEvents(message: AssistantMessage, withText: boolean): TimelineEntry[] {
	const events: TimelineEntry[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "thinking": {
				const text = block.thinking.trim();
				if (text !== "") events.push({ 类型: block.narration === true ? "模型说" : "模型想", 内容: text });
				break;
			}
			case "text": {
				const text = block.text.trim();
				if (withText && text !== "") events.push({ 类型: "模型说", 内容: text });
				break;
			}
			case "toolCall": {
				const intent = block.intent?.trim();
				events.push({ 类型: "模型调用工具", 内容: intent ? `${block.name}：${intent}` : block.name });
				break;
			}
			default:
				break;
		}
	}
	return events;
}

function reminder(text: string): TimelineEntry {
	return { 类型: "提醒", 内容: text.length > REMINDER_MAX_CHARS ? `${text.slice(0, REMINDER_MAX_CHARS)}…` : text };
}

function before(ctx: ExtensionContext, judged: AssistantMessage): Before {
	const main = ctx.agent.kind === "main";
	const timeline = assistantEvents(judged, false)
		.filter((event) => event.类型 !== "模型调用工具")
		.reverse();
	const toolCalls: string[] = [];
	const visited = new Set<string>();
	let windowOpen = true;
	let callsOpen = true;
	for (let id = ctx.sessionManager.getLeafId(); (windowOpen || callsOpen) && id !== null && !visited.has(id); ) {
		visited.add(id);
		const entry = ctx.sessionManager.getEntry(id);
		if (entry === undefined) break;
		id = entry.parentId;
		if (entry.type === "custom_message") {
			if (!REMINDER_CUSTOM_TYPES.has(entry.customType) || Date.parse(entry.timestamp) >= judged.timestamp) continue;
			if (!windowOpen) continue;
			const text = textOf(entry.content, "\n").trim();
			if (text !== "") timeline.push(reminder(text));
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.timestamp >= judged.timestamp) continue;
		if (message.role === "user") {
			if (!windowOpen) continue;
			const text = textOf(message.content, "\n").trim();
			if (text === "") continue;
			const human = message.synthetic !== true && (!main || message.attribution === "user");
			if (human) windowOpen = false;
			timeline.push(human ? { 类型: "用户说", 内容: text } : reminder(text));
			continue;
		}
		if (message.role === "assistant") {
			if (callsOpen) {
				if (message.stopReason === "stop") callsOpen = false;
				else
					for (let i = message.content.length - 1; i >= 0; i--) {
						const block = message.content[i];
						if (block !== undefined && block.type === "toolCall") toolCalls.push(block.name);
					}
			}
			if (windowOpen) timeline.push(...assistantEvents(message, true).reverse());
			continue;
		}
		if (message.role === "toolResult" && windowOpen) {
			const answers = askAnswers(message);
			if (answers !== null) timeline.push({ 类型: "用户在ask中回答", 内容: formatAskAnswers(answers) });
		}
	}
	timeline.reverse();
	return { timeline, toolCalls: toolCalls.reverse() };
}

function hasMessageAfter(ctx: ExtensionContext, judgedTimestamp: number): boolean {
	const visited = new Set<string>();
	for (let id = ctx.sessionManager.getLeafId(); id !== null && !visited.has(id); ) {
		visited.add(id);
		const entry = ctx.sessionManager.getEntry(id);
		if (entry === undefined) return false;
		id = entry.parentId;
		if (entry.type === "message") return entry.message.timestamp > judgedTimestamp;
	}
	return false;
}

async function runJudge(judge: Judge, spec: TurnJudgeSpec, state: TurnState, signal: AbortSignal): Promise<JudgeResult> {
	try {
		const questions: Record<string, NoulQuestion> = {};
		for (const q of spec.questions)
			questions[q.id] =
				q.criteria === null
					? { type: "noul", instructions: q.instructions }
					: { type: "noul", instructions: q.instructions, criteria: q.criteria };
		const result = await judge.judge({ state, questions }, { signal });
		const verdict: Record<string, number> = {};
		for (const q of spec.questions) {
			const answer = result.answers[q.id];
			if (answer === undefined) return { kind: "failed", reason: tr(`no answer for question.${q.id}`, `question.${q.id} 没有回答`) };
			verdict[q.id] = answer.noul;
		}
		return { kind: "ok", verdict };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

function holds(condition: Comparison, verdict: Verdict): boolean {
	const p = verdict[condition.question] ?? 0;
	switch (condition.op) {
		case "atLeast":
			return p >= condition.value;
		case "below":
			return p < condition.value;
		default: {
			const unreachable: never = condition.op;
			return unreachable;
		}
	}
}

function decide(spec: TurnJudgeSpec, verdict: Verdict): Action {
	const rule = spec.rules.find((r) => r.conditions.every((c) => holds(c, verdict)));
	return rule === undefined ? { kind: "info" } : { kind: "prompt", rule: rule.name, prompt: spec.prompt };
}

function describeVerdict(spec: TurnJudgeSpec, verdict: Verdict, action: Action): string {
	const parts = spec.questions.map((q) => `${q.id} ${(verdict[q.id] ?? 0).toFixed(2)}`).join(" · ");
	switch (action.kind) {
		case "prompt":
			return tr(`turn-judge ${spec.name}: when.${action.rule} (${parts})`, `turn-judge ${spec.name}：when.${action.rule}（${parts}）`);
		case "info":
			return tr(`turn-judge ${spec.name}: no rule (${parts})`, `turn-judge ${spec.name}：未命中规则（${parts}）`);
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

type Prepared = { readonly spec: TurnJudgeSpec; readonly state: TurnState };

function prepareJudgments(specs: readonly TurnJudgeSpec[], context: Before, reply: string): Prepared[] {
	const byBudget = new Map<number, TurnState>();
	return specs.map((spec) => {
		let state = byBudget.get(spec.maxBytes);
		if (state === undefined) {
			state = fitState(context.timeline, reply, spec.maxBytes);
			byBudget.set(spec.maxBytes, state);
		}
		return { spec, state };
	});
}

async function judgeSpec(judge: Judge, spec: TurnJudgeSpec, state: TurnState, signal: AbortSignal): Promise<Judged> {
	const result = await runJudge(judge, spec, state, signal);
	switch (result.kind) {
		case "failed":
			return {
				kind: "failed",
				line: tr(`turn-judge ${spec.name}: judgment failed (${result.reason})`, `turn-judge ${spec.name}：判断失败（${result.reason}）`),
			};
		case "ok":
			break;
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
	const action = decide(spec, result.verdict);
	const line = describeVerdict(spec, result.verdict, action);
	switch (action.kind) {
		case "info":
			return { kind: "info", line };
		case "prompt":
			return { kind: "prompt", line, prompt: action.prompt, inject: spec.inject };
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

async function waitUntil(ready: () => boolean, signal: AbortSignal): Promise<boolean> {
	while (!ready()) {
		if (signal.aborted) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

type Admission = { readonly matches: (message: AgentMessage) => boolean; readonly settle: (admitted: boolean) => void };

type AdmissionWatcher = {
	watch(matches: (message: AgentMessage) => boolean, signal: AbortSignal): Promise<boolean>;
};

function createAdmissionWatcher(pi: ExtensionAPI): AdmissionWatcher {
	const pending = new Set<Admission>();
	pi.on("message_start", (event) => {
		for (const admission of pending) if (admission.matches(event.message)) admission.settle(true);
	});
	return {
		watch(matches, signal) {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const admission: Admission = {
				matches,
				settle(admitted) {
					pending.delete(admission);
					signal.removeEventListener("abort", abort);
					resolve(admitted);
				},
			};
			const abort = () => admission.settle(false);
			pending.add(admission);
			if (signal.aborted) admission.settle(false);
			else signal.addEventListener("abort", abort, { once: true });
			return promise;
		},
	};
}

type SubPrompts = { readonly system: string; readonly user: string };

/**
 * Prompt dispatch
 * awaits preprocessing before the session reports busy; returning earlier
 * would let the executor collect the judged report instead.
 */
async function deliverToSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	admissions: AdmissionWatcher,
	prompts: SubPrompts,
	judgedTimestamp: number,
	deadline: AbortSignal,
): Promise<Delivery> {
	if (deadline.aborted) return { kind: "unsent", reason: tr("judgment timed out", "判断超出时限") };
	if (!(await waitUntil(() => ctx.isIdle(), deadline)))
		return { kind: "unsent", reason: tr("subagent did not become idle in time", "时限内子会话未空闲") };
	if (hasMessageAfter(ctx, judgedTimestamp))
		return { kind: "unsent", reason: tr("a new message arrived before the judgment returned", "判断返回前已有新消息") };
	let admitted: Promise<boolean>;
	if (prompts.user === "") {
		const deliveryId = crypto.randomUUID();
		admitted = admissions.watch(
			(message) =>
				message.role === "custom" &&
				message.customType === PROMPT_CUSTOM_TYPE &&
				typeof message.details === "object" &&
				message.details !== null &&
				"deliveryId" in message.details &&
				message.details.deliveryId === deliveryId,
			deadline,
		);
		pi.sendMessage(
			{ customType: PROMPT_CUSTOM_TYPE, content: prompts.system, display: true, attribution: "agent", details: { deliveryId } },
			{ triggerTurn: true },
		);
	} else {
		if (prompts.system !== "")
			pi.sendMessage(
				{ customType: PROMPT_CUSTOM_TYPE, content: prompts.system, display: true, attribution: "agent" },
				{ deliverAs: "steer" },
			);
		admitted = admissions.watch((message) => message.role === "user" && message.timestamp > judgedTimestamp, deadline);
		pi.sendUserMessage(prompts.user, { attribution: "agent" });
	}
	return (await admitted) ? { kind: "sent" } : { kind: "unconfirmed" };
}

async function judgeSubagentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	admissions: AdmissionWatcher,
	specs: readonly TurnJudgeSpec[],
	context: Before,
	message: AssistantMessage,
	reply: string,
	deadline: AbortSignal,
): Promise<void> {
	const opened = openJudge(ctx, "turn-judge");
	if (opened.kind === "inactive") return;
	const judged = await Promise.all(
		prepareJudgments(specs, context, reply).map(({ spec, state }) => judgeSpec(opened.judge, spec, state, deadline)),
	);
	const warnings = judged.flatMap((j) => (j.kind === "failed" ? [j.line] : []));
	const infos = judged.flatMap((j) => (j.kind === "info" ? [j.line] : []));
	const triggered = judged.flatMap((j) => (j.kind === "prompt" ? [j] : []));
	if (triggered.length > 0) {
		const joined = (inject: InjectMode): string =>
			triggered
				.filter((t) => t.inject === inject)
				.map((t) => t.prompt)
				.join("\n\n");
		const delivery = await deliverToSubagent(
			pi,
			ctx,
			admissions,
			{ system: joined("system"), user: joined("user") },
			message.timestamp,
			deadline,
		);
		const tag = `${ctx.agent.name} (${ctx.agent.id})`;
		switch (delivery.kind) {
			case "sent":
				infos.push(...triggered.map((t) => tr(`${t.line} → prompt (${tag})`, `${t.line} → 提示（${tag}）`)));
				break;
			case "unsent":
				infos.push(
					...triggered.map((t) =>
						tr(`${t.line}; ${delivery.reason}, prompt not sent (${tag})`, `${t.line}；${delivery.reason}，未发送提示（${tag}）`),
					),
				);
				break;
			case "unconfirmed":
				warnings.push(
					...triggered.map((t) =>
						tr(
							`${t.line} → prompt (${tag}); the start of a new turn was not confirmed within the deadline, so the parent agent may receive the original reply`,
							`${t.line} → 提示（${tag}）；时限内未确认新回合开始，父代理可能收到原回复`,
						),
					),
				);
				break;
			default: {
				const unreachable: never = delivery;
				return unreachable;
			}
		}
	}
	notify(pi, ctx, warnings, "warning");
	notify(pi, ctx, infos, "info");
}

export default function turnJudge(pi: ExtensionAPI): void {
	const admissions = createAdmissionWatcher(pi);
	let epoch = 0;

	const settleMain = (ctx: ExtensionContext, judged: Judged, startedAt: number): Report => {
		switch (judged.kind) {
			case "failed":
				return { kind: "warning", line: judged.line };
			case "info":
				return { kind: "info", line: judged.line };
			case "prompt":
				if (epoch !== startedAt)
					return {
						kind: "info",
						line: tr(
							`${judged.line}; new input arrived before the judgment returned, prompt not sent`,
							`${judged.line}；判断返回前已有新输入，未发送提示`,
						),
					};
				pi.logger.info(`${judged.line} → prompt (${judged.inject})`);
				switch (judged.inject) {
					case "system":
						pi.sendMessage(
							{ customType: PROMPT_CUSTOM_TYPE, content: judged.prompt, display: true, attribution: "agent" },
							ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
						);
						break;
					case "user":
						pi.sendUserMessage(judged.prompt, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
						break;
					default: {
						const unreachable: never = judged.inject;
						throw new Error(`unknown inject mode ${String(unreachable)}`);
					}
				}
				return { kind: "sent" };
			default: {
				const unreachable: never = judged;
				return unreachable;
			}
		}
	};

	const judgeMainTurn = async (ctx: ExtensionContext, specs: readonly TurnJudgeSpec[], context: Before, reply: string) => {
		const startedAt = epoch;
		const opened = openJudge(ctx, "turn-judge");
		if (opened.kind === "inactive") return;
		void Promise.all(
			prepareJudgments(specs, context, reply).map(async ({ spec, state }) =>
				settleMain(ctx, await judgeSpec(opened.judge, spec, state, AbortSignal.timeout(JUDGE_TIMEOUT_MS)), startedAt),
			),
		)
			.then((reports) => {
				notify(
					pi,
					ctx,
					reports.flatMap((r) => (r.kind === "warning" ? [r.line] : [])),
					"warning",
				);
				notify(
					pi,
					ctx,
					reports.flatMap((r) => (r.kind === "info" ? [r.line] : [])),
					"info",
				);
			})
			.catch((error) => {
				pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
			});
	};

	pi.on("input", (event) => {
		if (event.source !== "extension") epoch += 1;
	});
	pi.on("session_switch", () => {
		epoch += 1;
	});
	pi.on("session_branch", () => {
		epoch += 1;
	});
	pi.on("session_tree", () => {
		epoch += 1;
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			const message = event.message;
			if (message.role !== "assistant" || message.stopReason !== "stop") return;
			const deadline = ctx.agent.kind === "sub" ? AbortSignal.timeout(SUB_DEADLINE_MS) : null;
			const reply = textOf(message.content, "\n").trim();
			if (reply === "") return;
			const scoped = applyingSpecs(pi, ctx, message);
			if (scoped.length === 0) return;
			const context = before(ctx, message);
			const specs = scoped.filter((spec) => !context.toolCalls.some((name) => spec.skipTools.has(name)));
			if (specs.length === 0) return;
			if (deadline === null) await judgeMainTurn(ctx, specs, context, reply);
			else await judgeSubagentTurn(pi, ctx, admissions, specs, context, message, reply, deadline);
		} catch (error) {
			pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
		}
	});
}
