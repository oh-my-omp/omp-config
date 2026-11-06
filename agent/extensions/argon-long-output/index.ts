// ============================================================================
// argon-long-output — let gemini-4-argon finish long tool calls, and teach it to
// avoid them.
//
// WHY. Cloud Code Assist sends a `functionCall` as one finished part, so while
// argon generates a long `write(content=…)` the stream is silent after the
// thinking summary. omp's watchdogs read that silence as a stall: after 300 s
// the wrapper's idle watchdog aborts with "Provider stream stalled while
// waiting for the next event", the provider's first-event and pre-response
// watchdogs do the same before the first event, and every retry regenerates
// the same call and hits the same limit.
//
// MATCH. A model whose `api` is `google-gemini-cli` and whose id matches
// `^gemini-4-argon`, whatever its provider.
//
// TIMEOUTS. The three watchdogs resolve their budget as caller option >
// settings `providers.stream*TimeoutSeconds` (merged into the option) > env
// `PI_STREAM_IDLE_TIMEOUT_MS` / `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` >
// `model.compat.stream{Idle,FirstEvent}TimeoutMs` > 300000, and 0 disables a
// watchdog. This extension fills the compat layer of matching model objects:
// a value the host already resolved stays; else the sparse `compatConfig`
// value from models.yml (which the host's Google compat resolution drops);
// else 0. Options, settings and env therefore still win. It replaces
// `model.compat` with a copy instead of writing into it, because the catalog
// shares one compat object across rows. The model rows are shared process-wide,
// so the default applies to every session, subagent and compaction that uses
// the patched row. Abort (Esc, dispose) still cancels the request at once: the
// abort path does not depend on the watchdogs.
//
// WHERE. Every sweep patches the session model and every available registry
// row. It runs on `session_start`, `before_agent_start`, `context` (before
// every model call: turns, subagent turns, auto-retry continuations) and
// `session.compacting`. OMP emits `session.compacting` on every LLM compaction
// path (manual `/compact`, automatic, speculative) before the summary request,
// and picks the compaction model from the session model and the registry rows,
// so rows rebuilt by a models.yml reload since the last turn are patched before
// they stream. The handler returns nothing, so the compaction itself is
// unchanged. A context-window refit would build a row no sweep sees; OMP gives
// the argon rows no window tiers, so it does not refit them.
//
// PROMPT. In the main session and in every subagent, each matched against its
// own model, `ARGON_PROMPT.md` (beside this module, re-read at every delivery
// point) reaches an argon session as one delta of `_shared/context-delta.ts`
// with source `omp-config/argon-long-output`: keep every `write`/`edit`
// payload and final reply within 8,000 characters by writing a skeleton first
// and filling it one section per `edit`. The system prompt stays as OMP built
// it. Delivery points are `before_agent_start` (after the prompt) and
// `tool_result` (after the tool batch); the delta is sent only when it differs
// from the source's effective delta in the current context, so a session holds
// one copy until compaction drops it or the file changes. A session whose model
// stops matching gets a delta saying the earlier one no longer applies. A
// revive's `before_agent_start` delivers nothing, because OMP discards its result.
//
// Registers session_start, before_agent_start, context, session.compacting,
// tool_result and the delta stream's turn_start; no tools or commands; writes
// no files. Failure policy: a missing or unreadable ARGON_PROMPT.md warns once
// per reason and delivers nothing, leaving any delta already in the context in
// effect; any other error is logged and the prompt or request proceeds
// unchanged. Nothing throws into omp.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../_shared/context-delta.ts";
import { errorText } from "../_shared/errors.ts";

const API = "google-gemini-cli";
const ARGON_ID = /^gemini-4-argon/;
const PROMPT_FILE = join(import.meta.dir, "ARGON_PROMPT.md");
const TIMEOUT_FIELDS = ["streamIdleTimeoutMs", "streamFirstEventTimeoutMs"] as const;

type ArgonModel = Model<typeof API>;

function isArgon(model: Model<Api>): model is ArgonModel {
	return model.api === API && ARGON_ID.test(model.id);
}

/** Fill the compat timeout layer of one argon row; see TIMEOUTS above. */
function applyTimeoutDefault(model: ArgonModel): void {
	let next: ArgonModel["compat"] | undefined;
	for (const field of TIMEOUT_FIELDS) {
		if (model.compat[field] !== undefined) continue;
		next ??= { ...model.compat };
		next[field] = model.compatConfig?.[field] ?? 0;
	}
	if (next !== undefined) model.compat = next;
}

function patchModel(model: Model<Api> | undefined): void {
	if (model !== undefined && isArgon(model)) applyTimeoutDefault(model);
}

/** Patch the session model and every available registry row; see WHERE above. */
function sweep(ctx: ExtensionContext): void {
	patchModel(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable("all")) patchModel(model);
}

type PromptRead = { readonly kind: "ok"; readonly text: string } | { readonly kind: "failed"; readonly reason: string };

function readPrompt(): PromptRead {
	try {
		const text = readFileSync(PROMPT_FILE, "utf8").trim();
		return text === "" ? { kind: "failed", reason: `${PROMPT_FILE} is empty` } : { kind: "ok", text };
	} catch (error) {
		return { kind: "failed", reason: `cannot read ${PROMPT_FILE}: ${errorText(error)}` };
	}
}

export default function argonLongOutput(pi: ExtensionAPI): void {
	/** Last prompt-file failure already logged, so a broken file warns once per reason. */
	let warnedReason: string | null = null;

	/** The delta this session should hold, or undefined when ARGON_PROMPT.md cannot be read. */
	const promptDelta = (ctx: ExtensionContext): Delta | undefined => {
		const model = ctx.model;
		if (model === undefined || !isArgon(model)) return { kind: "none" };
		const prompt = readPrompt();
		switch (prompt.kind) {
			case "failed":
				if (warnedReason !== prompt.reason) {
					warnedReason = prompt.reason;
					pi.logger.warn(`argon-long-output: ${prompt.reason}; not delivering`);
				}
				return undefined;
			case "ok":
				warnedReason = null;
				return { kind: "text", body: prompt.text };
			default: {
				const unreachable: never = prompt;
				return unreachable;
			}
		}
	};

	const sweepHook = (_event: unknown, ctx: ExtensionContext): void => {
		try {
			sweep(ctx);
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot apply timeout defaults", { error: errorText(error) });
		}
	};
	pi.on("session_start", sweepHook);
	pi.on("context", sweepHook);
	pi.on("session.compacting", sweepHook);

	const deltas = createDeltaStream(pi, "argon-long-output");
	pi.on("before_agent_start", (event, ctx) => {
		sweepHook(event, ctx);
		// OMP discards the result of a revive.
		if (event.reason === "revive") return;
		try {
			const delta = promptDelta(ctx);
			return delta === undefined ? undefined : deltas.atPrompt(ctx, delta);
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot deliver argon prompt", { error: errorText(error) });
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			const delta = promptDelta(ctx);
			return delta === undefined ? undefined : deltas.afterTools(ctx, delta);
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot deliver argon prompt", { error: errorText(error) });
		}
	});
}
