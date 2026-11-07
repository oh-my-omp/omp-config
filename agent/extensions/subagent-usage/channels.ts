// Which first models have a computable quota: built-in usage reporting, not routed through a models.yml channel.
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

export type Channel = { readonly kind: "tracked" } | { readonly kind: "untracked"; readonly reason: string };

/** Channel verdicts of one entry point: models.yml is read once and each provider's verdict computed once. */
export type Channels = {
	/** A provider by id. */
	readonly provider: (provider: string) => Channel;
	/** A model, which also depends on its provider's transport and its own models.yml entry. */
	readonly model: (model: Pick<Model<Api>, "provider" | "id">) => Channel;
};

const TRACKED: Channel = { kind: "tracked" };

/**
 * Builds the channel verdicts of one tool call or calibration. models.yml is re-read here, once per entry point,
 * so an edit applies without a restart.
 */
export function channelsOf(session: AgentSession): Channels {
	ModelsConfigFile.invalidate();
	const config = ModelsConfigFile.load();
	const providers = new Map<string, Channel>();
	const provider = (id: string): Channel => {
		const known = providers.get(id);
		if (known !== undefined) return known;
		const verdict = providerChannel(session, config, id);
		providers.set(id, verdict);
		return verdict;
	};
	return { provider, model: (model) => channelOf(provider(model.provider), config, model) };
}

/**
 * A provider is untracked without an omp usage provider, or when models.yml gives it its own transport
 * (baseUrl, credentials, api, headers, auth, discovery).
 */
function providerChannel(session: AgentSession, config: ModelsConfig | null, provider: string): Channel {
	if (!session.modelRegistry.authStorage.usage.providerFor(provider)) {
		return { kind: "untracked", reason: "provider has no quota reporting in omp" };
	}
	const entry = config?.providers?.[provider];
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
function channelOf(provider: Channel, config: ModelsConfig | null, model: Pick<Model<Api>, "provider" | "id">): Channel {
	if (provider.kind === "untracked") return provider;
	const entry = config?.providers?.[model.provider];
	if (entry?.models?.some((definition) => definition.id === model.id)) {
		return { kind: "untracked", reason: "model is defined in models.yml" };
	}
	if (entry?.modelOverrides?.[model.id]?.headers !== undefined) {
		return { kind: "untracked", reason: "model transport is customized in models.yml" };
	}
	return TRACKED;
}
