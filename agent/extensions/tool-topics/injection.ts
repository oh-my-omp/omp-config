import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { getToolTopicInjections, type ToolTopicDoc, type ToolTopicInjectRule } from "../_shared/omomp-shared/internal-url.ts";

export interface ToolTopicInjectionRule {
	readonly id: string;
	readonly tool: string;
	readonly parameter?: string;
	readonly pattern?: RegExp;
	readonly onError?: boolean;
	readonly resultPattern?: RegExp;
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

function compileRegex(source: string, cache: Map<string, RegExp | null>, onInvalid: (error: unknown) => void): RegExp | undefined {
	const cached = cache.get(source);
	if (cached !== undefined) return cached ?? undefined;
	try {
		const compiled = new RegExp(source);
		cache.set(source, compiled);
		return compiled;
	} catch (error) {
		cache.set(source, null);
		onInvalid(error);
		return undefined;
	}
}

function hubRules(
	docs: readonly ToolTopicDoc[],
	ownedTopics: ReadonlySet<string>,
	cache: Map<string, RegExp | null>,
	warnInvalid: (topic: string, pattern: string, error: unknown) => void,
): ToolTopicInjectionRule[] {
	const rules: ToolTopicInjectionRule[] = [];
	for (const doc of docs) {
		const topic = `tool://${doc.tool}/${doc.topic}`;
		if (ownedTopics.has(topic) || !doc.inject || doc.inject.length === 0) continue;
		for (const [index, raw] of doc.inject.entries()) {
			const compiled = compileHubRule(doc.tool, topic, index, raw, cache, warnInvalid);
			if (compiled !== undefined) rules.push(compiled);
		}
	}
	return rules;
}

function compileHubRule(
	tool: string,
	topic: string,
	index: number,
	raw: ToolTopicInjectRule,
	cache: Map<string, RegExp | null>,
	warnInvalid: (topic: string, pattern: string, error: unknown) => void,
): ToolTopicInjectionRule | undefined {
	let pattern: RegExp | undefined;
	if (raw.param !== undefined || raw.pattern !== undefined) {
		if (raw.param === undefined || raw.pattern === undefined) return undefined;
		pattern = compileRegex(raw.pattern, cache, (error) => warnInvalid(topic, raw.pattern!, error));
		if (pattern === undefined) return undefined;
	}
	let resultPattern: RegExp | undefined;
	if (raw.resultPattern !== undefined) {
		resultPattern = compileRegex(raw.resultPattern, cache, (error) => warnInvalid(topic, raw.resultPattern!, error));
		if (resultPattern === undefined) return undefined;
	}
	const onError = raw.onError === true ? true : undefined;
	if (raw.param === undefined && onError === undefined && resultPattern === undefined) return undefined;
	return {
		id: `hub/${tool}/${topic.slice(`tool://${tool}/`.length)}/${index}`,
		tool,
		...(raw.param !== undefined ? { parameter: raw.param } : {}),
		...(pattern !== undefined ? { pattern } : {}),
		...(onError !== undefined ? { onError } : {}),
		...(resultPattern !== undefined ? { resultPattern } : {}),
		topic,
	};
}

function matchesRule(rule: ToolTopicInjectionRule, event: ToolResultEvent, resultText: () => string): boolean {
	if (event.toolName !== rule.tool) return false;
	if (rule.onError === true && !event.isError) return false;
	if (rule.parameter !== undefined) {
		const argument = stringArgument(event.input, rule.parameter);
		if (argument === undefined || rule.pattern === undefined) return false;
		rule.pattern.lastIndex = 0;
		if (!rule.pattern.test(argument)) return false;
	}
	if (rule.resultPattern !== undefined) {
		rule.resultPattern.lastIndex = 0;
		if (!rule.resultPattern.test(resultText())) return false;
	}
	return rule.onError === true || rule.parameter !== undefined || rule.resultPattern !== undefined;
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
	const ownedTopics = new Set(options.rules.map((rule) => rule.topic));
	const regexCache = new Map<string, RegExp | null>();
	const warnInvalid = (topic: string, pattern: string, error: unknown): void => {
		pi.logger.warn("tool-topic-injection: invalid hub rule regex", { owner: options.owner, topic, pattern, error: errorText(error) });
	};
	pi.on("tool_result", async (event, ctx) => {
		try {
			let cachedText: string | undefined;
			const getResultText = (): string => {
				if (cachedText === undefined) cachedText = textOf(event.content, "\n");
				return cachedText;
			};
			const activeRules = [...options.rules, ...hubRules(getToolTopicInjections(), ownedTopics, regexCache, warnInvalid)];
			const ready: { dedupMarker: string; openTag: string; content: string }[] = [];
			const seenTopics = new Set<string>();
			for (const rule of activeRules) {
				if (seenTopics.has(rule.topic)) continue;
				if (!matchesRule(rule, event, getResultText)) continue;
				seenTopics.add(rule.topic);
				try {
					const resource = await InternalUrlRouter.instance().resolve(rule.topic);
					if (typeof resource.content !== "string") throw new Error(`Topic '${rule.topic}' is binary`);
					if (!resource.content.trim()) throw new Error(`Topic '${rule.topic}' is empty`);
					const ruleAttr = `${encodeURIComponent(options.owner)}/${encodeURIComponent(rule.id)}`;
					ready.push({
						dedupMarker: `topic="${rule.topic}">`,
						openTag: `<tool-topic-injection rule="${ruleAttr}" topic="${rule.topic}">`,
						content: resource.content,
					});
				} catch (error) {
					pi.logger.warn("tool-topic-injection: topic unavailable", { owner: options.owner, rule: rule.id, error: errorText(error) });
				}
			}
			// Claim after loading, and only once every topic resolved: parallel calls may have delivered a marker meanwhile.
			const claims = claimDeliveries(
				ctx,
				ready.map((entry) => entry.dedupMarker),
			);
			const parts: string[] = [];
			for (let index = 0; index < ready.length; index++) {
				const entry = ready[index];
				if (entry === undefined || claims[index] !== true) continue;
				parts.push(`${entry.openTag}\n${entry.content}\n</tool-topic-injection>`);
			}
			if (parts.length > 0) return { additionalContext: parts.join("\n\n") };
		} catch (error) {
			pi.logger.warn("tool-topic-injection: rules unavailable", { owner: options.owner, error: errorText(error) });
		}
	});
}
