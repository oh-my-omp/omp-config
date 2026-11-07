/**
 * Progressive topic delivery for any tool's string argument (dotted paths allowed).
 * installToolTopicInjection binds one provider, with a stable owner, to the calling
 * extension/session. It does not register topics: bodies come from the tool://
 * topics this extension serves. Matched rules are delivered after
 * the tool batch via trusted additionalContext, including failed tool results.
 * The actual-context guard also handles resume/branch/compaction; no durable
 * counters, fake context ids, user messages, command changes or body cache.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
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

/**
 * Install once per extension/session. owner + rule id is the delivery identity;
 * distinct rules targeting one topic each get one delivery. The rules are the
 * catalog's inject entries, fixed at load. Failed topic loads do not consume
 * delivery eligibility.
 */
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
			const ready: { rendered: string; marker: string }[] = [];
			for (const rule of options.rules) {
				if (event.toolName !== rule.tool) continue;
				const argument = stringArgument(event.input, rule.parameter);
				if (argument === undefined) continue;
				rule.pattern.lastIndex = 0;
				if (!rule.pattern.test(argument)) continue;
				try {
					const marker = `<tool-topic-injection rule="${encodeURIComponent(options.owner)}/${encodeURIComponent(rule.id)}" `;
					const resource = await InternalUrlRouter.instance().resolve(rule.topic);
					const rendered = `${marker}topic="${rule.topic}">\n${resource.content}\n</tool-topic-injection>`;
					if (!resource.content.trim()) throw new Error(`Topic '${rule.topic}' is empty`);
					ready.push({ rendered, marker });
				} catch (error) {
					pi.logger.warn("tool-topic-injection: topic unavailable", { owner: options.owner, rule: rule.id, error: errorText(error) });
				}
			}
			// Claim after loading, and only once every topic resolved: parallel calls may have delivered a marker meanwhile.
			const claims = claimDeliveries(
				ctx,
				ready.map((entry) => entry.marker),
			);
			const parts = ready.filter((_, i) => claims[i]).map((entry) => entry.rendered);
			if (parts.length > 0) return { additionalContext: parts.join("\n\n") };
		} catch (error) {
			pi.logger.warn("tool-topic-injection: rules unavailable", { owner: options.owner, error: errorText(error) });
		}
	});
}
