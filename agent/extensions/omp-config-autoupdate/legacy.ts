import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { type BaseChange, type BaseRecord, git, type RepoHistory, unmodifiedSection } from "./base.ts";
import { isAppManaged, lexists } from "./files.ts";
import { parseLegacyModelFragments } from "./legacy-model-fragments.ts";
import { convertLegacySystemReplacements } from "./legacy-system-replacements.ts";
import { isMapping, type Mapping, valueAt } from "./merge.ts";
import { OMOMP_FILES, REPLACEMENT_SECTION, removeYamlSections } from "./omomp-migration.ts";
import { agentRelOf, EXCLUDED_REASON, type Exclusions, fieldExcluded, OMOMP_REL, plainRelExcluded, targetOf } from "./paths.ts";
import { type Op, type PlanContext, type ReplacementMigration, skipExcluded } from "./plan.ts";
import type { ApplyOptions, ApplyReport } from "./report.ts";

export const REPLACEMENT_RULES_REL = "agent/extensions-last/system-prompt-replace/REPLACE-SYSTEM-default.yml";
const LEGACY_REPLACEMENT_RELS = [
	"agent/extensions-last/system-prompt-replace/system-prompt-replace.json",
	"agent/system-prompt-replace.json",
] as const;

export function planReplacementMigration(
	opts: ApplyOptions,
	report: ApplyReport,
	base: BaseRecord,
	history: RepoHistory,
	exclusions: Exclusions,
): ReplacementMigration {
	const files = OMOMP_FILES.filter((rel) => lexists(join(opts.agentDir, rel)));
	const legacy = LEGACY_REPLACEMENT_RELS.filter((rel) => lexists(targetOf(rel, opts.agentDir)));
	const blocked = (reason: string): ReplacementMigration => {
		report.notes.push(`system-prompt-replace migration left in place: ${reason}; move the section to REPLACE-SYSTEM-*.yml by hand`);
		return { kind: "blocked" };
	};
	let root: Mapping | undefined;
	let text: string | undefined;
	let containsSection = false;
	for (const rel of files) {
		try {
			const content = readFileSync(join(opts.agentDir, rel), "utf8");
			const parsed: unknown = rel.endsWith(".json")
				? JSON.parse(content)
				: rel.endsWith(".toml")
					? Bun.TOML.parse(content)
					: Bun.YAML.parse(content);
			if (!isMapping(parsed)) throw new Error("root is not a mapping");
			containsSection ||= Object.hasOwn(parsed, "system-prompt-replace");
			if (rel === "omomp.yml") {
				text = content;
				root = parsed;
			}
		} catch (error) {
			return blocked(`${join(opts.agentDir, rel)}: ${errorText(error)}`);
		}
	}
	if (containsSection && (files.length > 1 || files[0] !== "omomp.yml"))
		return blocked(`unsupported or ambiguous omomp files: ${files.map((rel) => join(opts.agentDir, rel)).join(", ")}`);
	const hasSection = root !== undefined && Object.hasOwn(root, "system-prompt-replace");
	if (!hasSection && legacy.length === 0) return { kind: "none" };
	const migrationExcluded =
		plainRelExcluded(REPLACEMENT_RULES_REL, exclusions) ||
		plainRelExcluded(OMOMP_REL, exclusions) ||
		fieldExcluded(OMOMP_REL, [REPLACEMENT_SECTION], exclusions) ||
		legacy.some((rel) => plainRelExcluded(rel, exclusions));
	if (migrationExcluded) {
		for (const rel of [REPLACEMENT_RULES_REL, OMOMP_REL, ...legacy])
			if (plainRelExcluded(rel, exclusions)) report.skipped.push({ path: targetOf(rel, opts.agentDir), reason: EXCLUDED_REASON });
		if (fieldExcluded(OMOMP_REL, [REPLACEMENT_SECTION], exclusions))
			report.skipped.push({ path: `${targetOf(OMOMP_REL, opts.agentDir)}:${REPLACEMENT_SECTION}`, reason: EXCLUDED_REASON });
		return { kind: "none" };
	}
	const destination = targetOf(REPLACEMENT_RULES_REL, opts.agentDir);
	if (lexists(destination)) return blocked(`${destination} already exists`);
	if (files.some((rel) => isAppManaged(join(opts.agentDir, rel)))) return blocked(`${targetOf(OMOMP_REL, opts.agentDir)} is app-managed`);
	const managedLegacy = legacy.find((rel) => isAppManaged(targetOf(rel, opts.agentDir)));
	if (managedLegacy !== undefined) return blocked(`${targetOf(managedLegacy, opts.agentDir)} is app-managed`);
	if (hasSection && legacy.length > 0)
		return blocked(`the section and legacy JSON coexist: ${[OMOMP_REL, ...legacy].map((rel) => targetOf(rel, opts.agentDir)).join(", ")}`);
	let value: unknown = root?.["system-prompt-replace"];
	if (!hasSection) {
		if (legacy.length !== 1) return blocked(`multiple legacy JSON files: ${legacy.join(", ")}`);
		try {
			value = JSON.parse(readFileSync(targetOf(legacy[0]!, opts.agentDir), "utf8"));
		} catch (error) {
			return blocked(`${legacy[0]}: ${errorText(error)}`);
		}
	}
	const item = hasSection ? { rel: OMOMP_REL, format: "yaml" as const } : { rel: legacy[0]!, format: "json" as const };
	const path = hasSection ? ["system-prompt-replace"] : [];
	let rules: string | undefined;
	if (!unmodifiedSection(base, history, item.rel, item.format, path, value)) {
		const converted = convertLegacySystemReplacements(value);
		if (converted.kind === "invalid") return blocked(converted.reason);
		rules = converted.text;
	}
	let omomp: string | undefined;
	if (hasSection && root !== undefined && text !== undefined) {
		const removed = removeYamlSections(text, root, [REPLACEMENT_SECTION]);
		if (removed.kind === "invalid") return blocked(removed.reason);
		omomp = removed.text;
	}
	const recorded = base.structuredOf(OMOMP_REL);
	const omompBase: BaseChange | undefined =
		recorded === undefined || valueAt(recorded.value, [REPLACEMENT_SECTION]) === undefined
			? undefined
			: {
					kind: "structured",
					rel: OMOMP_REL,
					record: {
						value: Object.fromEntries(Object.entries(recorded.value).filter(([key]) => key !== REPLACEMENT_SECTION)),
						unknown: recorded.unknown.filter((path) => path[0] !== REPLACEMENT_SECTION),
					},
				};
	return { kind: "ready", rules, omomp, legacy, omompBase };
}

export function groupReplacementMigration(opts: ApplyOptions, migration: ReplacementMigration, planned: readonly Op[]): Op[] {
	if (migration.kind !== "ready") return [...planned];
	const writes: Extract<Op, { kind: "write" }>[] = [];
	const changes: BaseChange[] = [];
	const rest: Op[] = [];
	for (const op of planned) {
		if (op.rel === REPLACEMENT_RULES_REL && op.kind === "write") writes.push(op);
		else if (op.rel === REPLACEMENT_RULES_REL && op.kind === "base") changes.push(op.change);
		else rest.push(op);
	}
	if (migration.omomp !== undefined)
		writes.push({ kind: "write", rel: OMOMP_REL, target: targetOf(OMOMP_REL, opts.agentDir), content: migration.omomp });
	if (migration.omompBase !== undefined) changes.push(migration.omompBase);
	return [
		{
			kind: "migrate-replacements",
			rel: REPLACEMENT_RULES_REL,
			target: targetOf(REPLACEMENT_RULES_REL, opts.agentDir),
			writes,
			deletes: migration.legacy.map((rel) => targetOf(rel, opts.agentDir)),
			changes,
		},
		...rest,
	];
}

export function migrateConfigMapping(mapping: Mapping): { readonly value: Mapping; readonly migratedXdevDocs: boolean } {
	if (!isMapping(mapping.tools) || !Object.hasOwn(mapping.tools, "xdevDocs")) {
		return { value: mapping, migratedXdevDocs: false };
	}
	const nextTools: Mapping = { ...mapping.tools };
	if (!Object.hasOwn(nextTools, "commandDocs")) {
		nextTools.commandDocs = nextTools.xdevDocs;
	}
	delete nextTools.xdevDocs;
	return { value: { ...mapping, tools: nextTools }, migratedXdevDocs: true };
}

export interface Supersession {
	readonly from: string;
	readonly by: string;
}

export type DataMove =
	| { readonly kind: "split-model"; readonly owner: "host"; readonly from: readonly string[]; readonly toDir: string }
	| { readonly kind: "pattern"; readonly owner: "host" | "template"; readonly pattern: RegExp; readonly toDir: string };

function previouslyShipped(opts: ApplyOptions, rel: string): boolean {
	return opts.previousCommit !== undefined && git(opts.source, ["cat-file", "-e", `${opts.previousCommit}:${rel}`]).ok;
}

function planLegacyModelSplits(ctx: PlanContext, from: readonly string[], toDir: string): Op[] {
	const { opts, report } = ctx;
	const candidates: { rel: string; target: string; fragments: { target: string; content: string }[] }[] = [];
	for (const rel of from) {
		const source = join(opts.agentDir, rel);
		if (!lexists(source)) continue;
		if (skipExcluded(ctx, `agent/${rel}`)) continue;
		if (isAppManaged(source)) {
			report.skipped.push({ path: source, reason: "app-managed" });
			continue;
		}
		if (lstatSync(source).isSymbolicLink()) {
			report.notes.push(
				`${source} is a symlink and was not moved; split it into ${join(opts.agentDir, toDir)}/APPEND-SYSTEM-model-NN.md yourself`,
			);
			continue;
		}
		const parsed = parseLegacyModelFragments(readFileSync(source, "utf8"));
		if (parsed.kind === "invalid") {
			report.notes.push(`${source} left in place: cannot split APPEND_SYSTEM_MODEL.md: ${parsed.reason}`);
			continue;
		}
		candidates.push({
			rel: `agent/${rel}`,
			target: source,
			fragments: parsed.fragments.map((content, index) => ({
				target: join(opts.agentDir, toDir, `APPEND-SYSTEM-model-${String(index + 1).padStart(2, "0")}.md`),
				content,
			})),
		});
	}
	const ops: Op[] = [];
	for (const candidate of candidates) {
		const collision = candidate.fragments.find(({ target }) => lexists(target));
		if (collision) {
			report.notes.push(`${candidate.target} left in place: ${collision.target} already exists`);
			continue;
		}
		const overlap = candidates.find(
			(other) =>
				other !== candidate && other.fragments.some(({ target }) => candidate.fragments.some((fragment) => fragment.target === target)),
		);
		if (overlap) {
			report.notes.push(`${candidate.target} left in place: numbered fragment targets overlap with ${overlap.target}`);
			continue;
		}
		const shipped = candidate.fragments.find((_, index) =>
			lexists(join(opts.source, "agent", toDir, `APPEND-SYSTEM-model-${String(index + 1).padStart(2, "0")}.md`)),
		);
		if (shipped) {
			report.notes.push(`${candidate.target} left in place: ${shipped.target} is a managed source file`);
			continue;
		}
		if (
			candidate.fragments.some((fragment) => {
				const rel = agentRelOf(opts.agentDir, fragment.target);
				return rel !== undefined && plainRelExcluded(rel, ctx.exclusions);
			})
		) {
			report.skipped.push({ path: candidate.target, reason: EXCLUDED_REASON });
			continue;
		}
		ops.push({ kind: "split", ...candidate });
	}
	return ops;
}

export function planRelocations(ctx: PlanContext, superseded: readonly Supersession[], dataMoves: readonly DataMove[]): Op[] {
	const { opts, report } = ctx;
	const ops: Op[] = [];
	for (const { from, by } of superseded) {
		const target = join(opts.agentDir, from);
		if (!lexists(target) || !existsSync(join(opts.source, "agent", by)) || skipExcluded(ctx, `agent/${from}`)) continue;
		if (isAppManaged(target)) {
			report.errors.push(`${target} is app-managed and would load beside ${join(opts.agentDir, by)}; remove one of them`);
			continue;
		}
		ops.push({ kind: "delete", rel: `agent/${from}`, target });
	}
	const moves: { from: string; to: string; owner: "host" | "template" }[] = [];
	for (const entry of dataMoves) {
		switch (entry.kind) {
			case "split-model":
				ops.push(...planLegacyModelSplits(ctx, entry.from, entry.toDir));
				break;
			case "pattern": {
				let names: string[];
				try {
					names = readdirSync(opts.agentDir);
				} catch {
					continue;
				}
				for (const name of names.sort()) {
					if (entry.pattern.test(name)) moves.push({ from: name, to: `${entry.toDir}/${name}`, owner: entry.owner });
				}
				break;
			}
			default: {
				const unreachable: never = entry;
				throw new Error(`unknown data move ${JSON.stringify(unreachable)}`);
			}
		}
	}
	for (const { from, to, owner } of moves) {
		const source = join(opts.agentDir, from);
		const target = join(opts.agentDir, to);
		if (!lexists(source)) continue;
		if (skipExcluded(ctx, `agent/${from}`) || skipExcluded(ctx, `agent/${to}`)) continue;
		if (isAppManaged(source)) {
			report.skipped.push({ path: source, reason: "app-managed" });
			continue;
		}
		const repoOwned = owner === "template" && (existsSync(join(opts.source, "agent", to)) || previouslyShipped(opts, `agent/${from}`));
		if (repoOwned && !shippedTemplateCopy(ctx, from, to, readFileSync(source))) {
			report.notes.push(`${source} left in place: it differs from every shipped version; port its changes into ${target}, then delete it`);
		} else if (repoOwned) {
			ops.push({ kind: "delete", rel: `agent/${from}`, target: source });
		} else if (lstatSync(source).isSymbolicLink()) {
			report.notes.push(`${source} is a symlink and was not moved; point it at ${target} yourself`);
		} else if (lexists(target)) {
			report.notes.push(`${source} left in place: ${target} already exists`);
		} else {
			ops.push({ kind: "move", rel: `agent/${to}`, from: source, target });
		}
	}
	return ops;
}

function shippedTemplateCopy(ctx: PlanContext, from: string, to: string, content: Buffer): boolean {
	return [`agent/${from}`, `agent/${to}`].some((rel) => {
		const recorded = ctx.base.plain(rel);
		if (recorded.kind === "known" && recorded.content.equals(content)) return true;
		const current = join(ctx.opts.source, rel);
		if (existsSync(current) && readFileSync(current).equals(content)) return true;
		return ctx.history.hasVersion(rel, content);
	});
}
