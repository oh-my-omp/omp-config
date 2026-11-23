import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BaseChange, BaseRecord } from "./base.ts";
import { type Format, type Mapping, type Path, parseStructured, related, setAt, valueAt } from "./merge.ts";
import type { Conflict, ConflictScan } from "./report.ts";

export type FormatOf = (rel: string) => Format;

function fenced(value: unknown): string {
	return value === undefined ? "  (absent)" : `  \`\`\`json\n${JSON.stringify(value, null, 2).replace(/^/gm, "  ")}\n  \`\`\``;
}

function conflictDetail(conflict: Conflict, source: string, base: BaseRecord, formatOf: FormatOf): string[] {
	const incoming = join(source, conflict.rel);
	switch (conflict.kind) {
		case "file": {
			const recorded = base.plain(conflict.rel);
			const basePath = recorded.kind === "known" ? base.plainPath(conflict.rel) : `(${recorded.kind}: compare local and incoming directly)`;
			const lines = [
				`## ${conflict.id}`,
				`- reason: ${conflict.reason}`,
				`- local: ${existsSync(conflict.target) ? conflict.target : `(deleted locally) ${conflict.target}`}`,
				`- base: ${basePath}`,
				`- incoming: ${existsSync(incoming) ? incoming : "(removed upstream)"}`,
			];
			if (recorded.kind === "known" && existsSync(conflict.target) && existsSync(incoming))
				lines.push(`- merge proposal with conflict markers: git merge-file -p "${conflict.target}" "${basePath}" "${incoming}"`);
			return lines;
		}
		case "key": {
			const format = formatOf(conflict.rel);
			const local = existsSync(conflict.target) ? parseStructured(readFileSync(conflict.target, "utf8"), format) : undefined;
			const repo = parseStructured(readFileSync(incoming, "utf8"), format);
			const record = base.structuredOf(conflict.rel);
			const baseLine =
				conflict.reason === "unknown-base" || record === undefined
					? "- base: (unknown: compare local and incoming directly)"
					: `- base:\n${fenced(valueAt(record.value, conflict.path))}`;
			return [
				`## ${conflict.id}`,
				`- reason: ${conflict.reason}`,
				`- file: ${conflict.target}`,
				`- key: ${conflict.path.map((key) => JSON.stringify(key)).join(" › ")}`,
				`- local:\n${fenced(valueAt(local, conflict.path))}`,
				baseLine,
				`- incoming (${incoming}):\n${fenced(valueAt(repo, conflict.path))}`,
			];
		}
		default: {
			const unreachable: never = conflict;
			throw new Error(String(unreachable));
		}
	}
}

export function conflictsText(
	conflicts: readonly Conflict[],
	source: string,
	agentDir: string,
	updaterPath: string,
	formatOf: FormatOf,
): string {
	if (conflicts.length === 0) return `omp-config: no conflicts between local customizations and ${source}.`;
	const resolveCommand = `bun "${updaterPath}" resolve --source "${source}" --agent-dir "${agentDir}" <id>…`;
	const base = BaseRecord.load(agentDir);
	return [
		`# omp-config: local customizations that conflict with upstream (${conflicts.length})`,
		"",
		`Upstream source: ${source}. Agent dir: ${agentDir}. Each local copy was kept as it is.`,
		"",
		"Adapt them with the user, one at a time:",
		"1. Read the local copy, the base and the incoming version listed for the conflict. Base → incoming is what upstream changed; base → local is what this machine changed. With an unknown base, compare local and incoming directly.",
		"2. Explain both changes in one sentence each. Then use `ask`: keep local, take incoming, or a merged version you propose and show. Recommend the merge when both changes can coexist.",
		"3. Apply the choice to the local file with `edit`. In config.yml change only the conflicting key and keep comments and other keys. Keeping local needs no edit.",
		`4. Record the adapted conflicts: ${resolveCommand}`,
		"   A refused (stale) id means upstream moved meanwhile: list the conflicts again and adapt the new version.",
		"5. Report what each conflict became. Extension code, system prompt files and tool topics load on the next OMP start; config.yml reloads live.",
		"",
		...conflicts.flatMap((conflict) => [...conflictDetail(conflict, source, base, formatOf), ""]),
	].join("\n");
}

export interface ResolveOutcome {
	readonly resolved: string[];
	readonly stale: string[];
	readonly unknown: string[];
	readonly errors: string[];
}

export function resolveConflicts(
	scan: ConflictScan,
	source: string,
	agentDir: string,
	ids: readonly string[],
	formatOf: FormatOf,
): ResolveOutcome {
	const outcome: ResolveOutcome = { resolved: [], stale: [], unknown: [], errors: [] };
	if (scan.kind === "failed") {
		outcome.errors.push(scan.error);
		return outcome;
	}
	const base = BaseRecord.load(agentDir);
	const changes: BaseChange[] = [];
	const records = new Map<string, { value: Mapping; unknown: Path[] }>();
	for (const id of ids) {
		const conflict = scan.conflicts.find((candidate) => candidate.id === id);
		if (conflict === undefined) {
			const stem = id.slice(0, id.lastIndexOf("@"));
			(scan.conflicts.some((candidate) => candidate.id.slice(0, candidate.id.lastIndexOf("@")) === stem)
				? outcome.stale
				: outcome.unknown
			).push(id);
			continue;
		}
		const incoming = join(source, conflict.rel);
		switch (conflict.kind) {
			case "file":
				changes.push(
					existsSync(incoming)
						? { kind: "plain-known", rel: conflict.rel, content: readFileSync(incoming) }
						: { kind: "plain-drop", rel: conflict.rel },
				);
				break;
			case "key": {
				const recorded = base.structuredOf(conflict.rel);
				const record =
					records.get(conflict.rel) ?? (recorded && { value: structuredClone(recorded.value), unknown: [...recorded.unknown] });
				if (record === undefined) {
					outcome.errors.push(`${id}: no base recorded for ${conflict.rel} yet; run apply first`);
					continue;
				}
				setAt(record.value, conflict.path, valueAt(parseStructured(readFileSync(incoming, "utf8"), formatOf(conflict.rel)), conflict.path));
				record.unknown = record.unknown.filter((path) => !related(path, conflict.path));
				records.set(conflict.rel, record);
				break;
			}
			default: {
				const unreachable: never = conflict;
				throw new Error(String(unreachable));
			}
		}
		outcome.resolved.push(id);
	}
	for (const [rel, record] of records) changes.push({ kind: "structured", rel, record });
	base.commit(changes);
	return outcome;
}
