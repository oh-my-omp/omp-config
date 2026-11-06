/**
 * Delta messages: an extension's customization of OMP's base prompt reaches the model as a hidden
 * message appended to the conversation, never as an edit of the system prompt or tool definitions.
 *
 * RENDERING. A delta is `<system-reminder source="omp-config/<id>">`, a newline, the body, a newline
 * and `</system-reminder>`. A delta that replaces an earlier one of the same source opens its body
 * with a line saying it supersedes them; a source whose customization stopped applying sends a delta
 * that says only that. The bytes depend only on the source id, the extension's body and whether the
 * context already holds a delta of that source.
 *
 * DELIVERY. Two points: the `before_agent_start` result `message` (a hidden custom message whose
 * `customType` is the source, `attribution: "agent"`) and the `tool_result` `additionalContext`
 * (OMP's developer message after the tool batch). Each reads the active leaf's context projection
 * (`buildSessionContext`): the source's last block there is its effective delta. Nothing is sent
 * when the wanted body equals it, or when nothing applies and no body of the source is effective.
 * Delivered messages are never rewritten; once compaction drops one from the projection, the next
 * delivery point sends it again. The only process state is what a tool batch of the current turn
 * returned before OMP persists the batch's developer message; `turn_start` drops it.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { textOf } from "./messages.ts";

/** What one extension adds to OMP's base prompt for the current session and inputs. */
export type Delta = { readonly kind: "none" } | { readonly kind: "text"; readonly body: string };

/** The `before_agent_start` result `message`; structurally a host `CustomMessagePayload`. */
interface DeltaMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly attribution: "agent";
}

export interface DeltaStream {
	/** `before_agent_start` result carrying the delta, or undefined when the context already holds it. */
	atPrompt(ctx: ExtensionContext, delta: Delta): { message: DeltaMessage } | undefined;
	/** `tool_result` result carrying the delta, or undefined when the context or this batch already holds it. */
	afterTools(ctx: ExtensionContext, delta: Delta): { additionalContext: string } | undefined;
}

/** The source's latest delta in the context: none yet, a retraction, or a body. */
type Effective = { readonly kind: "absent" } | { readonly kind: "retracted" } | { readonly kind: "text"; readonly body: string };

const CLOSE = "\n</system-reminder>";

function openTag(source: string): string {
	return `<system-reminder source="${source}">\n`;
}

function supersedeLine(source: string): string {
	return `This reminder supersedes every earlier reminder from ${source}; only this one applies.`;
}

function retractionLine(source: string): string {
	return `The earlier reminders from ${source} no longer apply.`;
}

function render(source: string, inner: string): string {
	return `${openTag(source)}${inner}${CLOSE}`;
}

/** Inverse of `render` for the source's last block in `text`, or undefined when `text` holds none. */
function lastBlock(source: string, text: string): Effective | undefined {
	const open = openTag(source);
	const start = text.lastIndexOf(open);
	if (start < 0) return undefined;
	const end = text.indexOf(CLOSE, start + open.length);
	if (end < 0) return undefined;
	const inner = text.slice(start + open.length, end);
	if (inner === retractionLine(source)) return { kind: "retracted" };
	const supersede = `${supersedeLine(source)}\n\n`;
	return { kind: "text", body: inner.startsWith(supersede) ? inner.slice(supersede.length) : inner };
}

function inProjection(ctx: ExtensionContext, source: string): Effective {
	const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message === undefined || !("role" in message)) continue;
		const carrier =
			(message.role === "custom" && message.customType === source) || (message.role === "developer" && message.attribution === "agent");
		if (!carrier) continue;
		const block = lastBlock(source, textOf(message.content, "\n"));
		if (block !== undefined) return block;
	}
	return { kind: "absent" };
}

/** The text to send so that `wanted` becomes effective, or undefined when it already is. */
function nextText(source: string, effective: Effective, wanted: Delta): string | undefined {
	switch (wanted.kind) {
		case "none":
			return effective.kind === "text" ? render(source, retractionLine(source)) : undefined;
		case "text":
			switch (effective.kind) {
				case "absent":
					return render(source, wanted.body);
				case "retracted":
					return render(source, `${supersedeLine(source)}\n\n${wanted.body}`);
				case "text":
					return effective.body === wanted.body ? undefined : render(source, `${supersedeLine(source)}\n\n${wanted.body}`);
				default: {
					const unreachable: never = effective;
					return unreachable;
				}
			}
		default: {
			const unreachable: never = wanted;
			return unreachable;
		}
	}
}

/** The delta stream of extension `id`; one per extension instance, created in its factory. */
export function createDeltaStream(pi: ExtensionAPI, id: string): DeltaStream {
	const source = `omp-config/${id}`;
	let batch: Effective | undefined;
	pi.on("turn_start", () => {
		batch = undefined;
	});
	return {
		atPrompt(ctx, delta) {
			const text = nextText(source, inProjection(ctx, source), delta);
			if (text === undefined) return undefined;
			return { message: { customType: source, content: text, display: false, attribution: "agent" } };
		},
		afterTools(ctx, delta) {
			const text = nextText(source, batch ?? inProjection(ctx, source), delta);
			if (text === undefined) return undefined;
			batch = delta.kind === "text" ? { kind: "text", body: delta.body } : { kind: "retracted" };
			return { additionalContext: text };
		},
	};
}
