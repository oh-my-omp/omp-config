import type { Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MODEL_ROLE_IDS, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { kindOf } from "@oh-my-pi/pi-coding-agent/judgment";
import { sessionSettings } from "./settings.ts";

/** A concrete thinking level: off or one of the host's efforts. */
export type RoleLevel = "off" | (typeof THINKING_EFFORTS)[number];

/** One chat model of a role chain; `level` is the entry's `:level` suffix, undefined without one. */
export type RoleModel = { readonly role: string; readonly model: Model; readonly level: RoleLevel | undefined };

/** A role name without its `@` selector prefix. */
export function roleName(value: string): string {
	return value.trim().replace(/^@/, "");
}

/** `provider/id`. */
export function modelLabel(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The chat models of each OMP model role, concatenated in order and deduped:
 * each role's own chain (`modelRoles.<role>`, then `retry.fallbackChains.<role>`,
 * then OMP's defaults for a built-in role). An unassigned custom role
 * contributes nothing; its bare `@role` selector is never fuzzy-matched against
 * model ids. Resolved from the calling session's live settings on every call,
 * so a `/model` role change applies to the next request. On-device and native
 * judgment models are skipped. Throws when the session is not registered yet.
 */
export function roleModels(ctx: ExtensionContext, roles: readonly string[]): RoleModel[] {
	const settings = sessionSettings(ctx);
	if (settings === undefined) throw new Error("model roles: current OMP session is not registered");
	const out: RoleModel[] = [];
	const seen = new Set<string>();
	for (const raw of roles) {
		const role = roleName(raw);
		const builtIn = MODEL_ROLE_IDS.some((id) => id === role);
		for (const candidate of resolveRoleChain(role, settings, roleCandidatePool(role, settings, ctx.modelRegistry))) {
			if (!builtIn && !candidate.explicit) continue;
			if (kindOf(candidate) !== "online") continue;
			const label = modelLabel(candidate.model);
			if (seen.has(label)) continue;
			seen.add(label);
			const level = candidate.thinkingLevel;
			out.push({
				role,
				model: candidate.model,
				level: level === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === level),
			});
		}
	}
	return out;
}
