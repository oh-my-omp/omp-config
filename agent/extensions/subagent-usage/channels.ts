import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

export type Channel = { readonly kind: "tracked" } | { readonly kind: "untracked"; readonly reason: string };

export type Channels = {
	readonly provider: (provider: string) => Channel;
	readonly model: (model: Pick<Model<Api>, "provider" | "id">) => Channel;
};

const TRACKED: Channel = { kind: "tracked" };

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
