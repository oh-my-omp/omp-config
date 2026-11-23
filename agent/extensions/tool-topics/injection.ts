import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter, type ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { parseHelpUrl } from "@oh-my-pi/pi-coding-agent/tools/doc-topics";
import { createContextDelivery } from "../_shared/context-delivery.ts";
import { errorText } from "../_shared/errors.ts";
import { textOf } from "../_shared/messages.ts";
import {
	getToolTopicInjections,
	listToolTopics,
	resolveToolTopic,
	type ToolTopicInjectRule,
} from "../_shared/omomp-shared/internal-url.ts";

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

type TopicResolution = { readonly kind: "ok"; readonly content: string } | { readonly kind: "unavailable"; readonly reason: string };

type ToolSessionRef = NonNullable<ResolveContext["session"]>;

function isToolSession(candidate: unknown): candidate is ToolSessionRef {
	return typeof candidate === "object" && candidate !== null && typeof Reflect.get(candidate, "getToolByName") === "function";
}

function readOptionalString(target: object, method: string): string | undefined {
	const fn: unknown = Reflect.get(target, method);
	if (typeof fn !== "function") return undefined;
	const value: unknown = fn.call(target);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findToolSession(ctx: ExtensionContext): ToolSessionRef | undefined {
	const registry = AgentRegistry.global();
	const sessionId = readOptionalString(ctx.sessionManager, "getSessionId");
	if (sessionId !== undefined) {
		for (const ref of registry.list()) {
			if (ref.session && ref.session.sessionManager.getSessionId() === sessionId && isToolSession(ref.session)) {
				return ref.session;
			}
		}
	}
	const agentId = ctx.agent?.id;
	if (agentId) {
		const ref = registry.get(agentId);
		if (ref?.session && isToolSession(ref.session)) return ref.session;
	}
	return undefined;
}

function buildResolveContext(ctx: ExtensionContext): ResolveContext {
	const session = findToolSession(ctx);
	const sessionId = readOptionalString(ctx.sessionManager, "getSessionId");
	const sessionFile = readOptionalString(ctx.sessionManager, "getSessionFile");
	return {
		cwd: ctx.cwd,
		...(sessionId !== undefined ? { sessionId } : {}),
		...(sessionFile !== undefined ? { sessionFile } : {}),
		...(ctx.localProtocolOptions !== undefined ? { localProtocolOptions: ctx.localProtocolOptions } : {}),
		...(session !== undefined ? { session } : {}),
	};
}

async function resolveTopic(topic: string, ctx: ExtensionContext): Promise<TopicResolution> {
	const help = parseHelpUrl(topic);
	if (help?.tool && help.topic) {
		const hub = resolveToolTopic(help.tool, help.topic);
		if (hub !== undefined) {
			return hub.content.trim() ? { kind: "ok", content: hub.content } : { kind: "unavailable", reason: `Topic '${topic}' is empty` };
		}
	}
	const resolveContext = buildResolveContext(ctx);
	// Do not fall through to native HelpProtocolHandler without a tool session; it throws when context.session is absent.
	if (help !== null && resolveContext.session === undefined) {
		const needsSession = help.tool !== null && (help.topic !== null || listToolTopics(help.tool, { includeHidden: true }).length === 0);
		if (needsSession) return { kind: "unavailable", reason: `Topic '${topic}' requires a tool session` };
	}
	try {
		const resource = await InternalUrlRouter.instance().resolve(topic, resolveContext);
		if (typeof resource.content !== "string") return { kind: "unavailable", reason: `Topic '${topic}' is binary` };
		if (!resource.content.trim()) return { kind: "unavailable", reason: `Topic '${topic}' is empty` };
		return { kind: "ok", content: resource.content };
	} catch (error) {
		return { kind: "unavailable", reason: errorText(error) };
	}
}

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
				const resolved = await resolveTopic(rule.topic, ctx);
				switch (resolved.kind) {
					case "ok": {
						const attribute = `${encodeURIComponent(OWNER)}/${encodeURIComponent(rule.id)}`;
						ready.push({
							marker: `topic="${rule.topic}">`,
							block: `<tool-topic-injection rule="${attribute}" topic="${rule.topic}">\n${resolved.content}\n</tool-topic-injection>`,
						});
						break;
					}
					case "unavailable":
						pi.logger.warn("tool-topic-injection: topic unavailable", {
							rule: rule.id,
							topic: rule.topic,
							error: resolved.reason,
						});
						break;
					default: {
						const unreachable: never = resolved;
						return unreachable;
					}
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
