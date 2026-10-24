import type { Judge } from "@oh-my-pi/pi-ai";
import { AgentRegistry, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { journalJudgmentUsage, kindOf, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";

/** `native`: only a native judgment API primary activates the judge; `any`: native, local or prompted chat. */
export type JudgeScope = "native" | "any";

export type JudgeOpen = { readonly kind: "ready"; readonly judge: Judge } | { readonly kind: "inactive" };

/**
 * OMP's own judge for the calling session: the `judge` role chain
 * (`modelRoles.judge`, then `retry.fallbackChains.judge`), walked in order on
 * missing credentials and provider errors, with OMP's account-rejection
 * cooldown, session usage ledger, pricing and shared answer cache. Abort and
 * timeout end the walk. From the first native candidate on only native
 * candidates remain, so a `native` judge never answers from a prompted model.
 * The gate reads the same instance's primary candidate the judgment uses.
 * `purpose` labels ledger entries and telemetry spans.
 */
export function openJudge(ctx: ExtensionContext, purpose: string, scope: JudgeScope): JudgeOpen {
	const session = AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
	if (session == null) throw new Error("JUDGE: current OMP session is not registered");
	const judge = resolveJudge({
		settings: session.settings,
		registry: session.modelRegistry,
		sessionModel: session.model,
		sessionId: session.sessionId,
		metadataResolver: (provider) => session.agent.metadataForProvider(provider),
		purpose,
		onUsage: journalJudgmentUsage(session.sessionManager),
		telemetry: session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	const primary = judge.primaryModel();
	if (primary === undefined) return { kind: "inactive" };
	switch (scope) {
		case "native":
			return kindOf(primary) === "native" ? { kind: "ready", judge } : { kind: "inactive" };
		case "any":
			return { kind: "ready", judge };
		default: {
			const exhaustive: never = scope;
			return exhaustive;
		}
	}
}
