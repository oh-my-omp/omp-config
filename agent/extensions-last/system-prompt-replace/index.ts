// ============================================================================
// system-prompt-replace — text replacement over the final system prompt.
//
// WHY THIS EXISTS. SYSTEM_TEMPLATE.md owns the base workflow. Whole tool
// descriptions are rewritten by the tool-topics extension (surface + topic
// index, keyed by tool name); this extension makes the remaining wording-level
// edits over the final prompt — template lines, and sentences inside tool
// descriptions that keep their native text — instead of repeating them in the
// base template or APPEND_SYSTEM.md.
//
// ORDER. `before_agent_start` handlers run one extension after another in
// load order, each receiving the prompt the previous one returned. Load order
// is: native discovery (`<agent dir>/extensions/`, settings.json `extensions`),
// then hooks, then plugin extensions, then CLI `-e` paths, then config.yml
// `extensions` in list order, then OMP's inline factories (SDK-supplied
// extensions, autoresearch, the custom-tools wrapper). This file therefore
// lives outside `<agent dir>/extensions/` and is registered as the LAST
// config.yml `extensions` entry, so it sees every path-loaded extension's
// additions. Inline factories still run after it; autoresearch rewrites the
// prompt only in autoresearch mode. Placing this file in `extensions/` would
// load it with the native batch, and the config entry would be dropped as a
// duplicate path.
//
// FILE. The `system-prompt-replace` section of omomp.* in the agent directory
// (profile-aware); a project's `.omp/omomp.*` is not read here:
//
//   system-prompt-replace:
//     replacements:
//       - literal: "exact text"
//         replace: "new text"
//       - regex: "JS regex source"
//         replace: "new text, $1 allowed"
//
// Each rule sets exactly one of `literal` / `regex`, plus `replace`. A literal
// replaces every occurrence verbatim (no `$` handling). A regex is compiled
// with the `g` flag and uses String.prototype.replace substitution patterns.
// Optional `scope: sub` applies a rule only in subagent sessions (text only
// subagent prompts carry); the default `all` applies everywhere. Rules apply
// in file order, each to the output of the previous one, across every
// system-prompt block.
//
// TIMING. Every `before_agent_start`, in the main session and in every
// subagent. The file is re-read per prompt, so edits apply from the next
// prompt without restart.
//
// FAILURE POLICY. A missing file means no replacement. A malformed file
// degrades to no replacement plus a log warning, repeated only when the error
// changes or a valid read intervened. A rule
// whose target is absent from the main session's system prompt (template drift
// after an OMP upgrade, or a typo) raises a visible warning — UI notification,
// or stderr when headless — plus a log warning, once per rule per process.
// Subagents are not checked: their prompts legitimately lack text such as the
// `task` tool description. The prompt is never blocked.
// ============================================================================

import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../../extensions/_shared/errors.ts";
import { tr } from "../../extensions/_shared/i18n.ts";
import { defineOmompSection, loadOmompSection } from "../../extensions/_shared/omomp.ts";

// Keep validation sequential so the first failure retains the original reason.
const objectSchema = z.record(z.string(), z.unknown()).refine((value) => !Array.isArray(value));
const replacementsSchema = z.array(z.unknown());
const replacementSchema = z.string();
const matcherSchema = z.string().min(1);
const scopeSchema = z.enum(["all", "sub"]);
const omompSection = defineOmompSection(import.meta.dir, z.object({ replacements: replacementsSchema }).strict());

type Matcher = { readonly kind: "literal"; readonly text: string } | { readonly kind: "regex"; readonly pattern: RegExp };

/** `all`: every session; `sub`: subagent sessions only, for text only subagent prompts carry. */
type Scope = "all" | "sub";

interface Rule {
	readonly label: string;
	readonly matcher: Matcher;
	readonly replace: string;
	readonly scope: Scope;
}

type Parsed = { readonly kind: "ok"; readonly rules: readonly Rule[] } | { readonly kind: "invalid"; readonly reason: string };

type RuleParse = { readonly kind: "ok"; readonly rule: Rule } | { readonly kind: "invalid"; readonly reason: string };

/** Rules already reported as missing their target, shared by every session in this process. */
const reportedMisses = new Set<string>();

function parseRule(value: unknown, index: number): RuleParse {
	const at = `replacements[${index}]`;
	const object = objectSchema.safeParse(value);
	if (!object.success) {
		return { kind: "invalid", reason: `${at} is not an object` };
	}
	const record = object.data;
	const unknownKey = Object.keys(record).find((key) => key !== "literal" && key !== "regex" && key !== "replace" && key !== "scope");
	if (unknownKey !== undefined) return { kind: "invalid", reason: `${at}: unknown key \`${unknownKey}\`` };
	const replacement = replacementSchema.safeParse(record.replace);
	if (!replacement.success) return { kind: "invalid", reason: `${at}: \`replace\` must be a string` };
	const scoped = scopeSchema.safeParse(record.scope ?? "all");
	if (!scoped.success) return { kind: "invalid", reason: `${at}: \`scope\` must be "all" or "sub"` };
	const scope = scoped.data;
	const { literal, regex } = record;
	if ((literal === undefined) === (regex === undefined)) {
		return { kind: "invalid", reason: `${at}: set exactly one of \`literal\` and \`regex\`` };
	}
	if (literal !== undefined) {
		const text = matcherSchema.safeParse(literal);
		if (!text.success) {
			return { kind: "invalid", reason: `${at}: \`literal\` must be a non-empty string` };
		}
		return {
			kind: "ok",
			rule: {
				label: `${at} literal ${JSON.stringify(text.data)}`,
				matcher: { kind: "literal", text: text.data },
				replace: replacement.data,
				scope,
			},
		};
	}
	const expression = matcherSchema.safeParse(regex);
	if (!expression.success) {
		return { kind: "invalid", reason: `${at}: \`regex\` must be a non-empty string` };
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(expression.data, "g");
	} catch (error) {
		return { kind: "invalid", reason: `${at}: invalid regex: ${errorText(error)}` };
	}
	return {
		kind: "ok",
		rule: { label: `${at} regex /${expression.data}/`, matcher: { kind: "regex", pattern }, replace: replacement.data, scope },
	};
}

/** Rules are validated one by one so the first failure keeps its own reason. */
function parseRules(replacements: readonly unknown[]): Parsed {
	const rules: Rule[] = [];
	for (const [index, value] of replacements.entries()) {
		const parsed = parseRule(value, index);
		if (parsed.kind === "invalid") return parsed;
		rules.push(parsed.rule);
	}
	return { kind: "ok", rules };
}

export default function systemPromptReplace(pi: ExtensionAPI): void {
	/** Last invalid-section reason already logged, so a broken section warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const loaded = loadOmompSection(omompSection, null);
			if (loaded.kind === "none") {
				const [problem] = loaded.skipped;
				if (problem === undefined) return;
				const reason = `${problem.path}: ${problem.reason}`;
				if (warnedReason !== reason) {
					warnedReason = reason;
					pi.logger.warn(`system-prompt-replace: ${reason}; not replacing`);
				}
				return;
			}
			const parsed = parseRules(loaded.value.replacements);
			if (parsed.kind === "invalid") {
				if (warnedReason !== parsed.reason) {
					warnedReason = parsed.reason;
					pi.logger.warn(`system-prompt-replace: ${loaded.path}: ${parsed.reason}; not replacing`);
				}
				return;
			}
			warnedReason = null;
			const sourcePath = loaded.path;

			let blocks = event.systemPrompt;
			let changed = false;
			for (const rule of parsed.rules) {
				if (rule.scope === "sub" && ctx.agent.kind === "main") continue;
				let hits = 0;
				const matcher = rule.matcher;
				blocks = blocks.map((block) => {
					switch (matcher.kind) {
						case "literal": {
							const pieces = block.split(matcher.text);
							hits += pieces.length - 1;
							return pieces.join(rule.replace);
						}
						case "regex": {
							const count = block.match(matcher.pattern)?.length ?? 0;
							hits += count;
							return count === 0 ? block : block.replace(matcher.pattern, rule.replace);
						}
						default: {
							const unreachable: never = matcher;
							return unreachable;
						}
					}
				});
				if (hits > 0) {
					changed = true;
				} else if (ctx.agent.kind === "main" && !reportedMisses.has(rule.label)) {
					reportedMisses.add(rule.label);
					const logNotice = `system-prompt-replace: ${rule.label} found no target in the system prompt; update ${sourcePath}`;
					const notice = tr(
						`system-prompt-replace: ${rule.label} found no target in the system prompt; update ${sourcePath}`,
						`system-prompt-replace：系统提示词中未找到 ${rule.label} 的目标；请更新 ${sourcePath}`,
					);
					pi.logger.warn(logNotice);
					if (ctx.hasUI) ctx.ui.notify(notice, "warning");
					else process.stderr.write(`${notice}\n`);
				}
			}
			if (!changed) return;
			return { systemPrompt: blocks };
		} catch (error) {
			pi.logger.warn("system-prompt-replace: before_agent_start failed", { error: errorText(error) });
		}
	});
}
