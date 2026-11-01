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
// WHERE. `session_start` and `before_agent_start` patch the session model and
// every available registry row; `context`, which runs before every model call
// (turns, subagent turns, auto-retry continuations), patches the session model.
// Gap: compaction picks its model from the registry, and a row the host
// rebuilds after the last `before_agent_start` (a models.yml reload or a
// context-window refit mid-turn) keeps the 300 s default until the next prompt.
//
// PROMPT. `before_agent_start`, in the main session and in every subagent, each
// matched against its own model, appends `ARGON_PROMPT.md` (beside this
// module, re-read per prompt) to the system prompt: keep every `write`/`edit`
// payload and final reply within 8,000 characters by writing a skeleton first
// and filling it one section per `edit`.
//
// Registers session_start, before_agent_start and context; no tools or
// commands; writes no files. Failure policy: a missing or unreadable
// ARGON_PROMPT.md warns once per reason and appends nothing; any other error is
// logged and the prompt or request proceeds unchanged. Nothing throws into omp.
// ============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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

function patchRegistry(ctx: ExtensionContext): void {
	patchModel(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable("all")) patchModel(model);
}

type PromptRead = { readonly kind: "ok"; readonly text: string } | { readonly kind: "failed"; readonly reason: string };

async function readPrompt(): Promise<PromptRead> {
	try {
		const text = (await readFile(PROMPT_FILE, "utf8")).trim();
		return text === "" ? { kind: "failed", reason: `${PROMPT_FILE} is empty` } : { kind: "ok", text };
	} catch (error) {
		return { kind: "failed", reason: `cannot read ${PROMPT_FILE}: ${errorText(error)}` };
	}
}

export default function argonLongOutput(pi: ExtensionAPI): void {
	/** Last prompt-file failure already logged, so a broken file warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		try {
			patchRegistry(ctx);
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot apply timeout defaults", { error: errorText(error) });
		}
	});

	pi.on("context", (_event, ctx) => {
		try {
			patchModel(ctx.model);
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot apply timeout defaults", { error: errorText(error) });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			patchRegistry(ctx);
			const model = ctx.model;
			if (model === undefined || !isArgon(model)) return;
			const prompt = await readPrompt();
			switch (prompt.kind) {
				case "failed":
					if (warnedReason !== prompt.reason) {
						warnedReason = prompt.reason;
						pi.logger.warn(`argon-long-output: ${prompt.reason}; not appending`);
					}
					return;
				case "ok":
					warnedReason = null;
					return { systemPrompt: [...event.systemPrompt, prompt.text] };
				default: {
					const unreachable: never = prompt;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("argon-long-output: cannot prepare argon prompt", { error: errorText(error) });
		}
	});
}
