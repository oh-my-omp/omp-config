// Correct commandcode model selection on session_start in main and sub sessions.
// Reads the plugin-generated COMMANDCODE_MODELS_CACHE override or
// <getAgentDir()>/commandcode-models.json; writes no files and registers no tools/commands.
// Missing/unreadable/malformed catalogs leave the model unchanged; unexpected hook
// failures are logged as warnings without interrupting the session.
//
// The installed pi-commandcode-provider plugin registers EVERY commandcode model
// on its own request-time transport, `api: "commandcode-custom"`, whose streamSimple
// self-supplies the key from `~/.commandcode/auth.json` (etc.) at request time. So a
// session running a commandcode model under any other `api` is, by construction, wrong.
// Two host behaviors break that invariant when a model is chosen via `--model`:
//
//   (a) Spec collision. commandcode ids embed a namespace that is also a built-in
//       provider name and can name the same model (`google/gemini-3.5-flash-lite`,
//       `deepseek/deepseek-v4-flash`). OMP splits the first slash into `provider/id`,
//       so the spec resolves to the built-in, credential-less `google`/`deepseek`
//       provider and the turn dies with "No API key found for <provider>".
//   (b) Cache shadow. The model cache (`~/.omp/agent/models.db`) persists commandcode
//       models normalized to `openai-completions`/`anthropic-messages` with a `baseUrl`
//       and no streamSimple. Startup `--model commandcode/<id>` resolution returns those
//       cached rows, so the host's OpenAI transport runs with the host-side literal
//       `$COMMANDCODE_API_KEY` and the endpoint answers 401 — even for a fully-qualified
//       `commandcode/<id>`.
//
// Omitting `--model` works because the persisted session model resolves through the
// live plugin registration (`commandcode-custom`); `ctx.models.resolve(...)` returns the
// same live model even when the cache shadows it. This extension enforces the invariant:
// when the user selected a commandcode catalog model but the session is not running it as
// `commandcode-custom`, it re-selects the live commandcode model via the registry. It
// registers no provider (the plugin stays authoritative for streaming, pricing, auth),
// does not change the default model or touch the cache, and never reads the auth key.
// The re-selection is an ordinary `setModel`, so the session records a `model_change`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, z } from "@oh-my-pi/pi-coding-agent";

import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

const COMMANDCODE = "commandcode";
const MODEL_PREFIX = `${COMMANDCODE}/`;
const COMMANDCODE_API = "commandcode-custom";

const catalogSchema = z.object({
	models: z.array(z.object({ id: z.string() })),
});

type ModelRef = { readonly provider: string; readonly id: string; readonly api?: string };

// Outcome of examining the resolved session model, modeled so every branch is explicit.
type Correction =
	| { readonly kind: "none" }
	| { readonly kind: "leave-credentialed"; readonly id: string; readonly provider: string }
	| {
			readonly kind: "rewrite";
			readonly id: string;
			readonly reason: "collision" | "cache-shadow";
			readonly from: string;
	  };

let cachedCatalogIds: ReadonlySet<string> | undefined;

function commandCodeCatalogIds(): ReadonlySet<string> {
	if (cachedCatalogIds !== undefined) return cachedCatalogIds;
	// The plugin's own model catalog — membership authority. This is the model list,
	// NOT the auth key file; no credential is read here.
	const path = process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json");
	try {
		const parsed = catalogSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		cachedCatalogIds = parsed.success ? new Set(parsed.data.models.map((model) => model.id)) : new Set<string>();
	} catch {
		// Missing/unreadable/malformed catalog → no membership known → fix no-ops.
		cachedCatalogIds = new Set<string>();
	}
	return cachedCatalogIds;
}

function classifyCorrection(current: ModelRef | undefined, available: readonly ModelRef[], catalogIds: ReadonlySet<string>): Correction {
	if (current === undefined) return { kind: "none" };

	const onCommandCode = current.provider === COMMANDCODE;
	// The commandcode catalog id the user is after: the id itself when already on the
	// commandcode provider, otherwise the spec OMP split onto a built-in provider.
	const catalogId = onCommandCode ? current.id : `${current.provider}/${current.id}`;
	if (!catalogIds.has(catalogId)) return { kind: "none" };

	if (onCommandCode) {
		// Already the commandcode provider: correct only when it runs the plugin transport.
		if (current.api === COMMANDCODE_API) return { kind: "none" };
		// Cache-shadowed onto a host transport — unambiguously wrong, no credential
		// question (it is already commandcode, just the wrong wire).
		return { kind: "rewrite", id: catalogId, reason: "cache-shadow", from: current.api ?? "unknown" };
	}

	// Spec collision: OMP resolved the id onto a built-in provider. Respect a genuinely
	// credentialed built-in selection (the user may really mean built-in google/deepseek);
	// only rescue the credential-less "No API key" failure.
	const currentUsable = available.some((model) => model.provider === current.provider && model.id === current.id);
	if (currentUsable) return { kind: "leave-credentialed", id: catalogId, provider: current.provider };
	return { kind: "rewrite", id: catalogId, reason: "collision", from: current.provider };
}

export default function commandcodeModelSpec(pi: ExtensionAPI): void {
	pi.setLabel(tr("Command Code --model spec", "Command Code --model 规格"));

	pi.on("session_start", async (_event, ctx) => {
		try {
			const current: ModelRef | undefined = ctx.models.current();
			const available: readonly ModelRef[] = ctx.models.list();
			const decision = classifyCorrection(current, available, commandCodeCatalogIds());

			switch (decision.kind) {
				case "none":
					return;
				case "leave-credentialed":
					// Deliberate no-op; recorded for audit but not surfaced to the user.
					pi.logger.info(`commandcode-model-spec: left "${decision.id}" on credentialed ${decision.provider}`);
					return;
				case "rewrite": {
					const target = ctx.models.resolve(`${MODEL_PREFIX}${decision.id}`);
					if (target === undefined) return;
					// Only ever switch onto the plugin's own transport (the runtime custom
					// `commandcode-custom` api is not part of the static Api union).
					const targetApi: string = target.api;
					if (targetApi !== COMMANDCODE_API) return;
					const switched = await pi.setModel(target);
					if (!switched) return;
					const notice =
						decision.reason === "collision"
							? tr(
									`--model "${decision.id}" hit credential-less ${decision.from}; selected ${MODEL_PREFIX}${decision.id}`,
									`--model "${decision.id}" 命中无凭据的 ${decision.from}；已选择 ${MODEL_PREFIX}${decision.id}`,
								)
							: tr(
									`--model "${decision.id}" was cache-shadowed onto ${decision.from}; selected ${MODEL_PREFIX}${decision.id} (${COMMANDCODE_API})`,
									`--model "${decision.id}" 被缓存影子映射到 ${decision.from}；已选择 ${MODEL_PREFIX}${decision.id}（${COMMANDCODE_API}）`,
								);
					pi.logger.info(`commandcode-model-spec: ${notice}`);
					// Surface the redirect: notify in interactive, stderr in headless (-p),
					// so a re-selection is never silent in the mode the user actually runs.
					if (ctx.hasUI) ctx.ui.notify(notice, "info");
					else process.stderr.write(`commandcode-model-spec: ${notice}\n`);
					return;
				}
				default: {
					const unreachable: never = decision;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("commandcode-model-spec could not check the session model", { error: errorText(error) });
		}
	});
}
