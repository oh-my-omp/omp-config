import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { runHelperPrompt } from "../_shared/helper-session.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf as textBlocks } from "../_shared/messages.ts";
import type { Model, ThinkingLevel } from "../_shared/models.ts";
import type { InjectMode, Producer } from "../_shared/session-filter.ts";
import { bashEnvHook } from "./env.ts";
import type { ChatWatchdog, DeliverAs, JevWatchdog, ObserverWatchdog, Scope, Verdict } from "./spec.ts";

const REVIEW_TIMEOUT_MS = 90_000;
const OBSERVE_TIMEOUT_MS = 300_000;
const OBSERVE_LOG_CHARS = 300;

function toolCallSummaries(content: AssistantMessage["content"]): string[] {
	const calls: string[] = [];
	for (const b of content) {
		if (b.type !== "toolCall") continue;
		let args = "";
		try {
			args = JSON.stringify(b.arguments);
		} catch {
			args = "";
		}
		calls.push(`${b.name}(${args})`);
	}
	return calls;
}

export function countActions(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const calls = message.content.filter((b) => b.type === "toolCall").length;
	const text = message.content.some((b) => b.type === "text" && /\S/.test(b.text));
	return calls + (text ? 1 : 0);
}

export function producerOf(message: AgentMessage): Producer | null {
	if (message.role !== "assistant") return null;
	return { model: message.model, provider: message.provider };
}

function isOwnUserNote(message: AgentMessage, ownNotes: Pick<ReadonlySet<string>, "has">): boolean {
	if (message.role !== "user" || message.attribution !== "agent") return false;
	return ownNotes.has(textBlocks(message.content).trim());
}

function renderMessage(m: AgentMessage, ownNotes: Pick<ReadonlySet<string>, "has">): string | undefined {
	switch (m.role) {
		case "assistant": {
			const text = textBlocks(m.content).trim();
			const segs: string[] = [];
			if (text) segs.push(`ASSISTANT: ${text}`);
			for (const c of toolCallSummaries(m.content)) segs.push(`  → tool ${c}`);
			return segs.length > 0 ? segs.join("\n") : undefined;
		}
		case "user": {
			if (isOwnUserNote(m, ownNotes)) return undefined;
			const text = textBlocks(m.content).trim();
			return text ? `USER: ${text}` : undefined;
		}
		case "toolResult":
			return `RESULT[${m.toolName}]: ${textBlocks(m.content).trim()}`;
		case "developer": {
			const text = textBlocks(m.content).trim();
			return text ? `DEV: ${text}` : undefined;
		}
		case "bashExecution":
		case "pythonExecution":
		case "custom":
		case "hookMessage":
		case "branchSummary":
		case "compactionSummary":
		case "fileMention":
			return undefined;
		default: {
			const unreachable: never = m;
			return unreachable;
		}
	}
}

export function branchMessages(entries: ReadonlyArray<SessionEntry>): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const e of entries) {
		if (e.type === "message") out.push(e.message);
	}
	return out;
}

export function reviewTranscript(
	entries: ReadonlyArray<SessionEntry>,
	scope: Scope,
	after: number,
	tail: AgentMessage | undefined,
	ownNotes: Pick<ReadonlySet<string>, "has">,
): { readonly transcript: string; readonly reviewed: number } {
	const parts: string[] = [];
	let onBranch = false;
	let reviewed = after;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		const stamp = message.timestamp;
		if (tail !== undefined && stamp === tail.timestamp) onBranch = true;
		if (scope === "window" && stamp <= after) continue;
		if (stamp > reviewed) reviewed = stamp;
		const part = renderMessage(message, ownNotes);
		if (part !== undefined) parts.push(part);
	}
	if (tail !== undefined && !onBranch && (scope === "full" || tail.timestamp > after)) {
		const part = renderMessage(tail, ownNotes);
		if (part !== undefined) parts.push(part);
		if (tail.timestamp > reviewed) reviewed = tail.timestamp;
	}
	return { transcript: parts.join("\n"), reviewed };
}

function splitLevel(spec: string): { readonly base: string; readonly level: ThinkingLevel | undefined } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1).toLowerCase();
		const level = suffix === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === suffix);
		if (level !== undefined) return { base: trimmed.slice(0, colon), level };
	}
	return { base: trimmed, level: undefined };
}

function findModel(ctx: ExtensionContext, base: string): Model | undefined {
	const resolved = ctx.models.resolve(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry.getAvailable();
	return available.find((model) => `${model.provider}/${model.id}` === base) ?? available.find((model) => model.id === base);
}

export function defaultReviewerModel(ctx: ExtensionContext): Model | undefined {
	for (const role of ["@advisor", "advisor", "@slow"]) {
		const model = ctx.models.resolve(role);
		if (model) return model;
	}
	return ctx.models.current();
}

function resolveReviewer(
	ctx: ExtensionContext,
	spec: ChatWatchdog | ObserverWatchdog,
): { model: Model; thinkingLevel: ThinkingLevel } | null {
	if (!spec.model) {
		const model = defaultReviewerModel(ctx);
		return model ? { model, thinkingLevel: "off" } : null;
	}
	const { base, level } = splitLevel(spec.model);
	const model = findModel(ctx, base);
	return model ? { model, thinkingLevel: level ?? "off" } : null;
}

function helperAgentId(name: string): string {
	return `watchdog-${
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "watchdog"
	}`;
}

function watchedSession(ctx: ExtensionContext): WatchedSession {
	return { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd() };
}

function noteFormat(inject: InjectMode): string {
	switch (inject) {
		case "system":
			return "<one concise, concrete note, at most ~80 words, citing specific files/symbols/lines>";
		case "user":
			return (
				"<the note, at most ~80 words, written as the human user of this session typing to the primary agent: first person, colloquial and emotionally charged to fit the severity (mildly annoyed for nit, impatient for concern, angry and urgent for blocker), " +
				"in the language the user writes in the transcript, still citing the specific files/symbols/lines; it is sent as the user's own message, so never mention a watchdog, a reviewer or this review, and use no tags or headings>"
			);
		default: {
			const unreachable: never = inject;
			return unreachable;
		}
	}
}

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "ast_grep", "web_search"]);

export type WatchedSession = {
	readonly sessionId: string;
	readonly cwd: string;
};

function toolGuidance(tools: readonly string[]): string {
	if (tools.every((tool) => READ_ONLY_TOOLS.has(tool))) {
		return "You may use your read-only tools to inspect the workspace and verify a concern before raising it. Investigate briefly; never rewrite the code.";
	}
	return `You may use your configured tools (${tools.join(", ")}) as instructed in your review priorities above, but never perform the primary agent's coding task.`;
}

export function buildReviewPrompt(
	guidance: string,
	transcript: string,
	inject: InjectMode,
	tools: readonly string[],
	session: WatchedSession,
): string {
	return (
		`You are a code-review WATCHDOG silently observing another AI coding agent ("the primary agent") as it works in this repository. ` +
		`You are NOT the primary agent; do not perform its task.\n\n` +
		`Your review priorities:\n${guidance || "(no specific priorities configured; apply general senior-engineer judgment)"}\n\n` +
		`${toolGuidance(tools)}\n\n` +
		`Below is the primary agent's transcript (oldest first, newest last). Judge only whether the LATEST work has a problem worth flagging.\n\n` +
		`Reply format — obey EXACTLY:\n` +
		`- If nothing is worth flagging, reply with the single word: PASS\n` +
		`- Otherwise reply with two lines:\n` +
		`SEVERITY: <nit|concern|blocker>\n` +
		`${noteFormat(inject)}\n\n` +
		`Do not restate the transcript. Do not add anything else.\n\n` +
		`Watched session:\n` +
		`- sessionId: ${session.sessionId}\n` +
		`- cwd: ${session.cwd}\n\n` +
		`TRANSCRIPT:\n"""\n${transcript}\n"""`
	);
}

function interpretVerdict(answer: string, delivery: DeliverAs): Verdict | null {
	const trimmed = answer.trim();
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (/^(pass|ok|lgtm|none)\b/i.test(firstLine)) return { kind: "pass" };
	const match = /^\s*severity\s*:\s*(nit|concern|blocker)\b[\s:—-]*/im.exec(trimmed);
	const severity = match?.[1];
	if (!match || severity === undefined) return null;
	const note = trimmed.slice(match.index + match[0].length).trim();
	return note === "" ? null : { kind: "advice", severity: severity.toLowerCase(), note, delivery };
}

export async function runReviewer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: ChatWatchdog,
	transcript: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	const reviewer = resolveReviewer(ctx, spec);
	if (!reviewer) {
		pi.logger.warn(`watchdog "${spec.name}": no reviewer model resolved (model=${spec.model ?? "@advisor"}) — skipping`);
		return null;
	}
	const result = await runHelperPrompt(ctx, {
		agentId: helperAgentId(spec.name),
		model: reviewer.model,
		thinkingLevel: reviewer.thinkingLevel,
		prompt: buildReviewPrompt(spec.guidance, transcript, spec.inject, spec.tools, watchedSession(ctx)),
		systemPrompt: "default",
		toolNames: spec.tools,
		signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]),
	});
	switch (result.kind) {
		case "text": {
			const verdict = interpretVerdict(result.text, spec.delivery);
			if (verdict === null) pi.logger.warn(`watchdog "${spec.name}": reviewer reply has neither PASS nor a SEVERITY line — skipping`);
			return verdict;
		}
		case "provider-error":
			return null;
		case "canceled":
			pi.logger.warn(`watchdog "${spec.name}": reviewer timed out — skipping`);
			return null;
		case "failed":
			pi.logger.warn(`watchdog "${spec.name}": reviewer run failed`, { error: result.message });
			return null;
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
}

export function buildObservePrompt(guidance: string, transcript: string, tools: readonly string[], session: WatchedSession): string {
	return (
		`You are a background OBSERVER of another AI coding agent ("the watched agent"). You are NOT the watched agent; do not perform its task. ` +
		`Nothing you write reaches the watched agent or its user: your final reply is only written to a log.\n\n` +
		`Your task:\n${guidance}\n\n` +
		`Carry out your task on the latest work in the transcript below with your tools (${tools.join(", ")}). ` +
		`When you are done, reply with one line saying what you did, or "nothing to do".\n\n` +
		`Watched session:\n` +
		`- sessionId: ${session.sessionId}\n` +
		`- cwd: ${session.cwd}\n\n` +
		`TRANSCRIPT:\n"""\n${transcript}\n"""`
	);
}

export async function runObserver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: ObserverWatchdog,
	transcript: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	const observer = resolveReviewer(ctx, spec);
	if (!observer) {
		pi.logger.warn(`watchdog "${spec.name}": no observer model resolved (model=${spec.model ?? "@advisor"}) — skipping`);
		return null;
	}
	const result = await runHelperPrompt(ctx, {
		agentId: helperAgentId(spec.name),
		model: observer.model,
		thinkingLevel: observer.thinkingLevel,
		prompt: buildObservePrompt(spec.guidance, transcript, spec.tools, watchedSession(ctx)),
		systemPrompt: "default",
		toolNames: spec.tools,
		hooks: spec.env.length > 0 ? [bashEnvHook(spec.env)] : [],
		signal: AbortSignal.any([signal, AbortSignal.timeout(OBSERVE_TIMEOUT_MS)]),
	});
	switch (result.kind) {
		case "text":
			pi.logger.info(`watchdog "${spec.name}": observer done — ${result.text.replace(/\s+/g, " ").slice(0, OBSERVE_LOG_CHARS)}`);
			return { kind: "pass" };
		case "provider-error":
			pi.logger.warn(`watchdog "${spec.name}": observer provider error — will retry this window`, { error: result.message });
			return null;
		case "canceled":
			pi.logger.warn(`watchdog "${spec.name}": observer timed out — will retry this window`);
			return null;
		case "failed":
			pi.logger.warn(`watchdog "${spec.name}": observer run failed — will retry this window`, { error: result.message });
			return null;
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
}

export async function runJev(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: JevWatchdog,
	transcript: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
	const opened = openJudge(ctx, "watchdog-agent");
	if (opened.kind === "inactive") return null;
	const { judge } = opened;
	try {
		const criteria: Record<string, string | null> = {};
		for (const option of spec.options) criteria[option.label] = option.criteria;
		const result = await judge.judge(
			{
				state: { guidance: spec.guidance, transcript },
				questions: { review: { type: "choice", instructions: spec.instructions, criteria } },
			},
			{ signal: deadline },
		);
		pi.logger.info(`watchdog "${spec.name}": judge usage`, {
			provider: result.provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			cost: result.usage.cost.total,
		});
		const choice = result.answers.review.choice;
		const picked = spec.options.find((option) => option.label === choice);
		if (!picked) {
			pi.logger.warn(`watchdog "${spec.name}": judge returned an unconfigured choice — skipping`);
			return null;
		}
		switch (picked.outcome.kind) {
			case "silent":
				return { kind: "pass" };
			case "inject":
				return { kind: "advice", severity: picked.label, note: picked.outcome.prompt, delivery: picked.outcome.delivery };
			default: {
				const unreachable: never = picked.outcome;
				return unreachable;
			}
		}
	} catch (error) {
		pi.logger.warn(`watchdog "${spec.name}": judge failed — skipping`, {
			error: errorText(error),
		});
		return null;
	}
}
