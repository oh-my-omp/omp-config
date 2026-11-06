// `workspace: "source"`: a fork starts from the uncommitted changes its source
// made in its own isolated workspace. OMP keeps an isolated run's baseline only
// inside its runner, so every isolated subagent records its own start
// (`recordStart`, at its first turn, when its workspace still equals OMP's
// baseline); a fork diffs the source's workspace against that record, and its
// child applies the diff before its first turn, after OMP captured the child's
// baseline, so the inherited changes are handed back with the child's own.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { hasLiveIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import {
	captureDeltaPatch,
	captureIsolationBaseline,
	type DeltaPatchResult,
	getRepoRoot,
	taskIsolationBaseDir,
	type WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import { errorText } from "../_shared/errors.ts";
import { readOptional, STAGING_ROOT } from "./replica-file.ts";

export type RejectionCode =
	| "child-not-isolated"
	| "source-not-isolated"
	| "source-running"
	| "source-handed-back"
	| "nested-repo"
	| "overlay-conflict";

export const rejection = (code: RejectionCode, detail: string): string => `workspace "source" rejected (${code}): ${detail}`;

/** What a `workspace: "source"` fork inherits, or why it is refused. */
export type Inheritance =
	| { readonly kind: "inherit"; readonly patch: string }
	| { readonly kind: "rejected"; readonly code: RejectionCode; readonly detail: string };

/** The source as the registry and its transcript describe it at fork time. */
export type InheritSource = {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly running: boolean;
	/** OMP captured this run's changes into a patch or branch for its parent. */
	readonly handedBack: boolean;
};

type Isolation = { readonly kind: "isolated"; readonly root: string; readonly parentRoot: string } | { readonly kind: "shared" };

const repoBaselineSchema = z.object({
	repoRoot: z.string(),
	headCommit: z.string(),
	staged: z.string(),
	unstaged: z.string(),
	untracked: z.array(z.string()),
	untrackedPatch: z.string(),
});

const baselineSchema = z.object({
	root: repoBaselineSchema,
	nested: z.array(z.object({ relativePath: z.string(), baseline: repoBaselineSchema })),
});

const headerSchema = z.object({ type: z.literal("session"), cwd: z.string() }).passthrough();

/** This OMP process's start records, shared by its main and worker threads. */
export function startsRoot(): string {
	return path.join(STAGING_ROOT, "starts", String(process.pid));
}

/** The start record of the session at `sessionFile`: written by `recordStart`, read by `inheritSourceWorkspace`. */
function startFilePath(sessionFile: string): string {
	return path.join(startsRoot(), `${createHash("sha256").update(sessionFile).digest("hex")}.json`);
}

/** Where the parent's spawn hook leaves the changes the child at `childFile` inherits; the same path in every thread. */
export function overlayFilePath(childFile: string): string {
	return path.join(STAGING_ROOT, "overlays", `${createHash("sha256").update(childFile).digest("hex")}.patch`);
}

/**
 * The cwd in the `session` header of the transcript at `sessionFile`, if it exists. OMP may write
 * other records (a padded `title` line) before the header, so lines are read until it appears.
 */
async function headerCwd(sessionFile: string): Promise<string | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(sessionFile);
	} catch {
		// No such transcript: the session has no persisted parent.
		return undefined;
	}
	try {
		for await (const line of handle.readLines()) {
			if (!line.trim()) continue;
			const header = headerSchema.safeParse(JSON.parse(line));
			if (header.success) return header.data.cwd;
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

/**
 * Whether the subagent `id` whose transcript is `sessionFile` runs in an
 * isolated workspace of its own: OMP places a task child's transcript at
 * `<parent transcript minus .jsonl>/<id>.jsonl` and its isolation under
 * `taskIsolationBaseDir(<parent repo root>, id)`, marked by a live owner.
 */
async function isolationOf(sessionFile: string, cwd: string, id: string): Promise<Isolation> {
	const parentCwd = await headerCwd(`${path.dirname(sessionFile)}.jsonl`);
	if (parentCwd === undefined) return { kind: "shared" };
	let parentRoot: string;
	let root: string;
	try {
		parentRoot = await getRepoRoot(parentCwd);
		root = await getRepoRoot(cwd);
	} catch {
		// Not a git checkout: OMP isolates only git checkouts.
		return { kind: "shared" };
	}
	if (path.resolve(root) === path.resolve(parentRoot)) return { kind: "shared" };
	if (!(await hasLiveIsolationOwner(taskIsolationBaseDir(parentRoot, id)))) return { kind: "shared" };
	return { kind: "isolated", root, parentRoot };
}

/**
 * Record the start of an isolated subagent's workspace, once per session file
 * and process. Called at the session's first turn, before an inherited
 * overlay is applied, so the record equals OMP's own baseline of the run.
 */
export async function recordStart(sessionFile: string, cwd: string, id: string): Promise<void> {
	const file = startFilePath(sessionFile);
	if ((await readOptional(file)) !== undefined) return;
	const isolation = await isolationOf(sessionFile, cwd, id);
	if (isolation.kind === "shared") return;
	const baseline: WorktreeBaseline = await captureIsolationBaseline(isolation.root, isolation.parentRoot);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(baseline));
}

type GitApply = { readonly kind: "ok" } | { readonly kind: "failed"; readonly message: string };

async function gitApply(root: string, patch: string, check: boolean): Promise<GitApply> {
	const child = Bun.spawn(["git", "-C", root, "apply", ...(check ? ["--check"] : []), "-"], {
		stdin: Buffer.from(patch),
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return code === 0 ? { kind: "ok" } : { kind: "failed", message: stderr.trim() || `git apply exited with ${code}` };
}

/**
 * Decide what a fork of `source` inherits into an isolated copy of the
 * caller's checkout at `callerCwd`. Checks run in the order of the codes'
 * table in the fork_task docs; the source's workspace is only read.
 */
export async function inheritSourceWorkspace(source: InheritSource, callerCwd: string): Promise<Inheritance> {
	const rejected = (code: RejectionCode, detail: string): Inheritance => ({ kind: "rejected", code, detail });
	if (source.running) return rejected("source-running", `agent \`${source.id}\` is still running; fork it once it stopped.`);
	if (source.handedBack)
		return rejected(
			"source-handed-back",
			`agent \`${source.id}\` already handed this run's changes back; they are in your checkout or its task branch.`,
		);
	if ((await isolationOf(source.file, source.cwd, source.id)).kind === "shared")
		return rejected("source-not-isolated", `agent \`${source.id}\` has no isolated workspace of its own.`);
	const recorded = await readOptional(startFilePath(source.file));
	if (recorded === undefined)
		return rejected(
			"overlay-conflict",
			`no start of agent \`${source.id}\`'s workspace was recorded in this OMP process, so its changes cannot be read.`,
		);
	let delta: DeltaPatchResult;
	try {
		const sourceRoot = await getRepoRoot(source.cwd);
		delta = await captureDeltaPatch(sourceRoot, baselineSchema.parse(JSON.parse(recorded)));
	} catch (error) {
		return rejected("overlay-conflict", `reading agent \`${source.id}\`'s changes failed: ${errorText(error)}`);
	}
	if (delta.nestedPatches.length > 0) {
		const repos = delta.nestedPatches.map((nested) => `\`${nested.relativePath}\``).join(", ");
		return rejected("nested-repo", `agent \`${source.id}\` changed nested repositories (${repos}), which a fork does not inherit.`);
	}
	if (!delta.rootPatch.trim()) return { kind: "inherit", patch: "" };
	let callerRoot: string;
	try {
		callerRoot = await getRepoRoot(callerCwd);
	} catch (error) {
		return rejected("overlay-conflict", `your workspace is not a git checkout: ${errorText(error)}`);
	}
	const check = await gitApply(callerRoot, delta.rootPatch, true);
	if (check.kind === "failed")
		return rejected("overlay-conflict", `agent \`${source.id}\`'s changes do not apply to your checkout: ${check.message}`);
	return { kind: "inherit", patch: delta.rootPatch };
}

export type OverlayResult =
	| { readonly kind: "none" }
	| { readonly kind: "applied" }
	| { readonly kind: "failed"; readonly message: string };

/** Apply the changes the child at `childFile` inherits, once: the overlay file is consumed. */
export async function applyOverlay(childFile: string, cwd: string): Promise<OverlayResult> {
	const file = overlayFilePath(childFile);
	const patch = await readOptional(file);
	if (patch === undefined) return { kind: "none" };
	await fs.rm(file, { force: true });
	let root: string;
	try {
		root = await getRepoRoot(cwd);
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}
	const applied = await gitApply(root, patch, false);
	return applied.kind === "ok" ? { kind: "applied" } : { kind: "failed", message: applied.message };
}

export async function writeOverlay(childFile: string, patch: string): Promise<void> {
	const file = overlayFilePath(childFile);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, patch);
}
