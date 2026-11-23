import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { parseFrontmatter, unquote } from "../_shared/spec-files.ts";
import { atomicWrite, isAppManaged } from "./files.ts";
import type { Mapping } from "./merge.ts";
import { compactionRule, compactionRulesText } from "./omomp-migration.ts";
import { EXCLUDED_REASON, type Exclusions, plainRelExcluded, targetOf } from "./paths.ts";
import type { ApplyOptions, ApplyReport } from "./report.ts";

const MD_PATTERN = /^COMPACTION-.+\.md$/i;
export const RULES_FILE = "model-compaction.json";
const MACHINE_DIR_REL = "agent/extensions/model-compaction";

export type CompactionRulesPlan =
	| { readonly kind: "none" }
	| { readonly kind: "kept"; readonly reason: string }
	| { readonly kind: "ready"; readonly target: string; readonly content: string; readonly sources: readonly string[] };

export type CompactionRulesResult = { readonly written: readonly string[]; readonly deleted: readonly string[] };

function mdRule(path: string): Mapping | string {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return `${path}: ${errorText(error)}`;
	}
	const parsed = parseFrontmatter(raw);
	if (parsed === null) return `${path}: missing frontmatter`;
	if (parsed.body.trim() !== "") return `${path}: body must be empty`;
	const names: Readonly<Record<string, string>> = { provider: "provider", model: "model", thresholdtokens: "thresholdTokens" };
	const rule: Mapping = {};
	for (const [key, value] of Object.entries(parsed.fields)) {
		const name = names[key];
		if (name === undefined) return `${path}: unknown key ${key}`;
		const text = unquote(value);
		rule[name] = name === "thresholdTokens" && /^\d+$/.test(text) ? Number(text) : text;
	}
	return compactionRule(rule, path);
}

export function planCompactionRules(dir: string): CompactionRulesPlan {
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => MD_PATTERN.test(name))
			.sort();
	} catch {
		return { kind: "none" };
	}
	if (names.length === 0) return { kind: "none" };
	const sources = names.map((name) => join(dir, name));
	const target = join(dir, RULES_FILE);
	if (existsSync(target))
		return { kind: "kept", reason: `${target} already exists; move the rules of ${sources.join(", ")} into it by hand` };
	const managed = [target, ...sources].find((path) => isAppManaged(path));
	if (managed !== undefined) return { kind: "kept", reason: `${managed} is app-managed` };
	const rules: Mapping[] = [];
	for (const source of sources) {
		const rule = mdRule(source);
		if (typeof rule === "string") return { kind: "kept", reason: rule };
		rules.push(rule);
	}
	return { kind: "ready", target, content: compactionRulesText(rules), sources };
}

export function settleCompactionRules(opts: ApplyOptions, report: ApplyReport, exclusions: Exclusions): void {
	const rel = `${MACHINE_DIR_REL}/${RULES_FILE}`;
	const plan = planCompactionRules(targetOf(MACHINE_DIR_REL, opts.agentDir));
	switch (plan.kind) {
		case "none":
			return;
		case "kept":
			report.notes.push(`COMPACTION-*.md rules left in place: ${plan.reason}`);
			return;
		case "ready":
			break;
		default: {
			const unreachable: never = plan;
			throw new Error(`unknown compaction rules plan ${JSON.stringify(unreachable)}`);
		}
	}
	if (plainRelExcluded(rel, exclusions)) {
		report.skipped.push({ path: plan.target, reason: EXCLUDED_REASON });
		return;
	}
	if (opts.check) {
		report.notes.push(`COMPACTION-*.md rules: apply moves ${plan.sources.join(", ")} into ${plan.target}`);
		return;
	}
	const result = applyCompactionRules(plan);
	report.written.push(...result.written);
	report.deleted.push(...result.deleted);
}

export function applyCompactionRules(plan: Extract<CompactionRulesPlan, { kind: "ready" }>): CompactionRulesResult {
	atomicWrite(plan.target, plan.content);
	const deleted: string[] = [];
	for (const source of plan.sources) {
		unlinkSync(source);
		deleted.push(source);
	}
	return { written: [plan.target], deleted };
}
