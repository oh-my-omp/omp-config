import { readFileSync } from "node:fs";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgCompactionModelThresholds } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { planModelCompactionPoint } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { callerSession } from "../_shared/caller-session.ts";
import { errorText } from "../_shared/errors.ts";
import { tr } from "../_shared/i18n.ts";
import { discoverSpecFiles, parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { layerRuleFiles } from "./rule-files.ts";

type MatchField = "provider" | "model";

interface Constraint {
	readonly field: MatchField;
	readonly pattern: RegExp;
}

interface Rule {
	readonly file: string;
	readonly constraints: readonly [Constraint, ...Constraint[]];
	readonly thresholdTokens: number;
}

interface LoadedRules {
	readonly rules: readonly Rule[];
	readonly problems: readonly string[];
}

type ThresholdEntry = number | string | null;
type ThresholdRecord = Readonly<Record<string, ThresholdEntry>>;

type Baseline = { readonly kind: "absent" } | { readonly kind: "present"; readonly value: ThresholdRecord };
type RuntimeRecord = Baseline | { readonly kind: "unreadable" };

type Ownership =
	| { readonly kind: "idle" }
	| { readonly kind: "owned"; readonly baseline: Baseline; readonly written: ThresholdRecord }
	| { readonly kind: "yielded" };

interface Expansion {
	readonly entries: ThresholdRecord;
	readonly refusals: readonly string[];
}

type RuleParse = { readonly kind: "ok"; readonly rule: Rule } | { readonly kind: "invalid"; readonly reason: string };

const FILE_PATTERN = /^COMPACTION-.+\.md$/i;
const KNOWN_KEYS: Readonly<Record<string, true>> = { provider: true, model: true, thresholdtokens: true };

function compile(pattern: string): RegExp | null {
	if (pattern === "") return null;
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

function parseRuleFile(file: string): RuleParse {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `unreadable: ${errorText(error)}` };
	}
	const parsed = parseFrontmatter(raw);
	if (parsed === null) return { kind: "invalid", reason: "missing frontmatter" };
	const { fields, body } = parsed;
	const unknown = Object.keys(fields).find((key) => !Object.hasOwn(KNOWN_KEYS, key));
	if (unknown !== undefined) return { kind: "invalid", reason: `unknown key ${unknown}` };
	if (body.trim() !== "") return { kind: "invalid", reason: "body must be empty" };
	const constraints: Constraint[] = [];
	for (const field of ["provider", "model"] as const) {
		const value = fields[field];
		if (value === undefined) continue;
		const pattern = compile(unquote(value));
		if (pattern === null) return { kind: "invalid", reason: `${field} is not a valid regex` };
		constraints.push({ field, pattern });
	}
	const [first, ...rest] = constraints;
	if (first === undefined) return { kind: "invalid", reason: "sets neither `model` nor `provider`" };
	const threshold = fields.thresholdtokens;
	if (threshold === undefined) return { kind: "invalid", reason: "missing thresholdTokens" };
	const thresholdTokens = Number(unquote(threshold));
	if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0)
		return { kind: "invalid", reason: "thresholdTokens is not a positive integer token count" };
	return { kind: "ok", rule: { file, constraints: [first, ...rest], thresholdTokens } };
}

function loadRules(cwd: string): LoadedRules {
	const files = layerRuleFiles(discoverSpecFiles(FILE_PATTERN, import.meta.dir, cwd), import.meta.dir);
	const rules: Rule[] = [];
	const problems: string[] = [];
	for (const file of files) {
		const parsed = parseRuleFile(file);
		switch (parsed.kind) {
			case "ok":
				rules.push(parsed.rule);
				break;
			case "invalid":
				problems.push(`${file}: ${parsed.reason}`);
				break;
			default: {
				const unreachable: never = parsed;
				throw new Error(`unexpected rule parse ${JSON.stringify(unreachable)}`);
			}
		}
	}
	return { rules, problems };
}

function refusal(ctx: ExtensionContext, settings: Settings, model: Model, thresholdTokens: number): string | null {
	const tiers = ctx.modelRegistry.contextWindowTiers(model);
	const plan = planModelCompactionPoint(settings, model, `f${thresholdTokens}`, tiers);
	if (plan === undefined)
		return `does not fit below its ${tiers?.extended ?? model.contextWindow}-token largest window; use a smaller value`;
	if (tiers === undefined || (model.contextWindow !== tiers.standard && model.contextWindow !== tiers.extended)) return null;
	if (plan.window === model.contextWindow) return null;
	return plan.window === tiers.extended
		? `would switch it from its ${tiers.standard}-token standard window to its ${tiers.extended}-token extended window; use a value below ${tiers.standard}`
		: `would switch it from its ${tiers.extended}-token extended window back to its ${tiers.standard}-token standard window; use a value of at least ${tiers.standard}`;
}

function expand(ctx: ExtensionContext, settings: Settings, rules: readonly Rule[]): Expansion {
	const entries: Record<string, ThresholdEntry> = {};
	const refusals: string[] = [];
	for (const model of ctx.models.list()) {
		const values: Record<MatchField, string> = { provider: model.provider, model: model.id };
		const rule = rules.find((candidate) => candidate.constraints.every((c) => c.pattern.test(values[c.field])));
		if (rule === undefined) continue;
		const key = `${model.provider}/${model.id}`;
		const refused = refusal(ctx, settings, model, rule.thresholdTokens);
		if (refused === null) entries[key] = `f${rule.thresholdTokens}`;
		else refusals.push(`${rule.file} (thresholdTokens ${rule.thresholdTokens}) not applied to ${key}: it ${refused}`);
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

function compose(baseline: Baseline, entries: ThresholdRecord): ThresholdRecord {
	switch (baseline.kind) {
		case "absent":
			return entries;
		case "present":
			return { ...baseline.value, ...entries };
		default: {
			const unreachable: never = baseline;
			throw new Error(`unexpected baseline ${JSON.stringify(unreachable)}`);
		}
	}
}

function restore(settings: Settings, baseline: Baseline): void {
	switch (baseline.kind) {
		case "absent":
			cfgCompactionModelThresholds.clearOverride(settings);
			return;
		case "present":
			cfgCompactionModelThresholds.override(settings, baseline.value);
			return;
		default: {
			const unreachable: never = baseline;
			throw new Error(`unexpected baseline ${JSON.stringify(unreachable)}`);
		}
	}
}

function sessionSettings(ctx: ExtensionContext): Settings {
	const session = callerSession(ctx);
	if (session === undefined) throw new Error("current OMP session is not registered");
	return session.settings;
}

export default function modelCompaction(pi: ExtensionAPI): void {
	let ownership: Ownership = { kind: "idle" };
	let warned: string | null = null;

	const warn = (ctx: ExtensionContext, en: string | null, zh: string): void => {
		if (en === warned) return;
		warned = en;
		if (en === null) return;
		pi.logger.warn(en);
		if (ctx.hasUI) ctx.ui.notify(tr(en, zh), "warning");
	};

	const report = (ctx: ExtensionContext, problems: readonly string[]): void =>
		warn(ctx, problems.length === 0 ? null : `model-compaction: ${problems.join("; ")}`, `模型压缩：${problems.join("；")}`);

	const yieldOwnership = (ctx: ExtensionContext, en: string, zh: string): void => {
		ownership = { kind: "yielded" };
		warn(ctx, `model-compaction: ${en}`, `模型压缩：${zh}`);
	};

	const stillOwned = (ctx: ExtensionContext, settings: Settings, written: ThresholdRecord): boolean => {
		const current = ownRuntimeRecord(settings);
		if (current.kind === "present" && Bun.deepEquals(current.value, written, true)) return true;
		yieldOwnership(
			ctx,
			"the runtime compaction.modelThresholds record was changed by another writer; no longer managing it in this session",
			"运行时的 compaction.modelThresholds 记录已被其他写入方修改；本会话将不再管理该记录",
		);
		return false;
	};

	const write = (settings: Settings, baseline: Baseline, entries: ThresholdRecord): void => {
		const written = compose(baseline, entries);
		if (ownership.kind === "owned" && Bun.deepEquals(written, ownership.written, true)) return;
		cfgCompactionModelThresholds.override(settings, written);
		ownership = { kind: "owned", baseline, written };
		pi.logger.info("model-compaction: thresholds applied", { entries });
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
					yieldOwnership(
						ctx,
						"the runtime compaction.modelThresholds record is not a threshold map; leaving it untouched in this session",
						"运行时的 compaction.modelThresholds 记录不是阈值表；本会话不改动它",
					);
					return;
				}
				write(settings, baseline, entries);
				return;
			}
			case "owned": {
				if (!stillOwned(ctx, settings, ownership.written)) return;
				if (empty) {
					restore(settings, ownership.baseline);
					ownership = { kind: "idle" };
					return;
				}
				write(settings, ownership.baseline, entries);
				return;
			}
			default: {
				const unreachable: never = ownership;
				throw new Error(`unexpected ownership ${JSON.stringify(unreachable)}`);
			}
		}
	};

	const sync = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main" || ownership.kind === "yielded") return;
		try {
			const settings = sessionSettings(ctx);
			const loaded = loadRules(ctx.cwd);
			const expansion = expand(ctx, settings, loaded.rules);
			report(ctx, [...loaded.problems, ...expansion.refusals]);
			apply(ctx, settings, expansion.entries);
		} catch (error) {
			pi.logger.warn("model-compaction: cannot apply compaction thresholds", { error: errorText(error) });
		}
	};

	pi.on("session_start", (_event, ctx) => sync(ctx));
	pi.on("session_switch", (_event, ctx) => sync(ctx));
	pi.on("before_agent_start", (_event, ctx) => sync(ctx));

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
