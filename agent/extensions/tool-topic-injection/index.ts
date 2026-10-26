// tool-topic-injection — configuration adapter for progressive tool topic prompts.
// Installs the shared tool_result/turn_start hooks in main and sub sessions.
// Reads omomp.yml#tool-topic-injection per result (project before agent dir), so
// rule edits apply on the next call. No section means off; no built-in rules.
// No commands/tools/files. Invalid copies warn once per changed problem and are
// skipped by the shared config loader; hook failures warn without blocking tools.
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import { installToolTopicInjection, toolTopicInjectionRulesSchema } from "../_shared/tool-topic-injection.ts";

const section = defineOmompSection(import.meta.dir, z.object({ rules: toolTopicInjectionRulesSchema }).strict());

export default function toolTopicInjection(pi: ExtensionAPI): void {
	let warnedReason: string | undefined;
	installToolTopicInjection(pi, {
		owner: "omp-config/tool-topic-injection",
		rules(ctx) {
			const loaded = loadOmompSection(section, ctx.cwd);
			const reason = loaded.skipped.map((problem) => `${problem.path}: ${problem.reason}`).join("; ");
			if (reason && reason !== warnedReason) pi.logger.warn("tool-topic-injection: skipped invalid configuration", { reason });
			warnedReason = reason || undefined;
			return loaded.kind === "found" ? loaded.value.rules : [];
		},
	});
}
