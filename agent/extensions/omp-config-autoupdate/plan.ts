import type { BaseChange, BaseRecord, RepoHistory } from "./base.ts";
import { EXCLUDED_REASON, type Exclusions, plainRelExcluded, targetOf } from "./paths.ts";
import type { ApplyOptions, ApplyReport } from "./report.ts";

export type Op =
	| {
			readonly kind: "write";
			readonly rel: string;
			readonly target: string;
			readonly content: string | Uint8Array;
			readonly base?: BaseChange;
	  }
	| { readonly kind: "move"; readonly rel: string; readonly from: string; readonly target: string }
	| {
			readonly kind: "split";
			readonly rel: string;
			readonly target: string;
			readonly fragments: readonly { readonly target: string; readonly content: string }[];
	  }
	| { readonly kind: "delete"; readonly rel: string; readonly target: string; readonly base?: BaseChange }
	| { readonly kind: "rmdir"; readonly rel: string; readonly target: string }
	| {
			readonly kind: "migrate-replacements";
			readonly rel: string;
			readonly target: string;
			readonly writes: readonly Extract<Op, { kind: "write" }>[];
			readonly deletes: readonly string[];
			readonly changes: readonly BaseChange[];
	  }
	| { readonly kind: "base"; readonly rel: string; readonly change: BaseChange };

export type ReplacementMigration =
	| { readonly kind: "none" }
	| { readonly kind: "blocked" }
	| {
			readonly kind: "ready";
			readonly rules: string | undefined;
			readonly omomp: string | undefined;
			readonly legacy: readonly string[];
			readonly omompBase: BaseChange | undefined;
	  };

export interface PlanContext {
	readonly opts: ApplyOptions;
	readonly report: ApplyReport;
	readonly base: BaseRecord;
	readonly history: RepoHistory;
	readonly todoRequired: boolean;
	readonly forkRequired: boolean;
	readonly freshMachine: boolean;
	readonly replacementMigration: ReplacementMigration;
	readonly exclusions: Exclusions;
}

export function skipExcluded(ctx: PlanContext, rel: string): boolean {
	if (!plainRelExcluded(rel, ctx.exclusions)) return false;
	ctx.report.skipped.push({ path: targetOf(rel, ctx.opts.agentDir), reason: EXCLUDED_REASON });
	return true;
}
