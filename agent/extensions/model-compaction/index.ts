// ============================================================================
// model-compaction — auto-compaction trigger per model, chosen by regex.
//
// WHY THIS EXISTS. OMP's native `compaction.modelThresholds` keys are exact
// `provider/model-id` selectors or `*`-terminated prefixes, so one family of
// models spread over several providers or id spellings needs one entry each.
// This extension lets ordered regex rules choose a fixed compaction trigger and
// hands the result to the native map; OMP itself still decides and compacts.
//
// FILE. The `model-compaction` section of omomp.* in the agent directory (machine-
// local; no project copy is read):
//
//   model-compaction:
//     rules:
//       - { provider: "^anthropic$", model: "opus", thresholdTokens: 150000 }
//       - { model: "(gpt-5|o3)", thresholdTokens: 120000 }
//       - { model: ".*", thresholdTokens: 90000 }
//
// Rule keys (`model` and/or `provider` required):
//   provider        JavaScript regex tested against the model's provider id (`anthropic`).
//   model           JavaScript regex tested against the model id (`claude-opus-5-5`).
//   thresholdTokens Positive integer: the context size, in tokens, at which
//                   auto-compaction triggers for a matched model.
// Patterns are unanchored (`RegExp.test`, no flags); write `^`/`$` to anchor and
// `.*` to match every model. A rule matches when every pattern it sets matches;
// for each model the first matching rule in file order wins. Unknown keys are
// errors, so a misspelled key cannot widen a rule.
//
// EFFECT. Every model in `ctx.models.list()` that a rule matches gets the exact
// native entry `"provider/id": "f<thresholdTokens>"` (the native fixed-trigger
// form) in the main session's runtime settings layer — never written to any
// config file. Native resolution then applies it per model at every compaction
// decision, so model switches, retry fallbacks and subagents (whose settings
// read through the main session's live) each get their own model's trigger.
// Models no rule matches get no entry and keep the native policy, including
// the user's own `compaction.modelThresholds` entries; an exact entry generated
// here outranks a native entry for the same model. A subagent whose
// `task.agentCompactionThresholdOverrides` entry applies runs with model entries
// off natively, so that override still wins. Native capping still applies: a
// trigger at or past a model's window compacts at the window minus its reserve.
//
// CONTEXT WINDOW. A native fixed entry at or past a model's standard window opts
// that model into its extended window. A rule that would change the window
// tier a model currently runs with is refused for that model with a warning;
// this extension never changes a context window.
//
// TIMING. Main session `before_agent_start`: the file is re-read every prompt,
// so edits apply from the next main prompt (subagents follow the main session's
// latest write). Subagent sessions write nothing.
//
// OWNERSHIP. The extension writes the runtime layer of
// `compaction.modelThresholds` only. Before its first write it keeps the
// runtime record already there; it writes that record plus its own entries and
// restores it when no entry remains (no file, invalid file, no match) and on
// `session_shutdown`. When it finds the runtime record changed by another
// writer, it warns once and stops managing it for the session.
//
// FAILURE POLICY. A missing file means no rules, silently. An unreadable or
// invalid file means no rules for that prompt (the whole file is rejected) plus
// a warning; warnings repeat only when they change or a clean read intervened.
// Warnings go to the log and, with a UI, a notification. The prompt is never
// blocked.
// ============================================================================

import type { Model } from "@oh-my-pi/pi-ai";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, type Settings, z } from "@oh-my-pi/pi-coding-agent";
import { cfgCompactionModelThresholds, cfgExtendedContext } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";

type MatchField = "provider" | "model";

interface Constraint {
	readonly field: MatchField;
	readonly pattern: RegExp;
}

interface Rule {
	readonly constraints: readonly [Constraint, ...Constraint[]];
	readonly thresholdTokens: number;
}

type Rules = { readonly kind: "rules"; readonly rules: readonly Rule[] } | { readonly kind: "invalid"; readonly reason: string };

/** Native `compaction.modelThresholds` entry values: token base, `"f<N>"`/`"<P>%"` string, or `null` (clears an inherited entry). */
type ThresholdEntry = number | string | null;
type ThresholdRecord = Readonly<Record<string, ThresholdEntry>>;

/** The session's own runtime-layer record of `compaction.modelThresholds`. */
type RuntimeRecord =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly value: ThresholdRecord }
	| { readonly kind: "unreadable" };

/** What this extension holds in the main session's runtime layer. */
type Ownership =
	| { readonly kind: "idle" }
	| { readonly kind: "owned"; readonly baseline: Exclude<RuntimeRecord, { kind: "unreadable" }>; readonly written: ThresholdRecord }
	| { readonly kind: "yielded" };

interface Expansion {
	readonly entries: ThresholdRecord;
	readonly refusals: readonly string[];
}

function compiles(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		// An invalid pattern is the expected failure being tested for.
		return false;
	}
}

const patternSchema = z
	.string()
	.refine((value) => value.trim() !== "", "a non-empty regex")
	.refine(compiles, "a valid JavaScript regex");
const ruleSchema = z
	.object({
		provider: patternSchema.optional(),
		model: patternSchema.optional(),
		thresholdTokens: z.number().refine((value) => Number.isSafeInteger(value) && value > 0, "a positive integer token count"),
	})
	.strict()
	.refine((rule) => rule.provider !== undefined || rule.model !== undefined, "a rule that sets `model` and/or `provider`");
const configSchema = z.object({ rules: z.array(ruleSchema) }).strict();
const omompSection = defineOmompSection(import.meta.dir, configSchema);

function toRule(rule: z.infer<typeof ruleSchema>): Rule {
	const [first, ...rest] = (["provider", "model"] as const).flatMap((field): Constraint[] => {
		const pattern = rule[field];
		return pattern === undefined ? [] : [{ field, pattern: new RegExp(pattern) }];
	});
	if (first === undefined) throw new Error("model-compaction: schema admitted a rule without `model` or `provider`");
	return { constraints: [first, ...rest], thresholdTokens: rule.thresholdTokens };
}

function loadRules(): Rules {
	const loaded = loadOmompSection(omompSection, null);
	switch (loaded.kind) {
		case "found":
			return { kind: "rules", rules: loaded.value.rules.map(toRule) };
		case "none": {
			const [problem] = loaded.skipped;
			return problem === undefined ? { kind: "rules", rules: [] } : { kind: "invalid", reason: `${problem.path}: ${problem.reason}` };
		}
		default: {
			const unreachable: never = loaded;
			return unreachable;
		}
	}
}

/**
 * Why `thresholdTokens` as a native fixed entry would move `model` to another
 * window tier, or null when it keeps the tier the model runs with now.
 */
function tierChange(ctx: ExtensionContext, settings: Settings, model: Model, thresholdTokens: number): string | null {
	const tiers = ctx.modelRegistry.contextWindowTiers(model);
	// No larger tier, or a window pinned by an explicit override: no entry can move it.
	if (tiers === undefined || (model.contextWindow !== tiers.standard && model.contextWindow !== tiers.extended)) return null;
	const extendedNow = model.contextWindow === tiers.extended;
	const extendedWith = cfgExtendedContext.get(settings) || thresholdTokens >= tiers.standard;
	if (extendedNow === extendedWith) return null;
	return extendedWith
		? `would switch it from its ${tiers.standard}-token standard window to its ${tiers.extended}-token extended window; use a value below ${tiers.standard}`
		: `would switch it from its ${tiers.extended}-token extended window back to its ${tiers.standard}-token standard window; use a value of at least ${tiers.standard}`;
}

function expand(ctx: ExtensionContext, settings: Settings, rules: readonly Rule[]): Expansion {
	const entries: Record<string, ThresholdEntry> = {};
	const refusals: string[] = [];
	for (const model of ctx.models.list()) {
		const values: Record<MatchField, string> = { provider: model.provider, model: model.id };
		const index = rules.findIndex((rule) => rule.constraints.every((c) => c.pattern.test(values[c.field])));
		const rule = rules[index];
		if (rule === undefined) continue;
		const key = `${model.provider}/${model.id}`;
		const change = tierChange(ctx, settings, model, rule.thresholdTokens);
		if (change === null) entries[key] = `f${rule.thresholdTokens}`;
		else refusals.push(`rules[${index}] (thresholdTokens ${rule.thresholdTokens}) not applied to ${key}: it ${change}`);
	}
	return { entries, refusals };
}

function isThresholdEntry(value: unknown): value is ThresholdEntry {
	return value === null || typeof value === "number" || typeof value === "string";
}

function ownRuntimeRecord(settings: Settings): RuntimeRecord {
	const compaction = settings.overlayLayers().overrides.compaction;
	if (compaction === undefined) return { kind: "absent" };
	if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) return { kind: "unreadable" };
	if (!("modelThresholds" in compaction) || compaction.modelThresholds === undefined) return { kind: "absent" };
	const record = compaction.modelThresholds;
	if (typeof record !== "object" || record === null || Array.isArray(record)) return { kind: "unreadable" };
	const value: Record<string, ThresholdEntry> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (!isThresholdEntry(entry)) return { kind: "unreadable" };
		value[key] = entry;
	}
	return { kind: "present", value };
}

function restore(settings: Settings, baseline: Extract<Ownership, { kind: "owned" }>["baseline"]): void {
	switch (baseline.kind) {
		case "absent":
			cfgCompactionModelThresholds.clearOverride(settings);
			return;
		case "present":
			cfgCompactionModelThresholds.override(settings, baseline.value);
			return;
		default: {
			const unreachable: never = baseline;
			throw new Error(`unexpected runtime record ${JSON.stringify(unreachable)}`);
		}
	}
}

function sessionSettings(ctx: ExtensionContext): Settings {
	const session = AgentRegistry.global()
		.list()
		.find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
	if (session == null) throw new Error("current OMP session is not registered");
	return session.settings;
}

export default function modelCompaction(pi: ExtensionAPI): void {
	let ownership: Ownership = { kind: "idle" };
	/** Last warning set already reported, so an unchanged problem warns once. */
	let warned: string | null = null;

	const report = (ctx: ExtensionContext, problems: readonly string[]): void => {
		const text = problems.length === 0 ? null : `model-compaction: ${problems.join("; ")}`;
		if (text === warned) return;
		warned = text;
		if (text === null) return;
		pi.logger.warn(text);
		if (ctx.hasUI) ctx.ui.notify(tr(text, `模型压缩：${problems.join("；")}`), "warning");
	};

	/** Still ours: the runtime record is exactly what this extension last wrote. */
	const stillOwned = (ctx: ExtensionContext, settings: Settings, written: ThresholdRecord): boolean => {
		const current = ownRuntimeRecord(settings);
		if (current.kind === "present" && Bun.deepEquals(current.value, written, true)) return true;
		ownership = { kind: "yielded" };
		const text =
			"model-compaction: the runtime compaction.modelThresholds record was changed by another writer; no longer managing it in this session";
		pi.logger.warn(text);
		if (ctx.hasUI)
			ctx.ui.notify(tr(text, "模型压缩：运行时的 compaction.modelThresholds 记录已被其他写入方修改；本会话将不再管理该记录"), "warning");
		return false;
	};

	const apply = (ctx: ExtensionContext, settings: Settings, entries: ThresholdRecord): void => {
		const empty = Object.keys(entries).length === 0;
		switch (ownership.kind) {
			case "yielded":
				return;
			case "idle": {
				if (empty) return;
				const baseline = ownRuntimeRecord(settings);
				if (baseline.kind === "unreadable") {
					ownership = { kind: "yielded" };
					report(ctx, ["the runtime compaction.modelThresholds record is not a threshold map; leaving it untouched in this session"]);
					return;
				}
				const written = { ...(baseline.kind === "present" ? baseline.value : {}), ...entries };
				cfgCompactionModelThresholds.override(settings, written);
				ownership = { kind: "owned", baseline, written };
				return;
			}
			case "owned": {
				if (!stillOwned(ctx, settings, ownership.written)) return;
				if (empty) {
					restore(settings, ownership.baseline);
					ownership = { kind: "idle" };
					return;
				}
				const written = { ...(ownership.baseline.kind === "present" ? ownership.baseline.value : {}), ...entries };
				if (Bun.deepEquals(written, ownership.written, true)) return;
				cfgCompactionModelThresholds.override(settings, written);
				ownership = { kind: "owned", baseline: ownership.baseline, written };
				return;
			}
			default: {
				const unreachable: never = ownership;
				throw new Error(`unexpected ownership ${JSON.stringify(unreachable)}`);
			}
		}
	};

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		try {
			const settings = sessionSettings(ctx);
			const rules = loadRules();
			switch (rules.kind) {
				case "invalid":
					report(ctx, [`${rules.reason}; no rules applied`]);
					apply(ctx, settings, {});
					return;
				case "rules": {
					const expansion = expand(ctx, settings, rules.rules);
					report(ctx, expansion.refusals);
					apply(ctx, settings, expansion.entries);
					return;
				}
				default: {
					const unreachable: never = rules;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("model-compaction: cannot apply compaction thresholds", { error: errorText(error) });
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ownership.kind !== "owned") return;
		try {
			const settings = sessionSettings(ctx);
			if (!stillOwned(ctx, settings, ownership.written)) return;
			restore(settings, ownership.baseline);
			ownership = { kind: "idle" };
		} catch (error) {
			pi.logger.warn("model-compaction: cannot restore compaction thresholds", { error: errorText(error) });
		}
	});
}
