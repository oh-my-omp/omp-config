import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { createDeltaStream, type Delta } from "../_shared/omomp-shared/context-delta.ts";

const API = "google-gemini-cli";
const ARGON_ID = /^gemini-4-argon/;
const PROMPT_FILE = join(import.meta.dir, "ARGON_PROMPT.md");
const TIMEOUT_FIELDS = ["streamIdleTimeoutMs", "streamFirstEventTimeoutMs"] as const;

type ArgonModel = Model<typeof API>;

function isArgon(model: Model<Api>): model is ArgonModel {
	return model.api === API && ARGON_ID.test(model.id);
}

// Never write into model.compat: catalog rows share one compat object, so a write leaks into other models.
// Never drop the compatConfig fallback: Google compat resolution discards models.yml timeout values.
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

function guard<T>(pi: ExtensionAPI, action: string, run: () => T): T | undefined {
	try {
		return run();
	} catch (error) {
		pi.logger.warn(`argon-long-output: cannot ${action}`, { error: errorText(error) });
		return undefined;
	}
}

export default function argonLongOutput(pi: ExtensionAPI): void {
	let warnedReason: string | null = null;

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

	const deliver = <R>(ctx: ExtensionContext, send: (delta: Delta) => R): R | undefined =>
		guard(pi, "deliver argon prompt", () => {
			const delta = promptDelta(ctx);
			return delta === undefined ? undefined : send(delta);
		});

	const sweepHook = (_event: unknown, ctx: ExtensionContext): void => {
		guard(pi, "apply timeout defaults", () => sweep(ctx));
	};
	pi.on("session_start", sweepHook);
	pi.on("session.compacting", sweepHook);
	pi.on("context", (_event, ctx) => {
		guard(pi, "apply timeout defaults", () => patchModel(ctx.model));
	});

	const deltas = createDeltaStream("omp-config/argon-long-output");
	pi.on("turn_start", () => {
		deltas.turnStarted();
	});
	pi.on("before_agent_start", (event, ctx) => {
		sweepHook(event, ctx);
		if (event.reason === "revive") return;
		return deliver(ctx, (delta) => deltas.atPrompt(ctx, delta));
	});
	pi.on("tool_result", (_event, ctx) => deliver(ctx, (delta) => deltas.afterTools(ctx, delta)));
}
