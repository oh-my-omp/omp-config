import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { errorText } from "../_shared/errors.ts";

export interface ToolTopicInjectionRule {
	readonly id: string;
	readonly tool: string;
	readonly parameter: string;
	readonly pattern: RegExp;
	readonly topic: string;
}

function stringArgument(input: Record<string, unknown>, parameter: string): string | undefined {
	let value: unknown = input;
	for (const segment of parameter.split(".")) {
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return undefined;
		value = Reflect.get(value, segment);
	}
	return typeof value === "string" ? value : undefined;
}

export function installToolTopicInjection(
	pi: ExtensionAPI,
	options: {
		readonly owner: string;
		readonly rules: readonly ToolTopicInjectionRule[];
	},
): void {
	if (!options.owner.trim()) throw new Error("Topic injection owner must be non-empty");
	const claimDeliveries = createContextDelivery(pi);
	pi.on("tool_result", async (event, ctx) => {
		try {
			const ready: { marker: string; topic: string; content: string }[] = [];
			for (const rule of options.rules) {
				if (event.toolName !== rule.tool) continue;
				const argument = stringArgument(event.input, rule.parameter);
				if (argument === undefined) continue;
				rule.pattern.lastIndex = 0;
				if (!rule.pattern.test(argument)) continue;
				try {
					const marker = `<tool-topic-injection rule="${encodeURIComponent(options.owner)}/${encodeURIComponent(rule.id)}" `;
					const resource = await InternalUrlRouter.instance().resolve(rule.topic);
					if (!resource.content.trim()) throw new Error(`Topic '${rule.topic}' is empty`);
					ready.push({ marker, topic: rule.topic, content: resource.content });
				} catch (error) {
					pi.logger.warn("tool-topic-injection: topic unavailable", { owner: options.owner, rule: rule.id, error: errorText(error) });
				}
			}
			// Claim after loading, and only once every topic resolved: parallel calls may have delivered a marker meanwhile.
			const claims = claimDeliveries(
				ctx,
				ready.map((entry) => entry.marker),
			);
			const parts: string[] = [];
			for (let index = 0; index < ready.length; index++) {
				const entry = ready[index];
				if (entry === undefined || claims[index] !== true) continue;
				parts.push(`${entry.marker}topic="${entry.topic}">\n${entry.content}\n</tool-topic-injection>`);
			}
			if (parts.length > 0) return { additionalContext: parts.join("\n\n") };
		} catch (error) {
			pi.logger.warn("tool-topic-injection: rules unavailable", { owner: options.owner, error: errorText(error) });
		}
	});
}
