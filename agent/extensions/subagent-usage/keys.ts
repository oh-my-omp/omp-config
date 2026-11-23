export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type ModelRef = { readonly provider: string; readonly id: string };

export function modelKey(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelKey(key: string): ModelRef | undefined {
	const separator = key.indexOf("/");
	return separator > 0 ? { provider: key.slice(0, separator), id: key.slice(separator + 1) } : undefined;
}

export function priorModelKey(model: string, thinking: string): string {
	return `${model}|${thinking}`;
}

export function priorAgentKey(agent: string, model: string, thinking: string): string {
	return `${agent}|${priorModelKey(model, thinking)}`;
}
