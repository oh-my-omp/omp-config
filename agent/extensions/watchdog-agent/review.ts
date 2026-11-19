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
			args = "";
		}
		calls.push(`${name}(${args})`);
	}
	return calls;
}

function toolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const b of content) {
		if (hasKey(b, "type") && b.type === "toolCall") count += 1;
	}
	return count;
}

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

export function countActions(message: unknown): number {
	if (!hasKey(message, "role") || message.role !== "assistant") return 0;
	const content = hasKey(message, "content") ? message.content : undefined;
	return toolCallCount(content) + (hasText(content) ? 1 : 0);
}

export function messageTimestamp(message: unknown): number | undefined {
	return hasKey(message, "timestamp") && typeof message.timestamp === "number" ? message.timestamp : undefined;
}

export function producerOf(message: unknown): Producer | null {
	if (!hasKey(message, "role") || message.role !== "assistant") return null;
	if (!hasKey(message, "model") || typeof message.model !== "string") return null;
	if (!hasKey(message, "provider") || typeof message.provider !== "string") return null;
	return { model: message.model, provider: message.provider };
}

export function isOwnUserNote(message: unknown, ownNotes: Pick<ReadonlySet<string>, "has">): boolean {
	if (!hasKey(message, "role") || message.role !== "user") return false;
	if (!hasKey(message, "attribution") || message.attribution !== "agent") return false;
	return ownNotes.has(textBlocks(hasKey(message, "content") ? message.content : undefined).trim());
}

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

export function branchMessages(entries: ReadonlyArray<unknown>): unknown[] {
	const out: unknown[] = [];
	for (const e of entries) {
		if (hasKey(e, "type") && e.type === "message" && hasKey(e, "message")) out.push(e.message);
	}
	return out;
}

export function reviewTranscript(
	entries: ReadonlyArray<unknown>,
	scope: Scope,
	after: number,
	tail: unknown,
	ownNotes: Pick<ReadonlySet<string>, "has">,
): { readonly transcript: string; readonly reviewed: number } {
	const tailStamp = messageTimestamp(tail);
	const parts: string[] = [];
	let onBranch = false;
	let reviewed = after;
	for (const entry of entries) {
		if (!hasKey(entry, "type") || entry.type !== "message" || !hasKey(entry, "message")) continue;
		const message = entry.message;
		const stamp = messageTimestamp(message) ?? 0;
		if (tailStamp !== undefined && stamp === tailStamp) onBranch = true;
		if (scope === "window" && stamp <= after) continue;
		if (stamp > reviewed) reviewed = stamp;
		const part = renderMessage(message, ownNotes);
		if (part !== undefined) parts.push(part);
	}
	if (tail !== undefined && tailStamp !== undefined && !onBranch && (scope === "full" || tailStamp > after)) {
		const part = renderMessage(tail, ownNotes);
		if (part !== undefined) parts.push(part);
		if (tailStamp > reviewed) reviewed = tailStamp;
	}
	return { transcript: parts.join("\n"), reviewed };
}

function splitLevel(spec: string): { readonly base: string; readonly level: ThinkingLevel | undefined } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1);
		const level = suffix === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === suffix);
		if (level !== undefined) return { base: trimmed.slice(0, colon), level };
	}
	return { base: trimmed, level: undefined };
}

function findModel(ctx: ExtensionContext, base: string): Model | undefined {
	const resolved = ctx.models?.resolve?.(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry.getAvailable();
	return available.find((model) => `${model.provider}/${model.id}` === base) ?? available.find((model) => model.id === base);
}

export function defaultReviewerModel(ctx: ExtensionContext): Model | undefined {
	for (const role of ["@advisor", "advisor", "@slow"]) {
		const model = ctx.models?.resolve?.(role);
		if (model) return model;
	}
	return ctx.models?.current?.();
}

function resolveReviewer(ctx: ExtensionContext, spec: ChatWatchdog): { model: Model; thinkingLevel: ThinkingLevel } | null {
	if (!spec.model) {
		const model = defaultReviewerModel(ctx);
		return model ? { model, thinkingLevel: "off" } : null;
	}
	const { base, level } = splitLevel(spec.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, (suffix) => suffix.toLowerCase()));
	const model = findModel(ctx, base);
	return model ? { model, thinkingLevel: level ?? "off" } : null;
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
