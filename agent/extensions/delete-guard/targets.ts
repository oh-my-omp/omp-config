import { type BigIntStats, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { absurd } from "./verdict.ts";

type EntryKind = "file" | "directory" | "link";

export type Target = { readonly given: string; readonly operand: string; readonly kind: EntryKind };

type Refusal = { readonly given: string; readonly reason: string };

type Validation =
	| { readonly kind: "ok"; readonly targets: readonly Target[] }
	| { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

type Guard = { readonly identities: ReadonlyMap<string, string>; readonly spelled: ReadonlyMap<string, string> };

type Check = { readonly kind: "ok"; readonly target: Target } | { readonly kind: "refused"; readonly reason: string };

type Located = {
	readonly operand: string;
	readonly written: string;
	readonly reached: string;
	readonly entry: BigIntStats;
	readonly link: BigIntStats | null;
};

const WINDOWS = process.platform === "win32";

const identityOf = (stats: BigIntStats): string | null => (stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`);

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
		return null;
	}
}

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
	} catch {}
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
		return file;
	}
}

function syntaxRefusal(given: string): string | null {
	if (given.trim().length === 0) return "the path is empty";
	if (given.startsWith("~")) return "paths are literal: `~` is not expanded; give the full path";
	if (WINDOWS && /^[A-Za-z]:$/.test(given)) return "a bare drive (`C:`) names that drive's current directory; give the full path";
	return null;
}

function protectedByIdentity(guard: Guard, at: Located): string | null {
	const linkIdentity = at.link === null ? null : identityOf(at.link);
	for (const stats of [at.entry, statOrNull(at.written, true), at.link, statOrNull(at.operand, true)]) {
		const identity = stats === null ? null : identityOf(stats);
		const reason = identity === null ? undefined : guard.identities.get(identity);
		if (reason === undefined) continue;
		return identity === linkIdentity ? reason : `it resolves to ${at.reached}, and ${reason}`;
	}
	return null;
}

function protectedBySpelling(guard: Guard, at: Located): string | null {
	const operandSpelling = spellingOf(at.operand);
	const spellings: readonly (readonly [string, boolean])[] = [
		[at.operand, false],
		[at.reached, true],
		[realOrSelf(at.operand), true],
	];
	for (const [spelling, resolved] of spellings) {
		const reason = guard.spelled.get(spellingOf(spelling));
		if (reason === undefined) continue;
		return resolved && spellingOf(spelling) !== operandSpelling ? `it resolves to ${spelling}, and ${reason}` : reason;
	}
	return null;
}

function writtenReachesOperand(at: Located, link: BigIntStats): boolean {
	const entryIdentity = identityOf(at.entry);
	const linkIdentity = identityOf(link);
	return entryIdentity === null || linkIdentity === null
		? spellingOf(at.reached) === spellingOf(realOrSelf(at.operand))
		: entryIdentity === linkIdentity;
}

function validateOne(given: string, cwd: string, guard: Guard): Check {
	const refused = (reason: string): Check => ({ kind: "refused", reason });
	const syntax = syntaxRefusal(given);
	if (syntax !== null) return refused(syntax);
	const operand = path.resolve(cwd, given);
	if (isRoot(operand)) return refused("it is a filesystem root");
	const written = path.isAbsolute(given) ? given : `${cwd}${path.sep}${given}`;
	const entry = statOrNull(written, false);
	if (entry === null) return refused(`it does not exist (resolved literally to ${operand})`);
	const reached = realOrSelf(written);
	if (isRoot(reached) || isRoot(realOrSelf(operand))) return refused(`it resolves to ${reached}, and it is a filesystem root`);
	const at: Located = { operand, written, reached, entry, link: statOrNull(operand, false) };
	const guarded = protectedByIdentity(guard, at) ?? protectedBySpelling(guard, at);
	if (guarded !== null) return refused(guarded);
	const link = at.link;
	if (link === null || !writtenReachesOperand(at, link)) {
		return refused(
			`as written it reaches a different file than ${operand} (a \`..\`, \`.\` or trailing \`/\` passes through a symbolic link); give the path without them`,
		);
	}
	const kind: EntryKind = link.isSymbolicLink() ? "link" : link.isDirectory() ? "directory" : "file";
	return { kind: "ok", target: { given, operand, kind } };
}

export function validateTargets(paths: readonly string[], cwd: string): Validation {
	const guard = buildGuard(homedir(), cwd);
	const targets: Target[] = [];
	const refusals: Refusal[] = [];
	for (const given of paths) {
		const check = validateOne(given, cwd, guard);
		switch (check.kind) {
			case "ok":
				targets.push(check.target);
				break;
			case "refused":
				refusals.push({ given, reason: check.reason });
				break;
			default:
				absurd(check);
		}
	}
	return refusals.length > 0 ? { kind: "refused", refusals } : { kind: "ok", targets };
}
