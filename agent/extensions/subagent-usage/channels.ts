// Which first models have a computable quota: built-in usage reporting, not routed through a models.yml channel.
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";

export type Channel = { readonly kind: "tracked" } | { readonly kind: "untracked"; readonly reason: string };

const TRACKED: Channel = { kind: "tracked" };

/**
 * A provider is untracked without an omp usage provider, or when models.yml gives it its own transport
 * (baseUrl, credentials, api, headers, auth, discovery). Re-reads models.yml on every call, so an edit
 * applies without a restart.
 */
export function providerChannel(session: AgentSession, provider: string): Channel {
	if (!session.modelRegistry.authStorage.usage.providerFor(provider)) {
		return { kind: "untracked", reason: "provider has no quota reporting in omp" };
	}
	ModelsConfigFile.invalidate();
	const entry = ModelsConfigFile.load()?.providers?.[provider];
	if (
		entry &&
		(entry.baseUrl !== undefined ||
			entry.apiKey !== undefined ||
			entry.api !== undefined ||
			entry.headers !== undefined ||
			entry.auth !== undefined ||
			entry.authHeader !== undefined ||
			entry.discovery !== undefined)
	) {
		return { kind: "untracked", reason: "provider transport is customized in models.yml" };
	}
	return TRACKED;
}

/**
 * A model is untracked on an untracked provider, or when models.yml defines it or overrides its headers;
 * metadata-only overrides (context window, cost) keep it tracked.
 */
export function channelOf(session: AgentSession, model: Model<Api>): Channel {
	const provider = providerChannel(session, model.provider);
	if (provider.kind === "untracked") return provider;
	const entry = ModelsConfigFile.load()?.providers?.[model.provider];
	if (entry?.models?.some((definition) => definition.id === model.id)) {
		return { kind: "untracked", reason: "model is defined in models.yml" };
	}
	if (entry?.modelOverrides?.[model.id]?.headers !== undefined) {
		return { kind: "untracked", reason: "model transport is customized in models.yml" };
	}
	return TRACKED;
}
