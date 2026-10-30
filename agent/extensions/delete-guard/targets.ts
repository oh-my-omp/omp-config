import { type BigIntStats, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * A path that passed validation. `operand` is what a backend acts on: the
 * literal path resolved against the session cwd, so a symbolic link is deleted
 * as the link itself.
 */
export type Target = { readonly given: string; readonly operand: string };

export type Refusal = { readonly given: string; readonly reason: string };

export type Validation =
	| { readonly kind: "ok"; readonly targets: readonly Target[] }
	| { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

/**
 * Protected directories by file identity (`dev:ino`), so case variants,
 * firmlinks, bind mounts and symbolic links of one directory all match.
 * `spelled` covers protected directories that no longer exist (a removed
 * cwd), which have no identity: their lexical path and its ancestors.
 */
type Guard = { readonly identities: ReadonlyMap<string, string>; readonly spelled: ReadonlyMap<string, string> };

const identityOf = (stats: BigIntStats): string => `${stats.dev}:${stats.ino}`;

function statOrNull(file: string, follow: boolean): BigIntStats | null {
	try {
		return follow ? statSync(file, { bigint: true }) : lstatSync(file, { bigint: true });
	} catch {
		// Absent or unreadable: no identity to compare.
		return null;
	}
}

/** Records `dir` with `selfReason` and each parent with `ancestorReason`; the first reason given to a directory wins. */
function protectChain(
	identities: Map<string, string>,
	spelled: Map<string, string>,
	dir: string,
	selfReason: string,
	ancestorReason: string,
): void {
	let real: string | null = null;
	try {
		real = realpathSync.native(dir);
	} catch {
		// A home or cwd that no longer exists is protected by spelling only.
	}
	let current = real ?? path.resolve(dir);
	let reason = selfReason;
	for (;;) {
		const stats = real === null ? null : statOrNull(current, true);
		const map = stats === null ? spelled : identities;
		const key = stats === null ? current : identityOf(stats);
		if (!map.has(key)) map.set(key, reason);
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
		reason = ancestorReason;
	}
}

function buildGuard(home: string, cwd: string): Guard {
	const identities = new Map<string, string>();
	const spelled = new Map<string, string>();
	const root = path.parse(path.resolve(cwd)).root;
	const rootStats = statOrNull(root, true);
	if (rootStats !== null) identities.set(identityOf(rootStats), "it is the filesystem root");
	spelled.set(root, "it is the filesystem root");
	protectChain(identities, spelled, home, "it is the home directory", "it is an ancestor of the home directory");
	protectChain(identities, spelled, cwd, "it is the session cwd", "it is an ancestor of the session cwd");
	return { identities, spelled };
}

function realOrSelf(file: string): string {
	try {
		return realpathSync.native(file);
	} catch {
		// A dangling link has no real path; name it as written.
		return file;
	}
}

function validateOne(given: string, cwd: string, guard: Guard): Target | Refusal {
	if (given.trim().length === 0) return { given, reason: "the path is empty" };
	if (given.startsWith("~")) return { given, reason: "paths are literal: `~` is not expanded; give the full path" };
	const operand = path.resolve(cwd, given);
	// What the kernel reaches with the text as written: `..`, `.` and a trailing `/` are resolved through links.
	const written = path.isAbsolute(given) ? given : `${cwd}${path.sep}${given}`;
	const entry = statOrNull(written, false);
	if (entry === null) return { given, reason: `it does not exist (resolved literally to ${operand})` };
	const link = statOrNull(operand, false);
	const candidates = [entry, statOrNull(written, true), link, statOrNull(operand, true)];
	for (const stats of candidates) {
		if (stats === null) continue;
		const reason = guard.identities.get(identityOf(stats));
		if (reason === undefined) continue;
		return link !== null && identityOf(stats) === identityOf(link)
			? { given, reason }
			: { given, reason: `it resolves to ${realOrSelf(written)}, and ${reason}` };
	}
	for (const spelling of [operand, realOrSelf(written)]) {
		const reason = guard.spelled.get(spelling);
		if (reason !== undefined) return { given, reason };
	}
	if (link === null || identityOf(link) !== identityOf(entry)) {
		return {
			given,
			reason: `as written it reaches a different file than ${operand} (a \`..\`, \`.\` or trailing \`/\` passes through a symbolic link); give the path without them`,
		};
	}
	return { given, operand };
}

/** Validates every path before any is touched: one refusal refuses the whole call. */
export function validateTargets(paths: readonly string[], cwd: string): Validation {
	const guard = buildGuard(homedir(), cwd);
	const targets: Target[] = [];
	const refusals: Refusal[] = [];
	for (const given of paths) {
		const result = validateOne(given, cwd, guard);
		if ("operand" in result) targets.push(result);
		else refusals.push(result);
	}
	return refusals.length > 0 ? { kind: "refused", refusals } : { kind: "ok", targets };
}
