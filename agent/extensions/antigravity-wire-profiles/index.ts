// Make Antigravity request limits follow the backend model list instead of omp's
// hand-captured wire table.
//
// The google-gemini-cli provider writes the caller's `maxTokens` into
// `generationConfig.maxOutputTokens`, then, for Antigravity, overrides it (and
// sets `labels.model_enum`) from `ANTIGRAVITY_MODEL_WIRE_PROFILES` in
// `@oh-my-pi/pi-catalog/wire/gemini-headers` — a static table captured once in
// June 2026. Wire ids added since (the `gemini-4-argon-*` tiers) are missing, so
// callers' small budgets go out unchanged: compaction's short summary sends 512
// output tokens at high thinking and Gemini spends all of them thinking
// ("thought-only response without final output"). Entries the table does have
// can be stale (`gemini-3-flash-agent`'s model enum).
//
// On the root session's `session_start` this extension asks the backend's own
// list (`POST <antigravity baseUrl>/v1internal:fetchAvailableModels`, the
// endpoint omp's discovery reads) once per stored Antigravity account plus the
// session's own credential, unions the served rows (not internal, not disabled,
// positive integer `maxOutputTokens`) and writes each into the exported table as
// `{ modelEnum, maxOutputTokens }`. Rows are only added or overwritten, never
// deleted: one account's roster does not prove another account lacks a model,
// and an id no account serves is not selectable anyway. The provider reads the
// table on every request, so agent turns, compaction and in-process subagents
// all use the backend values; a profile makes the provider ignore the caller's
// `maxTokens` for that wire id, which is the table's documented contract.
//
// `session_start` awaits the load (bounded below the host's handler timeout) so
// a `/compact` cannot race it; `before_agent_start` awaits the same in-flight
// promise as a safety net. Registers no tools or commands and writes no files.
// Scope: the root main session; the table is process-wide, so a process hosting
// several top-level sessions shares one union. Failure policy: no Antigravity
// model or credential is a silent no-op; when no account yields a usable list the
// table keeps its previous contents, a warning goes to the log and the main UI,
// and the next root session start retries. Nothing throws into omp.

import {
	ANTIGRAVITY_MODEL_WIRE_PROFILES,
	type AntigravityModelWireProfile,
	ensureAntigravityVersion,
	getAntigravityUserAgent,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";

import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";

const PROVIDER = "google-antigravity";
const API = "google-gemini-cli";
const LIST_PATH = "/v1internal:fetchAvailableModels";
const LOAD_TIMEOUT_MS = 20_000;

// The provider looks entries up in this exported object on every request. Its
// declared type is Readonly, but the object is not frozen; writing it in place is
// the only way to reach callers (compaction) that bypass extension request hooks.
const wireTable = ANTIGRAVITY_MODEL_WIRE_PROFILES as Record<string, AntigravityModelWireProfile>;

const credentialSchema = z.object({ token: z.string().min(1) }).passthrough();
const rowSchema = z
	.object({
		model: z.string().optional(),
		maxOutputTokens: z.number().optional(),
		disabled: z.boolean().optional(),
		isInternal: z.boolean().optional(),
	})
	.passthrough();
const listSchema = z.object({ models: z.record(z.string(), z.unknown()) }).passthrough();

type Profiles = ReadonlyMap<string, AntigravityModelWireProfile>;

type AccountList = { readonly kind: "listed"; readonly profiles: Profiles } | { readonly kind: "failed"; readonly reason: string };

type Fetched =
	| { readonly kind: "no-model" }
	| { readonly kind: "no-credential"; readonly model: string }
	| { readonly kind: "failed"; readonly reasons: readonly string[] }
	| {
			readonly kind: "listed";
			readonly endpoint: string;
			readonly accounts: number;
			readonly profiles: Profiles;
			readonly failures: readonly string[];
	  };

type LoadState = { readonly kind: "idle" } | { readonly kind: "loading"; readonly done: Promise<void> } | { readonly kind: "applied" };

let state: LoadState = { kind: "idle" };

/** Served rows of one backend list, as wire profiles keyed by wire id. */
function profilesFrom(models: Readonly<Record<string, unknown>>): Profiles {
	const profiles = new Map<string, AntigravityModelWireProfile>();
	for (const [wireId, raw] of Object.entries(models)) {
		if (wireId.length === 0) continue;
		const row = rowSchema.safeParse(raw);
		if (!row.success) continue;
		const { model, maxOutputTokens, disabled, isInternal } = row.data;
		if (disabled === true || isInternal === true) continue;
		if (maxOutputTokens === undefined || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) continue;
		profiles.set(wireId, model === undefined || model.length === 0 ? { maxOutputTokens } : { modelEnum: model, maxOutputTokens });
	}
	return profiles;
}

async function fetchAccountList(endpoint: string, token: string, signal: AbortSignal): Promise<AccountList> {
	try {
		const response = await fetch(`${endpoint}${LIST_PATH}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": getAntigravityUserAgent() },
			body: "{}",
			signal,
		});
		if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
		const list = listSchema.safeParse(await response.json());
		if (!list.success) return { kind: "failed", reason: "no model map in the response" };
		const profiles = profilesFrom(list.data.models);
		return profiles.size === 0 ? { kind: "failed", reason: "no served model with an output limit" } : { kind: "listed", profiles };
	} catch (error) {
		return { kind: "failed", reason: errorText(error) };
	}
}

/** Access tokens to list with: the session's own credential first, then every stored account. */
async function accountTokens(ctx: ExtensionContext, sessionKey: string, signal: AbortSignal): Promise<readonly string[]> {
	const tokens: string[] = [];
	try {
		const credential = credentialSchema.safeParse(JSON.parse(sessionKey));
		if (credential.success) tokens.push(credential.data.token);
	} catch {
		// A non-JSON key is not an Antigravity OAuth credential; stored accounts may still list.
	}
	for (const access of await ctx.modelRegistry.authStorage.oauth.accessAll(PROVIDER, { signal })) {
		if (access.ok && !tokens.includes(access.accessToken)) tokens.push(access.accessToken);
	}
	return tokens;
}

async function fetchProfiles(ctx: ExtensionContext, signal: AbortSignal): Promise<Fetched> {
	const isAntigravity = (candidate: { provider: string; api: string; baseUrl: string }) =>
		candidate.provider === PROVIDER && candidate.api === API && /^https?:\/\//.test(candidate.baseUrl);
	const current = ctx.models.current();
	const model = current !== undefined && isAntigravity(current) ? current : ctx.models.list().find(isAntigravity);
	if (model === undefined) return { kind: "no-model" };
	const sessionKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId(), { signal });
	const tokens = await accountTokens(ctx, sessionKey ?? "", signal);
	if (tokens.length === 0) return { kind: "no-credential", model: model.id };

	await ensureAntigravityVersion(fetch, signal);
	const endpoint = model.baseUrl.replace(/\/+$/, "");
	const lists = await Promise.all(tokens.map((token) => fetchAccountList(endpoint, token, signal)));
	const profiles = new Map<string, AntigravityModelWireProfile>();
	const failures: string[] = [];
	for (const [index, list] of lists.entries()) {
		switch (list.kind) {
			case "listed":
				for (const [wireId, profile] of list.profiles) if (!profiles.has(wireId)) profiles.set(wireId, profile);
				break;
			case "failed":
				failures.push(`account ${index + 1}: ${list.reason}`);
				break;
			default: {
				const unreachable: never = list;
				return unreachable;
			}
		}
	}
	if (profiles.size === 0) return { kind: "failed", reasons: failures };
	return { kind: "listed", endpoint, accounts: tokens.length, profiles, failures };
}

/** Write the backend profiles into the table; returns the entries that changed. */
function applyProfiles(profiles: Profiles): readonly string[] {
	const changed: string[] = [];
	for (const [wireId, profile] of profiles) {
		const before = wireTable[wireId];
		if (before?.maxOutputTokens === profile.maxOutputTokens && before.modelEnum === profile.modelEnum) continue;
		wireTable[wireId] = profile;
		changed.push(`${before === undefined ? "+" : "~"}${wireId}=${profile.maxOutputTokens}/${profile.modelEnum ?? "-"}`);
	}
	return changed;
}

function warn(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
	pi.logger.warn("antigravity-wire-profiles: backend model list unavailable; the wire table keeps its previous contents", { reason });
	if (ctx.hasUI)
		ctx.ui.notify(
			tr(
				`Antigravity wire profiles not refreshed from the backend (${reason}); retried at next session start`,
				`Antigravity 线路配置未从后端刷新（${reason}）；将在下次会话启动时重试`,
			),
			"warning",
		);
}

async function load(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	let fetched: Fetched;
	try {
		fetched = await fetchProfiles(ctx, AbortSignal.timeout(LOAD_TIMEOUT_MS));
	} catch (error) {
		fetched = { kind: "failed", reasons: [errorText(error)] };
	}
	switch (fetched.kind) {
		case "no-model":
			state = { kind: "idle" };
			return;
		case "no-credential":
			state = { kind: "idle" };
			pi.logger.info(`antigravity-wire-profiles: no Antigravity credential for ${fetched.model}; table untouched`);
			return;
		case "failed":
			state = { kind: "idle" };
			warn(pi, ctx, fetched.reasons.join("; ") || "no account answered");
			return;
		case "listed": {
			const changed = applyProfiles(fetched.profiles);
			state = { kind: "applied" };
			pi.logger.info("antigravity-wire-profiles: wire table follows the backend model list", {
				endpoint: fetched.endpoint,
				accounts: fetched.accounts,
				entries: fetched.profiles.size,
				changed,
				failures: fetched.failures,
			});
			return;
		}
		default: {
			const unreachable: never = fetched;
			return unreachable;
		}
	}
}

export default function antigravityWireProfiles(pi: ExtensionAPI): void {
	pi.setLabel(tr("Antigravity wire profiles", "Antigravity 线路配置"));

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (state.kind === "idle") {
			const done = load(pi, ctx).catch((error: unknown) => {
				state = { kind: "idle" };
				pi.logger.warn("antigravity-wire-profiles: load failed", { error: errorText(error) });
			});
			state = { kind: "loading", done };
		}
		if (state.kind === "loading") await state.done;
	});

	pi.on("before_agent_start", async () => {
		if (state.kind === "loading") await state.done;
	});
}
