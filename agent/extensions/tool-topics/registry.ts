import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	type RegisterSchemeResult,
	registerToolTopics,
	type ToolTopicDoc,
	type ToolTopicInjectRule,
} from "../_shared/omomp-shared/internal-url.ts";
import type { Topic } from "./catalog.ts";

const OWNER = "omp-config/tool-topics";
const HUB_OWNER = "omomp-shared/tool-hub";
const OWNER_BRAND = Symbol.for("omomp-shared/internal-url");

function toHubInjectRule(rule: Topic["inject"][number]): ToolTopicInjectRule {
	return {
		...(rule.parameter !== undefined ? { param: rule.parameter } : {}),
		...(rule.patternSource !== undefined ? { pattern: rule.patternSource } : {}),
		...(rule.onError !== undefined ? { onError: rule.onError } : {}),
		...(rule.resultPatternSource !== undefined ? { resultPattern: rule.resultPatternSource } : {}),
	};
}

export function publishTopics(tools: ReadonlyMap<string, readonly Topic[]>): RegisterSchemeResult {
	const router = InternalUrlRouter.instance();
	if (router.isBuiltin("tool")) return { kind: "builtin", reason: "omp owns tool://" };
	const docs: ToolTopicDoc[] = [];
	for (const [tool, topics] of tools) {
		for (const topic of topics) {
			const inject = topic.inject.filter((rule) => rule.tool === tool).map(toHubInjectRule);
			docs.push({
				tool,
				topic: topic.name,
				title: topic.title,
				when: topic.when,
				body: topic.body,
				...(topic.hiddenFromIndex ? { hiddenFromIndex: true } : {}),
				...(inject.length > 0 ? { inject } : {}),
			});
		}
	}
	registerToolTopics(OWNER, docs);
	const active = router.getHandler("tool");
	const holder: unknown = active !== undefined ? Reflect.get(active, OWNER_BRAND) : undefined;
	if (holder === HUB_OWNER) return { kind: "registered" };
	if (typeof holder === "string") {
		return { kind: "held", holder: { kind: "owner", id: holder }, reason: `${holder} already holds tool://` };
	}
	return { kind: "held", holder: { kind: "unbranded" }, reason: "a handler with no owner already holds tool://" };
}
