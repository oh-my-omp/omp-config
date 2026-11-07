import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { runHelperPrompt } from "../_shared/helper-session.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf as textBlocks } from "../_shared/messages.ts";
import type { Model, ThinkingLevel } from "../_shared/models.ts";
import type { InjectMode, Producer } from "../_shared/session-filter.ts";
import { type ChatWatchdog, type DeliverAs, hasKey, type JevWatchdog, type Scope, type Verdict } from "./spec.ts";

const REVIEW_TIMEOUT_MS = 90_000;
// --- transcript rendering ---------------------------------------------------

function toolCallSummaries(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const calls: string[] = [];
	for (const b of content) {
		if (!hasKey(b, "type") || b.type !== "toolCall") continue;
		const name =
			hasKey(b, "toolName") && typeof b.toolName === "string"
				? b.toolName
				: hasKey(b, "name") && typeof b.name === "string"
					? b.name
					: "tool";
		const rawArgs = hasKey(b, "args") ? b.args : hasKey(b, "arguments") ? b.arguments : hasKey(b, "input") ? b.input : undefined;
		let args = "";
		try {
			args = rawArgs === undefined ? "" : JSON.stringify(rawArgs);
		} catch {
			// A malformed cyclic tool payload cannot be serialized in the transcript.
			args = "";
		}
		calls.push(`${name}(${args})`);
	}
	return calls;
}

/** Tool calls in one message's content, counted without serializing their arguments. */
function toolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const b of content) {
		if (hasKey(b, "type") && b.type === "toolCall") count += 1;
	}
	return count;
}

/** Whether the content carries a text block with a non-whitespace character, without joining or copying the text. */
function hasText(content: unknown): boolean {
	const nonBlank = /\S/;
	if (typeof content === "string") return nonBlank.test(content);
	if (!Array.isArray(content)) return false;
	for (const b of content) {
		if (!hasKey(b, "type") || b.type !== "text") continue;
		if (hasKey(b, "text") && typeof b.text === "string" && nonBlank.test(b.text)) return true;
	}
	return false;
}

/** Watched actions in one message: each assistant tool call plus one for a nonempty text reply. */
export function countActions(message: unknown): number {
	if (!hasKey(message, "role") || message.role !== "assistant") return 0;
	const content = hasKey(message, "content") ? message.content : undefined;
	return toolCallCount(content) + (hasText(content) ? 1 : 0);
}

export function messageTimestamp(message: unknown): number | undefined {
	return hasKey(message, "timestamp") && typeof message.timestamp === "number" ? message.timestamp : undefined;
}

/** Model and provider of an assistant message; null for any other message. */
export function producerOf(message: unknown): Producer | null {
	if (!hasKey(message, "role") || message.role !== "assistant") return null;
	if (!hasKey(message, "model") || typeof message.model !== "string") return null;
	if (!hasKey(message, "provider") || typeof message.provider !== "string") return null;
	return { model: message.model, provider: message.provider };
}

/**
 * Whether a branch message is a user-mode note a watchdog sent: an agent-attributed
 * user message whose trimmed text is among `ownNotes` (the texts recorded at sending).
 */
export function isOwnUserNote(message: unknown, ownNotes: Pick<ReadonlySet<string>, "has">): boolean {
	if (!hasKey(message, "role") || message.role !== "user") return false;
	if (!hasKey(message, "attribution") || message.attribution !== "agent") return false;
	return ownNotes.has(textBlocks(hasKey(message, "content") ? message.content : undefined).trim());
}

/** One message's full rendering, or undefined when it contributes nothing (incl. our own user-mode notes). */
function renderMessage(m: unknown, ownNotes: Pick<ReadonlySet<string>, "has">): string | undefined {
	if (!hasKey(m, "role") || typeof m.role !== "string") return undefined;
	const role = m.role;
	const content = hasKey(m, "content") ? m.content : undefined;
	if (role === "assistant") {
		const text = textBlocks(content).trim();
		const segs: string[] = [];
		if (text) segs.push(`ASSISTANT: ${text}`);
		for (const c of toolCallSummaries(content)) segs.push(`  → tool ${c}`);
		return segs.length > 0 ? segs.join("\n") : undefined;
	}
	if (role === "user") {
		if (isOwnUserNote(m, ownNotes)) return undefined;
		const text = textBlocks(content).trim();
		return text ? `USER: ${text}` : undefined;
	}
	if (role === "toolResult") {
		const name = hasKey(m, "toolName") && typeof m.toolName === "string" ? m.toolName : "tool";
		return `RESULT[${name}]: ${textBlocks(content).trim()}`;
	}
	if (role === "developer") {
		const text = textBlocks(content).trim();
		return text ? `DEV: ${text}` : undefined;
	}
	return undefined;
}

/** Messages on the branch, oldest first; non-message entries (compaction markers, labels, …) are skipped. */
export function branchMessages(entries: ReadonlyArray<unknown>): unknown[] {
	const out: unknown[] = [];
	for (const e of entries) {
		if (hasKey(e, "type") && e.type === "message" && hasKey(e, "message")) out.push(e.message);
	}
	return out;
}

/** What one review takes from the branch, and how far it reached. */
export type ReviewSelection = {
	/** Messages this run has to render, oldest first: branch messages the caller's retained rendering lacks. */
	readonly messages: unknown[];
	/** The triggering message, when the branch lacks it yet: `message_end` persistence is queued concurrently with the event. */
	readonly tail: unknown;
	/** Message entries on the branch, including ones a retained rendering already covers. */
	readonly branchCount: number;
	/** Newest message timestamp the run covers; the caller advances the cursor to it. */
	readonly reviewed: number;
};

/**
 * Messages a review covers. `full` covers the whole branch, of which the first `rendered`
 * message entries are already in the caller's retained rendering, so only the remainder is
 * returned; `window` covers those stamped after `after`. Nothing else is materialized: the
 * entries are scanned once and only returned messages are collected.
 */
export function selectMessages(entries: ReadonlyArray<unknown>, scope: Scope, after: number, tail: unknown, rendered = 0): ReviewSelection {
	const tailStamp = messageTimestamp(tail);
	let branchCount = 0;
	let onBranch = false;
	let reviewed = after;
	const messages: unknown[] = [];
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "message" || !hasKey(e, "message")) continue;
		const message = e.message;
		const index = branchCount;
		branchCount += 1;
		const stamp = messageTimestamp(message) ?? 0;
		if (tailStamp !== undefined && stamp === tailStamp) onBranch = true;
		// `full` still counts the stamps of messages already rendered, for the cursor it advances to.
		const wanted = scope === "window" ? stamp > after : index >= rendered;
		if (wanted || scope === "full") {
			if (wanted) messages.push(message);
			if (stamp > reviewed) reviewed = stamp;
		}
	}
	const appended = tail !== undefined && tailStamp !== undefined && !onBranch && (scope === "full" || tailStamp > after);
	if (appended && tailStamp > reviewed) reviewed = tailStamp;
	return { messages, tail: appended ? tail : undefined, branchCount, reviewed };
}

/** Full, untruncated rendering of the given messages, oldest first, then `tail` when given. System-mode notes are custom messages, never branch messages, so only user-mode notes need `ownNotes`. */
export function renderTranscript(messages: ReadonlyArray<unknown>, ownNotes: Pick<ReadonlySet<string>, "has">, tail?: unknown): string {
	const parts: string[] = [];
	for (const m of messages) {
		const part = renderMessage(m, ownNotes);
		if (part !== undefined) parts.push(part);
	}
	if (tail !== undefined) {
		const part = renderMessage(tail, ownNotes);
		if (part !== undefined) parts.push(part);
	}
	return parts.join("\n");
}

// --- model specs ------------------------------------------------------------

/**
 * `provider/id:level` → base and level. A level is `off` or one of the host's
 * efforts (minimal … max); a missing suffix, or any other (`auto`, `inherit`),
 * leaves the spec whole.
 */
function splitLevel(spec: string): { readonly base: string; readonly level: ThinkingLevel | undefined } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1);
		// The host's own effort values, so the level is typed without a cast; `off` is not an effort.
		const level = suffix === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === suffix);
		if (level !== undefined) return { base: trimmed.slice(0, colon), level };
	}
	return { base: trimmed, level: undefined };
}

/** A role alias or pattern through the host resolver, else an available `provider/id`, else a bare id. */
function findModel(ctx: ExtensionContext, base: string): Model | undefined {
	const resolved = ctx.models?.resolve?.(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry.getAvailable();
	return available.find((model) => `${model.provider}/${model.id}` === base) ?? available.find((model) => model.id === base);
}

// --- reviewer ---------------------------------------------------------------

/** Model a chat watchdog without `model` reviews with: the advisor role chain, else the session model. */
export function defaultReviewerModel(ctx: ExtensionContext): Model | undefined {
	for (const role of ["@advisor", "advisor", "@slow"]) {
		const model = ctx.models?.resolve?.(role);
		if (model) return model;
	}
	return ctx.models?.current?.();
}

/** Reviewer model + thinking level: explicit `model` (honoring `:effort`), else the `advisor` role. */
function resolveReviewer(ctx: ExtensionContext, spec: ChatWatchdog): { model: Model; thinkingLevel: ThinkingLevel } | null {
	if (!spec.model) {
		const model = defaultReviewerModel(ctx);
		return model ? { model, thinkingLevel: "off" } : null;
	}
	// Watchdog effort suffixes have always been case-insensitive.
	const { base, level } = splitLevel(spec.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, (suffix) => suffix.toLowerCase()));
	const model = findModel(ctx, base);
	return model ? { model, thinkingLevel: level ?? "off" } : null;
}

/** How the note line is written: a reviewer's note, or the user talking to the agent. */
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

function buildReviewPrompt(guidance: string, transcript: string, inject: InjectMode): string {
	return (
		`You are a code-review WATCHDOG silently observing another AI coding agent ("the primary agent") as it works in this repository. ` +
		`You are NOT the primary agent; do not perform its task.\n\n` +
		`Your review priorities:\n${guidance || "(no specific priorities configured; apply general senior-engineer judgment)"}\n\n` +
		`You may use your read-only tools to inspect the workspace and verify a concern before raising it. Investigate briefly; never rewrite the code.\n\n` +
		`Below is the primary agent's transcript (oldest first, newest last). Judge only whether the LATEST work has a problem worth flagging.\n\n` +
		`Reply format — obey EXACTLY:\n` +
		`- If nothing is worth flagging, reply with the single word: PASS\n` +
		`- Otherwise reply with two lines:\n` +
		`SEVERITY: <nit|concern|blocker>\n` +
		`${noteFormat(inject)}\n\n` +
		`Do not restate the transcript. Do not add anything else.\n\n` +
		`TRANSCRIPT:\n"""\n${transcript}\n"""`
	);
}

function interpretVerdict(answer: string, delivery: DeliverAs): Verdict | null {
	const trimmed = answer.trim();
	if (trimmed === "") return null;
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (/^(pass|ok|lgtm|none)\b/i.test(firstLine)) return { kind: "pass" };
	const sev = trimmed.match(/severity\s*:\s*(nit|concern|blocker)/i);
	const severity = sev?.[1]?.toLowerCase() ?? "concern";
	let note = trimmed.replace(/^\s*severity\s*:\s*(nit|concern|blocker)\s*/i, "").trim();
	if (note === "") note = trimmed;
	return { kind: "advice", severity, note, delivery };
}

/** Runs one reviewer session over the transcript. Never throws; failures → null. `signal` aborts on a session boundary; the review timeout still applies. */
export async function runReviewer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: ChatWatchdog,
	transcript: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	const reviewer = resolveReviewer(ctx, spec);
	if (!reviewer) {
		pi.logger?.warn?.(`watchdog "${spec.name}": no reviewer model resolved (model=${spec.model ?? "@advisor"}) — skipping`);
		return null;
	}
	const result = await runHelperPrompt(ctx, {
		agentId: `watchdog-${
			spec.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "") || "watchdog"
		}`,
		model: reviewer.model,
		thinkingLevel: reviewer.thinkingLevel,
		prompt: buildReviewPrompt(spec.guidance, transcript, spec.inject),
		systemPrompt: "default",
		toolNames: spec.tools,
		signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]),
	});
	switch (result.kind) {
		case "text":
			return interpretVerdict(result.text, spec.delivery);
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

/** JUDGE answers a typed choice; the chosen option supplies the injected text. `signal` aborts on a session boundary; the review timeout still applies. */
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
		pi.logger?.info?.(`watchdog "${spec.name}": judge usage`, {
			provider: result.provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			cost: result.usage.cost.total,
		});
		const choice = result.answers.review.choice;
		const picked = spec.options.find((option) => option.label === choice);
		if (!picked) {
			pi.logger?.warn?.(`watchdog "${spec.name}": judge returned an unconfigured choice — skipping`);
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
		pi.logger?.warn?.(`watchdog "${spec.name}": judge failed — skipping`, {
			error: errorText(error),
		});
		return null;
	}
}
