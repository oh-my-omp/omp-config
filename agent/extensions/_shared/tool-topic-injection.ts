/**
 * Progressive topic delivery for any tool's string argument (dotted paths allowed).
 * installToolTopicInjection binds one provider to this extension/session; external
 * plugins may use it with a distinct stable owner. It does not register topics.
 * Bodies come only from the tool:// registry. Matched rules are delivered after
 * the tool batch via trusted additionalContext, including failed tool results.
 * The actual-context guard also handles resume/branch/compaction; no durable
 * counters, fake context ids, user messages, command changes or body cache.
 */
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { createContextDelivery } from "./context-delivery.ts";
import { errorText } from "./errors.ts";

export interface ToolTopicInjectionRule {
	readonly id: string;
	readonly tool: string;
	readonly parameter: string;
	readonly pattern: RegExp;
	readonly topic: string;
}

function validPattern(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		// Invalid configured regular expressions are expected input failures.
		return false;
	}
}

/** Parse raw configuration once at its boundary; output rules have compiled patterns. */
export const toolTopicInjectionRulesSchema = z
	.array(
		z
			.object({
				id: z.string().min(1),
				tool: z.string().min(1),
				parameter: z.string().refine((value) => /^[A-Za-z_][\w]*(?:\.[\w]+)*$/.test(value), "Expected an argument name or dotted path"),
				pattern: z
					.string()
					.refine(validPattern, "Invalid regular expression")
					.transform((source) => new RegExp(source)),
				topic: z.string().refine((value) => /^tool:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), "Expected tool://<tool>/<topic>"),
			})
			.strict(),
	)
	.refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Rule ids must be unique within an owner");

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
 * distinct rules targeting one topic each get one delivery. Configuration may be
 * re-read by rules(ctx). Failed topic loads do not consume delivery eligibility.
 */
export function installToolTopicInjection(
	pi: ExtensionAPI,
	options: {
		readonly owner: string;
		readonly rules: (ctx: ExtensionContext) => readonly ToolTopicInjectionRule[];
	},
): void {
	if (!options.owner.trim()) throw new Error("Topic injection owner must be non-empty");
	const claimDelivery = createContextDelivery(pi);
	pi.on("tool_result", async (event, ctx) => {
		const parts: string[] = [];
		try {
			for (const rule of options.rules(ctx)) {
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
					// Claim after loading, and recheck after await: parallel calls may have delivered it meanwhile.
					if (claimDelivery(ctx, marker)) parts.push(rendered);
				} catch (error) {
					pi.logger.warn("tool-topic-injection: topic unavailable", { owner: options.owner, rule: rule.id, error: errorText(error) });
				}
			}
		} catch (error) {
			pi.logger.warn("tool-topic-injection: rules unavailable", { owner: options.owner, error: errorText(error) });
		}
		if (parts.length > 0) return { additionalContext: parts.join("\n\n") };
	});
}
