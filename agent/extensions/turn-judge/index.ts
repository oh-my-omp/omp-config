// ============================================================================
// turn-judge — after every turn of a session a `TURN-JUDGE-*.md` file targets,
// ask JUDGE (`openJudge`, purpose `turn-judge`) that file's yes/no questions
// about the turn, then either report the answers or, when one of the file's
// rules holds, send the configured prompt.
// Registers input, session_switch/branch/tree, and message_end hooks; no tools
// or commands. Reads adjacent/repository specs and session history; writes no
// files. Runs in main and sub sessions.
//
// FILE FORMAT. `TURN-JUDGE-<label>.md`, discovered like `WATCHDOG-*.md`:
//   - user level:  <extension dir>/TURN-JUDGE-*.md      (beside this index.ts)
//   - repo level:  <dir>/TURN-JUDGE-*.md and <dir>/.omp/TURN-JUDGE-*.md,
//                  walking from cwd up to the git root.
// Frontmatter (between `---` fences), one `key: value` per line; whole-line `#`
// comments are skipped. Keys are lowercased.
//   name:    example                     # optional; defaults to the file label
//   enabled: true                        # optional; only true/yes/on/1 keep it on
//   target:  main, task:mid              # optional; default main, see SCOPE
//   cwd:     ~/code/app{,/**}            # optional; globs, see SCOPE
//   model:   opus                        # optional; regex, see SCOPE
//   provider: ^anthropic$                # optional; regex, see SCOPE
//   skipTools: wt, harness_restart       # optional; tool names, see SCOPE
//   inject:  system                      # optional; system (default) | user, see OUTCOME
//   maxBytes: 30000                      # optional; state budget in bytes, at most 65536 (64KB), see STATE
//   question.<id>: <instructions>       # >= 1; one Noul (yes/no) question each
//   question.<id>.true: <criterion>     # optional; what a yes means
//   question.<id>.false: <criterion>    # optional; what a no means
//   when.<name>: a >= 0.7 & b < 0.3     # >= 1 rule; see OUTCOME
//   prompt:  <text>                     # required; sent when a rule holds
// Ids and rule names are `[a-z0-9_]+`. Every declared question appears in at
// least one rule. The body stays empty.
//
// SCOPE. `target`, `cwd`, `model` and `provider` follow
// `_shared/session-filter.ts` (the grammar watchdog-agent uses); items inside a
// key are alternatives, keys AND. `target` is a comma list (`[a, b]` brackets
// and quotes accepted, case-insensitive) of `main`, `subagents` (also
// `subagent`, `sub`, `subs`), `*` (also `all`, `any`), or a subagent's
// definition name (`task:mid`, `mentor:default`) or registry id; without the
// key a file targets `main`. `cwd` is a comma list of Bun globs, each absolute
// or `~/`-prefixed, matched against the normalized session cwd (`/a/repo`
// that directory only, `/a/repo/**` its subdirectories only, `/a/repo{,/**}`
// both); without the key any directory matches. `model` and `provider` are
// one JavaScript regex each (alternatives with `|`), unanchored
// `RegExp.test`, against the judged message's own `model` and `provider` (the
// model that produced the turn, not `upstreamModel`). A key that lists
// nothing, a relative cwd pattern, an empty or bad regex, or an `inject`
// other than system/user makes the file invalid. `skipTools` is a comma
// list of tool names: a turn that called any of them is not judged by the
// file, e.g. a turn that queued a session move (`wt`, `harness_restart`),
// which runs only after the turn ends. The turn's calls are those of every
// assistant message after the previous one that ended with `stopReason:
// "stop"`, so a turn a prompt (human, turn-judge or harness) starts after a
// stop counts from zero; calls inside the judged message itself have not run
// and do not count. A `skipTools` that lists nothing makes the file invalid. A file
// judges a turn only when its target and cwd cover the session, every regex it sets
// matches and no skip tool was called. Files that do not apply cost nothing:
// no JUDGE request, and no branch walk unless a file passes the target, cwd and
// model checks.
//
// TURN. A turn is an assistant message the model ended itself
// (`stopReason: "stop"`) with nonempty text. Aborted, errored and tool-use
// messages are not turns. With `task.structured` off (OMP's default), a
// subagent's final report is such a message, and so is its reply to an IRC
// wake. Files are re-read at every turn, so edits apply to the next turn.
//
// STATE. Each file is one separate judge request, carrying all of the file's
// questions, whose state is
//   { 时间线: [{ 类型, 内容 }...], 本轮回复 }
// 时间线 covers the work the judged turn belongs to: it starts at the last
// human prompt on the current branch and runs to the judged message, one
// entry per event in the order it happened. A human prompt is a non-synthetic
// user-role prompt: in a main session only the human's own (`attribution:
// "user"`), in a subagent any (its assignment and the parent's messages).
//   用户说        that human prompt, always the first entry (absent only when
//                the branch has none).
//   用户在ask中回答  what the user chose or typed in an `ask` call, one line per
//                answered question (`question → answer`); a cancelled,
//                refused or unanswered ask adds nothing.
//   提醒          any later user-role prompt that is not a human prompt (a
//                harness or extension reminder, a user-form turn-judge
//                prompt) and any custom message of type `watchdog` or
//                `turn-judge` (system-form notes and prompts); only its
//                first 400 characters.
//   模型想        a thinking block's text (GPT and Gemini send a summary of
//                their reasoning; Claude sends its reasoning). Redacted and
//                empty blocks are left out.
//   模型说        an assistant text block, or a thinking block the provider
//                marks as narration addressed to the user.
//   模型调用工具  a tool call, as `name：intent` (the harness intent the call
//                carries; just the name when it has none). Arguments and
//                results are left out, except the ask answers above.
// The judged message's own thinking closes the 时间线; its text is 本轮回复.
// When the state's serialized UTF-8 size would exceed `maxBytes`, 本轮回复 and
// 用户说 are cut to their head and older entries drop whole; the newest entry is
// cut to its head, never dropped. 用户说 itself is never dropped.
//
// OUTCOME. JUDGE answers each question with the probability of yes. A rule
// holds when every one of its comparisons holds (`>= p`: probability at least
// p; `< p`: below p); the first holding rule, in file order, triggers the
// file's prompt. Otherwise the file's answers are reported. A turn the prompt
// itself causes is judged like any other; nothing caps it.
// `inject` sets how a triggered prompt reaches the agent, verbatim either way:
// `system` (default) as a `turn-judge` custom message on OMP's harness-notice
// channel (`developer` where the provider has that role, a mid-conversation
// system message on Anthropic models that support one, otherwise a user-role
// message); `user` as an agent-attributed
// user message.
//   Main session: judgments run in the background. A triggered file's prompt
//   is sent in its inject form (idle → starts a turn, busy → follow-up).
//   Untriggered files share one info notification after
//   all of the turn's judgments settle (consecutive UI notifications replace
//   each other). If the user sends a prompt or moves the session before a
//   verdict returns, that verdict is reported and nothing is sent.
//   Subagent: the message_end handler awaits the judgments, and the task
//   executor waits for in-flight message_end handlers before it collects the
//   subagent's result. Everything shares one SUB_DEADLINE_MS budget from the
//   handler's start, below OMP's 30 s extension-handler cap; a judgment still
//   running then fails. When files trigger, the deadline has not passed and no
//   message has entered the branch after the judged one, the handler waits for
//   the session to go idle and sends the triggered prompts (file order, blank-
//   line separated) joined per inject form: user-form prompts as ONE user
//   message that starts a new turn, with the system-form ones as one custom
//   message joining it; system-form prompts alone as ONE custom message that
//   starts the turn and carries a `deliveryId`. It returns once the host admits
//   that turn — the prompt's own message entering the round: for system-form
//   alone the custom message with that `deliveryId`, for user-form a user
//   message newer than the judged one — or the deadline passes. The
//   subagent's reply to it replaces the judged report
//   as the result its parent receives, so a prompt meant for subagents should
//   ask for the complete revised report; a file that keeps triggering keeps
//   the subagent from returning. A prompt that misses the deadline or meets a
//   newer message is reported, not sent. While the handler waits, later
//   extensions' message_end handlers for the same message wait too.
//   Subagent sessions have no UI: their reports and warnings go to the log.
//
// AVAILABILITY. No applying file: nothing runs — no request and no report.
// Models come from `openJudge` (`_shared/judge.ts`, purpose `turn-judge`): the
// `@turn-judge` role's chat models when assigned, otherwise the JUDGE role
// chain; the `judge` fallback role's chat models follow either as prompted
// judges (one-hot probabilities). No path resolves a model: silently inactive.
// Role changes apply on the next turn. A
// failed request warns for that turn; an invalid file warns once per process
// (per path and reason). Sessions without UI only log. Nothing blocks or
// changes the turn itself.
// ============================================================================

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
/** Whole subagent handler budget; OMP stops waiting for an extension handler after 30 s. */
const SUB_DEADLINE_MS = 20_000;
/** Poll interval while a subagent handler waits for idle or for its prompt's turn. */
const POLL_MS = 25;
/** A 提醒 keeps its head only: harness attachments (post-compaction context lists) run to thousands of characters. */
const REMINDER_MAX_CHARS = 400;
const FILTER_KEYS: FilterKeys = { target: "target", cwd: "cwd", model: "model", provider: "provider" };
/** Custom message type of system-form prompts (`details.deliveryId` on a subagent's). */
const PROMPT_CUSTOM_TYPE = "turn-judge";
/** Custom message types that are notes to the judged agent, so the timeline lists them as 提醒: watchdog-agent's system-form notes and this extension's prompts. */
const REMINDER_CUSTOM_TYPES: ReadonlySet<string> = new Set(["watchdog", PROMPT_CUSTOM_TYPE]);

/** What yes and no mean for one Noul; either side may be left to the instructions. */
type NoulCriteria = { readonly true?: string; readonly false?: string };

/** One Noul question: the probability that its statement about the turn holds. */
type TurnQuestion = { readonly id: string; readonly instructions: string; readonly criteria: NoulCriteria | null };

/** `question >= value` (atLeast) or `question < value` (below) on that question's probability. */
type Comparison = { readonly question: string; readonly op: "atLeast" | "below"; readonly value: number };

/** A conjunction of comparisons; the file's prompt is sent when any rule holds. */
type Rule = { readonly name: string; readonly conditions: readonly Comparison[] };

type TurnJudgeSpec = {
	readonly name: string;
	readonly filePath: string;
	readonly questions: readonly TurnQuestion[];
	readonly rules: readonly Rule[];
	readonly prompt: string;
	readonly maxBytes: number;
	/** Tool names whose call in the judged turn skips this file. */
	readonly skipTools: ReadonlySet<string>;
	readonly filter: SessionFilter;
	readonly inject: InjectMode;
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: TurnJudgeSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

/**
 * What the branch up to the judged message contributes to every file: the
 * timeline, and the tool names called since the previous stop (for `skipTools`).
 */
type Before = { readonly timeline: readonly TimelineEntry[]; readonly toolCalls: readonly string[] };

/** Probability of yes per question id. */
type Verdict = Readonly<Record<string, number>>;

type JudgeResult = { readonly kind: "ok"; readonly verdict: Verdict } | { readonly kind: "failed"; readonly reason: string };

type Action = { readonly kind: "prompt"; readonly rule: string; readonly prompt: string } | { readonly kind: "info" };

/** One file's judgment of one turn, before anything is sent. */
type Judged =
	| { readonly kind: "failed"; readonly line: string }
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "prompt"; readonly line: string; readonly prompt: string; readonly inject: InjectMode };

/** What one main-session judgment leaves for the turn's notification. */
type Report =
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "warning"; readonly line: string }
	| { readonly kind: "sent" };

/** How a subagent's triggered prompt fared. */
type Delivery = { readonly kind: "sent" } | { readonly kind: "unsent"; readonly reason: string } | { readonly kind: "unconfirmed" };

/** `path\0reason` of invalid files already reported, so a broken file warns once per process. */
const warnedFiles = new Set<string>();

// --- discovery + parsing ----------------------------------------------------

type QuestionsParse =
	| { readonly kind: "ok"; readonly questions: readonly TurnQuestion[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `question.<id>[.true|.false]` keys into Noul questions, in declaration order. */
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
		// QUESTION_KEY admits exactly these suffixes; no cast of file input is needed.
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

/** Parse `when.<name>: <id> >= p & <id> < p …` rules over the declared questions; every question must feed a rule. */
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

/** UI wording of a frontmatter filter or inject problem. */
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

// --- reporting ------------------------------------------------------------------

function notify(pi: ExtensionAPI, ctx: ExtensionContext, lines: readonly string[], level: "info" | "warning"): void {
	if (lines.length === 0) return;
	const text = lines.join("\n");
	if (ctx.hasUI) ctx.ui.notify(text, level);
	if (level === "warning") pi.logger.warn(text);
	else pi.logger.info(text);
}

/** The enabled, valid files that apply to this turn; invalid ones warn once per process. */
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

// --- turn state ---------------------------------------------------------------

/** The thinking, text and tool-call events of one assistant message, in block order. */
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
				// Redacted thinking, images and provider-specific blocks carry nothing the judge can read.
				break;
		}
	}
	return events;
}

/** A 提醒 entry, cut to its head. */
function reminder(text: string): TimelineEntry {
	return { 类型: "提醒", 内容: text.length > REMINDER_MAX_CHARS ? `${text.slice(0, REMINDER_MAX_CHARS)}…` : text };
}

/**
 * The timeline from the last human prompt to the judged message (whose
 * thinking closes it; its text is the reply), and the tool names called since
 * the previous stop. Read from the leaf back: the timeline stops at the last
 * human prompt and the tool names at the previous stop, so entries older than
 * that prompt only have their metadata read.
 */
function before(ctx: ExtensionContext, judged: AssistantMessage): Before {
	const main = ctx.agent.kind === "main";
	// Newest first while walking back; the judged message's own thinking opens
	// the list, and the walk reverses it into chronological order at the end.
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
			// System-form notes reach the agent as custom messages; they are reminders like agent-attributed prompts.
			if (!REMINDER_CUSTOM_TYPES.has(entry.customType) || Date.parse(entry.timestamp) >= judged.timestamp) continue;
			if (!windowOpen) continue;
			const text = textOf(entry.content, "\n").trim();
			if (text !== "") timeline.push(reminder(text));
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		// Newer than the judged message: the forward read stopped before these.
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
			// A stop ends the previous turn, so its calls never count; the walk
			// has then collected every call the judged turn made.
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
			// The user's decisions made in `ask` are the user speaking; a cancelled or refused ask is not.
			const answers = askAnswers(message);
			if (answers !== null) timeline.push({ 类型: "用户在ask中回答", 内容: formatAskAnswers(answers) });
		}
	}
	timeline.reverse();
	return { timeline, toolCalls: toolCalls.reverse() };
}

/** Whether the branch's latest message is newer than the judged one. */
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

// --- judging --------------------------------------------------------------------

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

/** The first rule, in declaration order, whose every comparison holds; else info. */
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

/** One file's judgment input: the file and the state it judges. */
type Prepared = { readonly spec: TurnJudgeSpec; readonly state: TurnState };

/**
 * Each file with the state it judges. Files that ask for the same `maxBytes`
 * share one fitted state: their timeline and reply are the same input.
 */
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

// --- subagent delivery --------------------------------------------------------

/** Poll `ready` until it holds (true) or `signal` aborts (false). */
async function waitUntil(ready: () => boolean, signal: AbortSignal): Promise<boolean> {
	while (!ready()) {
		if (signal.aborted) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

/** One prompt the host has not admitted yet: the message that confirms it, and how to settle the wait. */
type Admission = { readonly matches: (message: AgentMessage) => boolean; readonly settle: (admitted: boolean) => void };

/**
 * Admission of a delivered prompt, observed from the host's `message_start`
 * event: the message the loop took into the round. A wait is registered before
 * the prompt is sent, so a prompt admitted immediately cannot be missed.
 */
type AdmissionWatcher = {
	/** Resolves once a started message `matches`, or false when `signal` aborts first. */
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

/** Triggered prompts of one subagent turn, joined per inject form; an empty string has none. */
type SubPrompts = { readonly system: string; readonly user: string };

/**
 * Start the prompts' turn in an idle subagent and wait until the session has
 * admitted it, so the executor's idle wait covers that turn. Prompt dispatch
 * awaits preprocessing before the session reports busy; returning earlier
 * would let the executor collect the judged report instead. With user-form
 * prompts, they start the turn and the system-form ones join it (appended while
 * idle, steered once it runs); with system-form prompts only, their custom
 * message starts the turn and its `deliveryId` confirms it.
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

// --- extension --------------------------------------------------------------------

export default function turnJudge(pi: ExtensionAPI): void {
	const admissions = createAdmissionWatcher(pi);
	/** Bumped by every human prompt and session move; a main verdict from an older epoch is shown, never typed. */
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

	/** Start the main session's judgments in the background; one notification per turn once all settle. */
	const judgeMainTurn = async (ctx: ExtensionContext, specs: readonly TurnJudgeSpec[], context: Before, reply: string) => {
		const startedAt = epoch;
		const opened = openJudge(ctx, "turn-judge");
		if (opened.kind === "inactive") return;
		// One notification per turn: consecutive UI notifications replace each other.
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
			// The subagent budget starts with the handler: OMP's handler cap counts from here.
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
