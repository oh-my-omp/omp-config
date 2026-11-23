import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import { getToolTopicInjections, type ToolTopicInjectRule } from "../_shared/omomp-shared/internal-url.ts";

const OWNER = "omp-config/tool-topic-injection";

export interface InjectionRule {
	readonly id: string;
	readonly tool: string;
	readonly topic: string;
	readonly match: ToolTopicInjectRule;
}

interface CompiledRule {
	readonly id: string;
	readonly tool: string;
	readonly topic: string;
	readonly argument: { readonly parameter: string; readonly pattern: RegExp } | undefined;
	readonly onError: boolean;
	readonly resultPattern: RegExp | undefined;
}

type Regex = (source: string) => RegExp | undefined;

function compileRule(rule: InjectionRule, regex: Regex): CompiledRule | undefined {
	const { param, pattern, onError = false, resultPattern } = rule.match;
	let argument: CompiledRule["argument"];
	if (param !== undefined && pattern !== undefined) {
		const compiled = regex(pattern);
		if (compiled === undefined) return undefined;
		argument = { parameter: param, pattern: compiled };
	} else if (param !== undefined || pattern !== undefined) {
		return undefined;
	}
	const result = resultPattern === undefined ? undefined : regex(resultPattern);
	if (resultPattern !== undefined && result === undefined) return undefined;
	if (argument === undefined && !onError && result === undefined) return undefined;
	return { id: rule.id, tool: rule.tool, topic: rule.topic, argument, onError, resultPattern: result };
}

function hubRules(tool: string, ownedTopics: ReadonlySet<string>): InjectionRule[] {
	return getToolTopicInjections().flatMap((doc) => {
		const topic = `help://${doc.tool}/${doc.topic}`;
		if (doc.tool !== tool || ownedTopics.has(topic)) return [];
		return (doc.inject ?? []).map((match, index) => ({ id: `hub/${doc.tool}/${doc.topic}/${index}`, tool: doc.tool, topic, match }));
	});
}

function stringArgument(input: Record<string, unknown>, parameter: string): string | undefined {
	let value: unknown = input;
	for (const segment of parameter.split(".")) {
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return undefined;
		value = Reflect.get(value, segment);
	}
	return typeof value === "string" ? value : undefined;
}

function matches(rule: CompiledRule, event: ToolResultEvent, resultText: () => string): boolean {
	if (event.toolName !== rule.tool || (rule.onError && !event.isError)) return false;
	if (rule.argument !== undefined) {
		const value = stringArgument(event.input, rule.argument.parameter);
		if (value === undefined || !rule.argument.pattern.test(value)) return false;
	}
	return rule.resultPattern === undefined || rule.resultPattern.test(resultText());
}

export function installToolTopicInjection(pi: ExtensionAPI, rules: readonly InjectionRule[]): void {
	const claimDeliveries = createContextDelivery(pi);
	const regexes = new Map<string, RegExp | undefined>();
	const compile = (rule: InjectionRule): CompiledRule | undefined =>
		compileRule(rule, (source) => {
			if (regexes.has(source)) return regexes.get(source);
			let compiled: RegExp | undefined;
			try {
				compiled = new RegExp(source);
			} catch (error) {
				pi.logger.warn("tool-topic-injection: invalid rule regex", { topic: rule.topic, pattern: source, error: errorText(error) });
			}
			regexes.set(source, compiled);
			return compiled;
		});
	const own = rules.flatMap((rule) => compile(rule) ?? []);
	const ownedTopics = new Set(rules.map((rule) => rule.topic));

	pi.on("tool_result", async (event, ctx) => {
		try {
			let text: string | undefined;
			const resultText = (): string => {
				text ??= textOf(event.content, "\n");
				return text;
			};
			const candidates = [...own, ...hubRules(event.toolName, ownedTopics).flatMap((rule) => compile(rule) ?? [])];
			const matched = new Map<string, CompiledRule>();
			for (const rule of candidates) {
				if (!matched.has(rule.topic) && matches(rule, event, resultText)) matched.set(rule.topic, rule);
			}
			const ready: { readonly marker: string; readonly block: string }[] = [];
			for (const rule of matched.values()) {
				try {
					const resource = await InternalUrlRouter.instance().resolve(rule.topic);
					if (typeof resource.content !== "string") throw new Error(`Topic '${rule.topic}' is binary`);
					if (!resource.content.trim()) throw new Error(`Topic '${rule.topic}' is empty`);
					const attribute = `${encodeURIComponent(OWNER)}/${encodeURIComponent(rule.id)}`;
					ready.push({
						marker: `topic="${rule.topic}">`,
						block: `<tool-topic-injection rule="${attribute}" topic="${rule.topic}">\n${resource.content}\n</tool-topic-injection>`,
					});
				} catch (error) {
					pi.logger.warn("tool-topic-injection: topic unavailable", { rule: rule.id, error: errorText(error) });
				}
			}
			// Claim only after every topic loaded: a claimed marker counts as delivered even if its block is never returned.
			const claims = claimDeliveries(
				ctx,
				ready.map((entry) => entry.marker),
			);
			const parts = ready.filter((_, index) => claims[index] === true).map((entry) => entry.block);
			if (parts.length > 0) return { additionalContext: parts.join("\n\n") };
		} catch (error) {
			pi.logger.warn("tool-topic-injection: rules unavailable", { error: errorText(error) });
		}
	});
}
