import { type BigIntStats, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** What `lstat` saw: backends act on the entry itself, never on a link's target. */
export type EntryKind = "file" | "directory" | "link";

/**
 * A path that passed validation. `operand` is what a backend acts on: the
 * literal path resolved against the session cwd, so a symbolic link is deleted
 * as the link itself.
 */
export type Target = { readonly given: string; readonly operand: string; readonly kind: EntryKind };

export type Refusal = { readonly given: string; readonly reason: string };

export type Validation =
	| { readonly kind: "ok"; readonly targets: readonly Target[] }
	| { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

/**
 * Protected directories by file identity (`dev:ino`), so case variants,
 * firmlinks, bind mounts and symbolic links of one directory all match, and by
 * canonical spelling (real path; case-folded with `\` separators on Windows),
 * which also covers protected directories that no longer exist (a removed cwd)
 * and filesystems that report no inode.
 */
type Guard = { readonly identities: ReadonlyMap<string, string>; readonly spelled: ReadonlyMap<string, string> };

const WINDOWS = process.platform === "win32";

/** `dev:ino`, or null when the filesystem reports no inode (every file would share one key). */
const identityOf = (stats: BigIntStats): string | null => (stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`);

/** A path compared as a spelling: Windows paths are case-insensitive and accept either separator. */
function spellingOf(file: string): string {
	if (!WINDOWS) return file;
	const normalized = path.win32.normalize(file).toLowerCase();
	return normalized.length > path.win32.parse(normalized).root.length ? normalized.replace(/\\+$/, "") : normalized;
}

const isRoot = (file: string): boolean =>
	path.parse(file).root === file || (WINDOWS && path.win32.parse(spellingOf(file)).root === spellingOf(file));

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
		// A home or cwd that no longer exists is protected by spelling; its existing ancestors still by identity.
	}
	let current = real ?? path.resolve(dir);
	let reason = selfReason;
	for (;;) {
		const stats = statOrNull(current, true);
		const identity = stats === null ? null : identityOf(stats);
		if (identity !== null && !identities.has(identity)) identities.set(identity, reason);
		const spelling = spellingOf(current);
		if (!spelled.has(spelling)) spelled.set(spelling, reason);
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
		reason = ancestorReason;
	}
}

function buildGuard(home: string, cwd: string): Guard {
	const identities = new Map<string, string>();
	const spelled = new Map<string, string>();
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
	if (WINDOWS && /^[A-Za-z]:$/.test(given))
		return { given, reason: "a bare drive (`C:`) names that drive's current directory; give the full path" };
	const operand = path.resolve(cwd, given);
	// What the kernel reaches with the text as written: `..`, `.` and a trailing `/` are resolved through links.
	const written = path.isAbsolute(given) ? given : `${cwd}${path.sep}${given}`;
	if (isRoot(operand)) return { given, reason: "it is a filesystem root" };
	const entry = statOrNull(written, false);
	if (entry === null) return { given, reason: `it does not exist (resolved literally to ${operand})` };
	const reached = realOrSelf(written);
	if (isRoot(reached) || isRoot(realOrSelf(operand))) return { given, reason: `it resolves to ${reached}, and it is a filesystem root` };
	const link = statOrNull(operand, false);
	const linkIdentity = link === null ? null : identityOf(link);
	const candidates = [entry, statOrNull(written, true), link, statOrNull(operand, true)];
	for (const stats of candidates) {
		const identity = stats === null ? null : identityOf(stats);
		if (identity === null) continue;
		const reason = guard.identities.get(identity);
		if (reason === undefined) continue;
		return identity === linkIdentity ? { given, reason } : { given, reason: `it resolves to ${reached}, and ${reason}` };
	}
	const spellings: readonly (readonly [string, boolean])[] = [
		[operand, false],
		[reached, true],
		[realOrSelf(operand), true],
	];
	for (const [spelling, resolved] of spellings) {
		const reason = guard.spelled.get(spellingOf(spelling));
		if (reason === undefined) continue;
		return resolved && spellingOf(spelling) !== spellingOf(operand)
			? { given, reason: `it resolves to ${spelling}, and ${reason}` }
			: { given, reason };
	}
	const entryIdentity = identityOf(entry);
	const sameEntry =
		link !== null &&
		(entryIdentity === null || linkIdentity === null
			? spellingOf(reached) === spellingOf(realOrSelf(operand))
			: entryIdentity === linkIdentity);
	if (!sameEntry) {
		return {
			given,
			reason: `as written it reaches a different file than ${operand} (a \`..\`, \`.\` or trailing \`/\` passes through a symbolic link); give the path without them`,
		};
	}
	const kind: EntryKind = link.isSymbolicLink() ? "link" : link.isDirectory() ? "directory" : "file";
	return { given, operand, kind };
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
