// ============================================================================
// turn-judge — after every turn of a session a `TURN-JUDGE-*.md` file targets,
// ask OMP's native JUDGE that file's question about the turn, then either
// report the verdict or type the configured prompt.
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
//   model:   opus                        # optional; regex, see SCOPE
//   provider: ^anthropic$                # optional; regex, see SCOPE
//   maxChars: 30000                      # optional; history budget, see STATE
//   option.<label>: <criteria>           # >= 2 options; empty criteria = the label says it all
//   option.<label>.prompt: <text>        # optional; typed as a user prompt when triggered
//   option.<label>.threshold: 0.7        # required with .prompt, in (0, 1]
// Labels are any text without `.` or spaces. Body = the question, sent verbatim.
//
// SCOPE. `target` takes watchdog-agent's grammar: a comma list (`[a, b]`
// brackets and quotes accepted, case-insensitive) of `main`, `subagents`
// (also `subagent`, `sub`, `subs`), `*` (also `all`, `any`), or a subagent's
// definition name (`task:mid`, `mentor:default`) or registry id. Without the
// key a file targets `main`; a key that lists nothing makes the file invalid.
// `model` and `provider` follow append-system-model: JavaScript regexes,
// unanchored `RegExp.test`, against the judged message's own `model` and
// `provider` (the model that produced the turn, not `upstreamModel`); an
// empty value or a bad regex makes the file invalid. A file judges a turn only
// when its target covers the session and every regex it sets matches. Files
// that do not apply cost nothing: no history walk and no JUDGE request.
//
// TURN. A turn is an assistant message the model ended itself
// (`stopReason: "stop"`) with nonempty text. Aborted, errored and tool-use
// messages are not turns. With `task.structured` off (OMP's default), a
// subagent's final report is such a message, and so is its reply to an IRC
// wake. Files are re-read at every turn, so edits apply to the next turn.
//
// STATE. Each file is one separate judge request whose state is
//   { 过去的记录: [{ 角色: "用户" | "模型", 内容 }...], 本轮工具调用: [name...], 本轮回复 }
// 过去的记录 is the current branch before this turn, oldest first: the
// user-role prompts and every assistant message's text (tool calls, tool
// results and thinking are left out). Synthetic user messages never count. In
// a main session only the human's own prompts (`attribution: "user"`) count;
// in a subagent every user-role prompt counts whatever its attribution (the
// assignment, messages from the parent, earlier turn-judge prompts), still
// labelled "用户". When it exceeds `maxChars` characters, whole entries are
// dropped from the oldest end.
// 本轮工具调用 is the names, in order and with repeats, of the tool calls the
// model made in this turn: every assistant message on the branch after the
// previous assistant message that ended with `stopReason: "stop"` and before
// the judged one. A turn a prompt (human, turn-judge or harness) starts after
// a stop therefore counts from zero. Tool calls inside the judged message
// itself are not counted: they have not run when it is judged. `[]` = no call.
//
// OUTCOME. JUDGE answers one choice question with a probability per option.
// Among options that carry a prompt, the one with the highest probability at
// or above its threshold is triggered; otherwise the file's verdict and every
// option's probability are reported. A turn the prompt itself causes is judged
// like any other; nothing caps it.
//   Main session: judgments run in the background. A triggered file's prompt
//   is sent as a user message (`attribution: "agent"`; idle → starts a turn,
//   busy → follow-up). Untriggered files share one info notification after
//   all of the turn's judgments settle (consecutive UI notifications replace
//   each other). If the user sends a prompt or moves the session before a
//   verdict returns, that verdict is reported and nothing is typed.
//   Subagent: the message_end handler awaits the judgments, and the task
//   executor waits for in-flight message_end handlers before it collects the
//   subagent's result. Everything shares one SUB_DEADLINE_MS budget from the
//   handler's start, below OMP's 30 s extension-handler cap; a judgment still
//   running then fails. When files trigger, the deadline has not passed and no
//   message has entered the branch after the judged one, the handler waits for
//   the session to go idle, sends the triggered prompts as ONE user message
//   (file order, blank-line separated, `attribution: "agent"`) that starts a
//   new turn, and returns once that turn is admitted (the session is busy or a
//   newer message exists). The subagent's reply to it replaces the judged report
//   as the result its parent receives, so a prompt meant for subagents should
//   ask for the complete revised report; a file that keeps triggering keeps
//   the subagent from returning. A prompt that misses the deadline or meets a
//   newer message is reported, not sent. While the handler waits, later
//   extensions' message_end handlers for the same message wait too.
//   Subagent sessions have no UI: their reports and warnings go to the log.
//
// AVAILABILITY. No applying file: nothing runs — no request and no report. No
// native JUDGE role: silently inactive. Role changes apply on the next turn. A
// failed request warns for that turn; an invalid file warns once per process
// (per path and reason). Sessions without UI only log. Nothing blocks or
// changes the turn itself.
// ============================================================================

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage, Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { openNativeJudge } from "../_shared/judge.ts";
import { textOf } from "../_shared/messages.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";

const FILE_PATTERN = /^TURN-JUDGE-.+\.md$/i;
const OPTION_KEY = /^option\.([^.\s]+)(?:\.(prompt|threshold))?$/;
const DEFAULT_MAX_CHARS = 30_000;
const JUDGE_TIMEOUT_MS = 90_000;
/** Whole subagent handler budget; OMP stops waiting for an extension handler after 30 s. */
const SUB_DEADLINE_MS = 20_000;
/** Poll interval while a subagent handler waits for idle or for its prompt's turn. */
const POLL_MS = 25;

type AgentIdentity = ExtensionContext["agent"];

type Target =
	| { readonly kind: "all" }
	| { readonly kind: "main" }
	| { readonly kind: "subagents" }
	| { readonly kind: "agent"; readonly name: string };

type MatchField = "model" | "provider";

type ModelConstraint = { readonly field: MatchField; readonly pattern: RegExp };

type Outcome = { readonly kind: "info" } | { readonly kind: "prompt"; readonly prompt: string; readonly threshold: number };

type JudgeOption = { readonly label: string; readonly criteria: string | null; readonly outcome: Outcome };

type TurnJudgeSpec = {
	readonly name: string;
	readonly filePath: string;
	readonly question: string;
	readonly options: readonly JudgeOption[];
	readonly maxChars: number;
	readonly targets: readonly Target[];
	readonly constraints: readonly ModelConstraint[];
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: TurnJudgeSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

type HistoryLine = { readonly 角色: "用户" | "模型"; readonly 内容: string };

type TurnState = { readonly 过去的记录: readonly HistoryLine[]; readonly 本轮工具调用: readonly string[]; readonly 本轮回复: string };

/** What the branch before the judged message contributes to every file's state. */
type Before = { readonly history: readonly HistoryLine[]; readonly toolCalls: readonly string[] };

type Verdict = { readonly choice: string; readonly probabilities: Readonly<Record<string, number>> };

type JudgeResult = { readonly kind: "ok"; readonly verdict: Verdict } | { readonly kind: "failed"; readonly reason: string };

type Action =
	| { readonly kind: "prompt"; readonly option: string; readonly probability: number; readonly prompt: string }
	| { readonly kind: "info" };

/** One file's judgment of one turn, before anything is sent. */
type Judged =
	| { readonly kind: "failed"; readonly line: string }
	| { readonly kind: "info"; readonly line: string }
	| { readonly kind: "prompt"; readonly line: string; readonly prompt: string };

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

type OptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JudgeOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `option.<label>[.prompt|.threshold]` keys into options, in declaration order. */
function parseOptions(fields: Readonly<Record<string, string>>): OptionsParse {
	const criteria = new Map<string, string | null>();
	const prompts = new Map<string, string>();
	const thresholds = new Map<string, string>();
	for (const [key, raw] of Object.entries(fields)) {
		const m = key.match(OPTION_KEY);
		const label = m?.[1];
		if (!m || label === undefined) continue;
		const value = unquote(raw);
		// OPTION_KEY admits exactly these suffixes; no cast of file input is needed.
		const suffix = m[2];
		if (suffix === undefined) {
			criteria.set(label, value || null);
		} else if (suffix === "prompt") {
			if (!value) return { kind: "invalid", reason: `option.${label}.prompt is empty` };
			prompts.set(label, value);
		} else if (suffix === "threshold") {
			thresholds.set(label, value);
		}
	}
	if (criteria.size < 2) return { kind: "invalid", reason: "needs at least two option.<label> entries" };
	for (const label of [...prompts.keys(), ...thresholds.keys()]) {
		if (!criteria.has(label)) return { kind: "invalid", reason: `option.${label} is not declared` };
	}
	const options: JudgeOption[] = [];
	for (const [label, rubric] of criteria) {
		const prompt = prompts.get(label);
		const rawThreshold = thresholds.get(label);
		if (prompt === undefined) {
			if (rawThreshold !== undefined) return { kind: "invalid", reason: `option.${label}.threshold set without option.${label}.prompt` };
			options.push({ label, criteria: rubric, outcome: { kind: "info" } });
			continue;
		}
		const threshold = rawThreshold === undefined ? Number.NaN : Number(rawThreshold);
		if (!(threshold > 0 && threshold <= 1)) {
			return { kind: "invalid", reason: `option.${label}.threshold must be a number in (0, 1]` };
		}
		options.push({ label, criteria: rubric, outcome: { kind: "prompt", prompt, threshold } });
	}
	return { kind: "ok", options };
}

/** One `target` item, in watchdog-agent's vocabulary. */
function toTarget(item: string): Target {
	switch (item) {
		case "*":
		case "all":
		case "any":
			return { kind: "all" };
		case "main":
			return { kind: "main" };
		case "subagents":
		case "subagent":
		case "sub":
		case "subs":
			return { kind: "subagents" };
		default:
			return { kind: "agent", name: item };
	}
}

type TargetsParse = { readonly kind: "ok"; readonly targets: readonly Target[] } | { readonly kind: "invalid"; readonly reason: string };

/** `target` value → targets; a missing key means `main`. Agent names contain `:`, so items split on commas only. */
function parseTargets(raw: string | undefined): TargetsParse {
	if (raw === undefined) return { kind: "ok", targets: [{ kind: "main" }] };
	let value = raw.trim();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	const items = value
		.split(",")
		.map((item) => unquote(item).toLowerCase())
		.filter((item) => item !== "");
	if (items.length === 0) return { kind: "invalid", reason: "target lists nothing" };
	return { kind: "ok", targets: items.map(toTarget) };
}

type ConstraintsParse =
	| { readonly kind: "ok"; readonly constraints: readonly ModelConstraint[] }
	| { readonly kind: "invalid"; readonly reason: string };

function parseConstraints(fields: Readonly<Record<string, string>>): ConstraintsParse {
	const constraints: ModelConstraint[] = [];
	for (const field of ["model", "provider"] as const) {
		const raw = fields[field];
		if (raw === undefined) continue;
		const source = unquote(raw);
		if (source === "") return { kind: "invalid", reason: `${field} must be a non-empty regex` };
		try {
			constraints.push({ field, pattern: new RegExp(source) });
		} catch (error) {
			return { kind: "invalid", reason: `${field} is not a valid regex: ${errorText(error)}` };
		}
	}
	return { kind: "ok", constraints };
}

function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `unreadable: ${String(error)}` };
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return { kind: "invalid", reason: "missing frontmatter" };
	const { fields, body } = parsed;
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	const question = body.trim();
	if (question === "") return { kind: "invalid", reason: "empty body (the body is the question)" };
	let maxChars = DEFAULT_MAX_CHARS;
	if (fields.maxchars !== undefined) {
		maxChars = Number(unquote(fields.maxchars));
		if (!Number.isInteger(maxChars) || maxChars <= 0) return { kind: "invalid", reason: "maxChars must be a positive integer" };
	}
	const targets = parseTargets(fields.target);
	if (targets.kind === "invalid") return targets;
	const constraints = parseConstraints(fields);
	if (constraints.kind === "invalid") return constraints;
	const options = parseOptions(fields);
	if (options.kind === "invalid") return options;
	const label = basename(path)
		.replace(/^TURN-JUDGE-/i, "")
		.replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			filePath: path,
			question,
			options: options.options,
			maxChars,
			targets: targets.targets,
			constraints: constraints.constraints,
		},
	};
}

function targetsSession(targets: readonly Target[], agent: AgentIdentity): boolean {
	return targets.some((target) => {
		switch (target.kind) {
			case "all":
				return true;
			case "main":
				return agent.kind === "main";
			case "subagents":
				return agent.kind === "sub";
			case "agent":
				return agent.kind === "sub" && (target.name === agent.name.toLowerCase() || target.name === agent.id.toLowerCase());
			default: {
				const unreachable: never = target;
				return unreachable;
			}
		}
	});
}

function applies(spec: TurnJudgeSpec, agent: AgentIdentity, message: AssistantMessage): boolean {
	if (!targetsSession(spec.targets, agent)) return false;
	const values: Record<MatchField, string> = { model: message.model, provider: message.provider };
	return spec.constraints.every((constraint) => constraint.pattern.test(values[constraint.field]));
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
				if (applies(parsed.spec, ctx.agent, message)) specs.push(parsed.spec);
				break;
			case "disabled":
				break;
			case "invalid": {
				const key = `${path}\0${parsed.reason}`;
				if (warnedFiles.has(key)) break;
				warnedFiles.add(key);
				warnings.push(`turn-judge: 跳过 ${path}：${parsed.reason}`);
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

/**
 * The session's prompts and the model's text on the branch before the judged
 * message, oldest first, and the tool calls made since the previous stop.
 */
function before(ctx: ExtensionContext, judgedTimestamp: number): Before {
	const main = ctx.agent.kind === "main";
	const history: HistoryLine[] = [];
	let toolCalls: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.timestamp >= judgedTimestamp) break;
		if (message.role === "user") {
			if (message.synthetic === true || (main && message.attribution !== "user")) continue;
			const text = textOf(message.content, "\n").trim();
			if (text !== "") history.push({ 角色: "用户", 内容: text });
		} else if (message.role === "assistant") {
			const text = textOf(message.content, "\n").trim();
			if (text !== "") history.push({ 角色: "模型", 内容: text });
			for (const block of message.content) if (block.type === "toolCall") toolCalls.push(block.name);
			if (message.stopReason === "stop") toolCalls = [];
		}
	}
	return { history, toolCalls };
}

/** Keep the newest whole entries whose total length fits `maxChars`. */
function fitHistory(lines: readonly HistoryLine[], maxChars: number): HistoryLine[] {
	const kept: HistoryLine[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		used += line.内容.length;
		if (used > maxChars) break;
		kept.push(line);
	}
	return kept.reverse();
}

/** Whether the branch's latest message is newer than the judged one. */
function hasMessageAfter(ctx: ExtensionContext, judgedTimestamp: number): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry === undefined || entry.type !== "message") continue;
		return entry.message.timestamp > judgedTimestamp;
	}
	return false;
}

// --- judging --------------------------------------------------------------------

async function runJudge(judge: Judge, spec: TurnJudgeSpec, state: TurnState, signal: AbortSignal): Promise<JudgeResult> {
	try {
		const criteria: Record<string, string | null> = {};
		for (const option of spec.options) criteria[option.label] = option.criteria;
		const result = await judge.judge(
			{
				state,
				questions: { turn: { type: "choice", instructions: spec.question, criteria } },
			},
			{ signal },
		);
		const answer = result.answers.turn;
		return { kind: "ok", verdict: { choice: answer.choice, probabilities: answer.probabilities } };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

/** The prompt option with the highest probability at or above its threshold, else info. */
function decide(spec: TurnJudgeSpec, verdict: Verdict): Action {
	let best: Action = { kind: "info" };
	for (const option of spec.options) {
		if (option.outcome.kind !== "prompt") continue;
		const p = verdict.probabilities[option.label] ?? 0;
		if (p < option.outcome.threshold) continue;
		if (best.kind === "prompt" && best.probability >= p) continue;
		best = { kind: "prompt", option: option.label, probability: p, prompt: option.outcome.prompt };
	}
	return best;
}

function describeVerdict(spec: TurnJudgeSpec, verdict: Verdict): string {
	const parts = spec.options.map((o) => `${o.label} ${(verdict.probabilities[o.label] ?? 0).toFixed(2)}`);
	return `turn-judge ${spec.name}：${verdict.choice}（${parts.join(" · ")}）`;
}

async function judgeSpec(judge: Judge, spec: TurnJudgeSpec, context: Before, reply: string, signal: AbortSignal): Promise<Judged> {
	const state: TurnState = { 过去的记录: fitHistory(context.history, spec.maxChars), 本轮工具调用: context.toolCalls, 本轮回复: reply };
	const result = await runJudge(judge, spec, state, signal);
	switch (result.kind) {
		case "failed":
			return { kind: "failed", line: `turn-judge ${spec.name}：判断失败（${result.reason}）` };
		case "ok":
			break;
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
	const line = describeVerdict(spec, result.verdict);
	const action = decide(spec, result.verdict);
	switch (action.kind) {
		case "info":
			return { kind: "info", line };
		case "prompt":
			return { kind: "prompt", line, prompt: action.prompt };
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

/**
 * Start the prompt's turn in an idle subagent and wait until the session has
 * admitted it, so the executor's idle wait covers that turn. Prompt dispatch
 * awaits preprocessing before the session reports busy; returning earlier
 * would let the executor collect the judged report instead.
 */
async function deliverToSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	judgedTimestamp: number,
	deadline: AbortSignal,
): Promise<Delivery> {
	if (deadline.aborted) return { kind: "unsent", reason: "判断超出时限" };
	if (!(await waitUntil(() => ctx.isIdle(), deadline))) return { kind: "unsent", reason: "时限内子会话未空闲" };
	if (hasMessageAfter(ctx, judgedTimestamp)) return { kind: "unsent", reason: "判断返回前已有新消息" };
	pi.sendUserMessage(prompt, { attribution: "agent" });
	const admitted = await waitUntil(() => !ctx.isIdle() || hasMessageAfter(ctx, judgedTimestamp), deadline);
	return admitted ? { kind: "sent" } : { kind: "unconfirmed" };
}

async function judgeSubagentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	specs: readonly TurnJudgeSpec[],
	message: AssistantMessage,
	reply: string,
	deadline: AbortSignal,
): Promise<void> {
	const opened = await openNativeJudge(ctx);
	if (opened.kind === "inactive") return;
	const context = before(ctx, message.timestamp);
	const judged = await Promise.all(specs.map((spec) => judgeSpec(opened.judge, spec, context, reply, deadline)));
	const warnings = judged.flatMap((j) => (j.kind === "failed" ? [j.line] : []));
	const infos = judged.flatMap((j) => (j.kind === "info" ? [j.line] : []));
	const triggered = judged.flatMap((j) => (j.kind === "prompt" ? [j] : []));
	if (triggered.length > 0) {
		const prompt = triggered.map((t) => t.prompt).join("\n\n");
		const delivery = await deliverToSubagent(pi, ctx, prompt, message.timestamp, deadline);
		const tag = `${ctx.agent.name} (${ctx.agent.id})`;
		switch (delivery.kind) {
			case "sent":
				infos.push(...triggered.map((t) => `${t.line} → prompt（${tag}）`));
				break;
			case "unsent":
				infos.push(...triggered.map((t) => `${t.line}；${delivery.reason}，未发送 prompt（${tag}）`));
				break;
			case "unconfirmed":
				warnings.push(...triggered.map((t) => `${t.line} → prompt（${tag}）；时限内未确认新回合开始，父代理可能收到原回复`));
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
	/** Bumped by every human prompt and session move; a main verdict from an older epoch is shown, never typed. */
	let epoch = 0;

	const settleMain = (ctx: ExtensionContext, judged: Judged, startedAt: number): Report => {
		switch (judged.kind) {
			case "failed":
				return { kind: "warning", line: judged.line };
			case "info":
				return { kind: "info", line: judged.line };
			case "prompt":
				if (epoch !== startedAt) return { kind: "info", line: `${judged.line}；判断返回前已有新输入，未发送 prompt` };
				pi.logger.info(`${judged.line} → prompt`);
				pi.sendUserMessage(judged.prompt, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
				return { kind: "sent" };
			default: {
				const unreachable: never = judged;
				return unreachable;
			}
		}
	};

	/** Start the main session's judgments in the background; one notification per turn once all settle. */
	const judgeMainTurn = async (ctx: ExtensionContext, specs: readonly TurnJudgeSpec[], message: AssistantMessage, reply: string) => {
		const context = before(ctx, message.timestamp);
		const startedAt = epoch;
		const opened = await openNativeJudge(ctx);
		if (opened.kind === "inactive") return;
		// One notification per turn: consecutive UI notifications replace each other.
		void Promise.all(
			specs.map(async (spec) =>
				settleMain(ctx, await judgeSpec(opened.judge, spec, context, reply, AbortSignal.timeout(JUDGE_TIMEOUT_MS)), startedAt),
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
			const specs = applyingSpecs(pi, ctx, message);
			if (specs.length === 0) return;
			if (deadline === null) await judgeMainTurn(ctx, specs, message, reply);
			else await judgeSubagentTurn(pi, ctx, specs, message, reply, deadline);
		} catch (error) {
			pi.logger.warn("turn-judge: message_end failed", { error: errorText(error) });
		}
	});
}
