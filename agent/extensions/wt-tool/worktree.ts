import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { planWorktreeExit } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import type { SessionWorktree } from "@oh-my-pi/pi-coding-agent/worktree/backend";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "../_shared/errors.ts";

const LIST_LIMIT = 50;

export const CONFIRM_INVALIDATION =
	"a file was added, removed or edited (by size or modification time), HEAD or the branch moved, or the ignored-entry list changed";

export type WorktreeCheck = {
	readonly worktree: string;
	readonly branch: string;
	readonly mainDir: string;
	readonly confirm: string;
	readonly staged: readonly string[];
	readonly unstaged: readonly string[];
	readonly untracked: readonly string[];
	readonly ignored: readonly string[];
	readonly unmerged: readonly string[];
	readonly blockers: readonly string[];
};

export type Location =
	| { readonly kind: "outside" }
	| { readonly kind: "main" }
	| { readonly kind: "linked"; readonly repository: VcsGitRepo; readonly worktree: string; readonly mainDir: string };

type CheckResult = { readonly kind: "ok"; readonly check: WorktreeCheck } | { readonly kind: "error"; readonly reason: string };
type Recheck = { readonly kind: "ok"; readonly check: WorktreeCheck } | { readonly kind: "stop"; readonly why: string };
type PorcelainEntry = { readonly x: string; readonly y: string; readonly shown: string };

function porcelainEntries(raw: string): PorcelainEntry[] {
	const parts = raw.split("\0");
	const entries: PorcelainEntry[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined || part.length < 4) continue;
		const x = part.charAt(0);
		const file = part.slice(3);
		const shown = x === "R" || x === "C" ? `${parts[++i] ?? ""} -> ${file}` : file;
		entries.push({ x, y: part.charAt(1), shown });
	}
	return entries;
}

export async function uncommittedCount(repository: VcsGitRepo): Promise<number> {
	return porcelainEntries(await repository.statusPorcelain({ untracked: "all", nulTerminated: true })).length;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export const realpathOr = (dir: string): Promise<string> => fs.realpath(dir).catch(() => path.resolve(dir));

export async function locate(dir: string): Promise<Location> {
	const repository = vcs.git(dir);
	if (!repository) return { kind: "outside" };
	const linked = repository.linkedWorktree();
	if (!linked) return { kind: "main" };
	return { kind: "linked", repository, worktree: await realpathOr(linked.root), mainDir: await realpathOr(linked.primaryRoot) };
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	return result.stdout;
}

async function ignoredEntries(pi: ExtensionAPI, worktree: string): Promise<string[]> {
	const raw = await git(pi, worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
	return raw.split("\0").filter(Boolean);
}

async function fingerprint(worktree: SessionWorktree, ignored: readonly string[]): Promise<string> {
	const warnings: string[] = [];
	const plan = await planWorktreeExit(
		[worktree],
		"ask",
		async () => true,
		(message) => warnings.push(message),
	);
	const approved = plan[0]?.approvedFingerprint;
	if (approved === undefined) throw new Error(`could not inspect the worktree: ${warnings.join("; ") || "no snapshot"}`);
	return Bun.hash([worktree.path, worktree.branch, approved, ...ignored].join("\0")).toString(16);
}

async function blockersFor(ctx: ExtensionContext, worktree: string): Promise<string[]> {
	const blockers = (ctx.getAsyncJobSnapshot()?.running ?? []).map((job) => `background job ${job.id} still running: ${job.label}`);
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind !== "sub" || ref.sessionFile === null) continue;
		if (ref.status === "running") {
			blockers.push(`subagent ${ref.id} is running`);
			continue;
		}
		const cwd = ref.session?.sessionManager.getCwd();
		if (cwd !== undefined && isWithin(await realpathOr(cwd), worktree)) {
			blockers.push(`subagent ${ref.id} (${ref.status}) works in this worktree`);
		}
	}
	return blockers;
}

export async function inspect(pi: ExtensionAPI, ctx: ExtensionContext, dir: string): Promise<CheckResult> {
	try {
		const location = await locate(dir);
		if (location.kind !== "linked") {
			const reason =
				location.kind === "outside" ? `${dir} is not inside a git repository.` : `${dir} is the main checkout, not a linked worktree.`;
			return { kind: "error", reason };
		}
		const { repository, worktree, mainDir } = location;
		const branch = await repository.currentBranch();
		if (!branch) return { kind: "error", reason: `${worktree} has a detached HEAD; check out a branch first so no commit is lost.` };
		const tip = await repository.headSha();
		if (!tip) return { kind: "error", reason: `${worktree} has no commits.` };
		const mainHead = await vcs.requireGit(mainDir).headSha();
		if (!mainHead) return { kind: "error", reason: `the main checkout ${mainDir} has no commits.` };
		const record: SessionWorktree = { path: worktree, branch, sourceCwd: mainDir, baseCommit: tip, keptChanges: true };
		const before = await fingerprint(record, await ignoredEntries(pi, worktree));
		const staged: string[] = [];
		const unstaged: string[] = [];
		const untracked: string[] = [];
		for (const { x, y, shown } of porcelainEntries(await repository.statusPorcelain({ untracked: "all", nulTerminated: true }))) {
			if (x === "?") {
				untracked.push(shown);
				continue;
			}
			if (x !== " ") staged.push(`${x} ${shown}`);
			if (y !== " ") unstaged.push(`${y} ${shown}`);
		}
		const unmerged = (await git(pi, worktree, ["log", "--format=%h %s", `${mainHead}..${tip}`])).split("\n").filter(Boolean);
		const ignored = await ignoredEntries(pi, worktree);
		const after = await fingerprint(record, ignored);
		if (after !== before) return { kind: "error", reason: `${worktree} changed while it was being checked; check again.` };
		const blockers = await blockersFor(ctx, worktree);
		return {
			kind: "ok",
			check: { worktree, branch, mainDir, confirm: after, staged, unstaged, untracked, ignored, unmerged, blockers },
		};
	} catch (error) {
		return { kind: "error", reason: errorText(error) };
	}
}

export async function recheck(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	confirmed: Pick<WorktreeCheck, "worktree" | "confirm">,
): Promise<Recheck> {
	const current = await inspect(pi, ctx, confirmed.worktree);
	if (current.kind === "error") return { kind: "stop", why: current.reason };
	if (current.check.confirm !== confirmed.confirm) {
		return {
			kind: "stop",
			why: `the worktree changed since the check: ${CONFIRM_INVALIDATION}. Current state:\n${formatCheck(current.check)}`,
		};
	}
	if (current.check.blockers.length > 0) return { kind: "stop", why: `it is in use:\n${current.check.blockers.join("\n")}` };
	return { kind: "ok", check: current.check };
}

function listing(title: string, items: readonly string[]): string {
	if (items.length === 0) return `${title}: none`;
	const shownItems = items.slice(0, LIST_LIMIT).map((item) => `  ${item}`);
	const rest = items.length > LIST_LIMIT ? [`  … and ${items.length - LIST_LIMIT} more`] : [];
	return [`${title} (${items.length}):`, ...shownItems, ...rest].join("\n");
}

function verdict(check: WorktreeCheck): string {
	if (check.blockers.length > 0) return "BLOCKED: removal would be refused until the blockers below are gone.";
	const lost = check.staged.length + check.unstaged.length + check.untracked.length + check.ignored.length;
	if (lost > 0) return `UNSAFE: removal permanently deletes the ${lost} entr${lost === 1 ? "y" : "ies"} listed below.`;
	return "SAFE: no file in the worktree would be lost.";
}

export function formatCheck(check: WorktreeCheck): string {
	return [
		`Worktree: ${check.worktree}`,
		`Branch: ${check.branch} (kept)`,
		`Main checkout (the session moves here): ${check.mainDir}`,
		`Verdict: ${verdict(check)}`,
		listing("Blockers", check.blockers),
		listing("Staged changes (deleted)", check.staged),
		listing("Unstaged changes (deleted)", check.unstaged),
		listing("Untracked files (deleted)", check.untracked),
		listing("Ignored files and directories (deleted)", check.ignored),
		listing(`Commits on ${check.branch} not reachable from the main checkout's HEAD (kept on the branch)`, check.unmerged),
		`confirm: ${check.confirm}`,
	].join("\n");
}
