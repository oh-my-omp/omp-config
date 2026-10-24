import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { runHelperPrompt } from "../_shared/helper-session.ts";
import { openJudge } from "../_shared/judge.ts";
import { textOf as textBlocks } from "../_shared/messages.ts";
import type { Model, ThinkingLevel } from "../_shared/models.ts";
import { ADVISORY_TAG, type ChatWatchdog, type DeliverAs, hasKey, type JevWatchdog, type Scope, type Verdict } from "./spec.ts";

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

/** Watched actions in one message: each assistant tool call plus one for a nonempty text reply. */
export function countActions(message: unknown): number {
	if (!hasKey(message, "role") || message.role !== "assistant") return 0;
	const content = hasKey(message, "content") ? message.content : undefined;
	return toolCallSummaries(content).length + (textBlocks(content).trim() === "" ? 0 : 1);
}

export function messageTimestamp(message: unknown): number | undefined {
	return hasKey(message, "timestamp") && typeof message.timestamp === "number" ? message.timestamp : undefined;
}

/** One message's full rendering, or undefined when it contributes nothing (incl. our own advisories). */
function renderMessage(m: unknown): string | undefined {
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
		const text = textBlocks(content).trim();
		if (text.startsWith(ADVISORY_TAG)) return undefined; // skip our own advisory injections
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

/**
 * Messages a run reviews. `full` = every branch message; `window` = those stamped after
 * `after`. `tail` is the message that triggered a mid-run review: `message_end` persistence
 * is queued concurrently with the event, so it is appended when the branch lacks it yet.
 */
export function selectMessages(entries: ReadonlyArray<unknown>, scope: Scope, after: number, tail: unknown): unknown[] {
	const all = branchMessages(entries);
	const tailStamp = messageTimestamp(tail);
	if (tail !== undefined && tailStamp !== undefined && !all.some((m) => messageTimestamp(m) === tailStamp)) all.push(tail);
	if (scope === "full") return all;
	return all.filter((m) => (messageTimestamp(m) ?? 0) > after);
}

/** Full, untruncated rendering of the given messages, oldest first. */
export function renderTranscript(messages: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const m of messages) {
		const part = renderMessage(m);
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

function buildReviewPrompt(guidance: string, transcript: string): string {
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
		`<one concise, concrete note, at most ~80 words, citing specific files/symbols/lines>\n\n` +
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

/** Runs one reviewer session over the transcript. Never throws; failures → null. */
export async function runReviewer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: ChatWatchdog,
	transcript: string,
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
		prompt: buildReviewPrompt(spec.guidance, transcript),
		systemPrompt: "default",
		toolNames: spec.tools,
		signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
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

/** Native JUDGE answers a typed choice; the chosen option supplies the injected text. */
export async function runJev(pi: ExtensionAPI, ctx: ExtensionContext, spec: JevWatchdog, transcript: string): Promise<Verdict | null> {
	const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
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
			{ signal },
		);
		pi.logger?.info?.(`watchdog "${spec.name}": native judge usage`, {
			provider: result.provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			cost: result.usage.cost.total,
		});
		const choice = result.answers.review.choice;
		const picked = spec.options.find((option) => option.label === choice);
		if (!picked) {
			pi.logger?.warn?.(`watchdog "${spec.name}": native judge returned an unconfigured choice — skipping`);
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
		pi.logger?.warn?.(`watchdog "${spec.name}": native judge failed — skipping`, {
			error: errorText(error),
		});
		return null;
	}
}
