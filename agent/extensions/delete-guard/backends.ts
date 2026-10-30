import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { errorText } from "../_shared/errors.ts";
import type { Target } from "./targets.ts";

/** `S_ISVTX`: the spec only trusts a shared `$topdir/.Trash` with the sticky bit set. */
const STICKY_BIT = 0o1000;

/** The platforms `delete` is registered on; any other platform registers no tool. */
export type Platform = "darwin" | "linux" | "win32";

export const supportedPlatform = (platform: NodeJS.Platform): Platform | null =>
	platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;

export type Mode = "trash" | "permanent";

export type Outcome =
	| { readonly kind: "done"; readonly given: string; readonly note: string }
	| { readonly kind: "failed"; readonly given: string; readonly error: string };

const MAC_TRASH = "/usr/bin/trash";

/** `powershell.exe` by absolute path under `SystemRoot`, never a bare name the cwd could shadow. */
function windowsPowershell(): string | null {
	const root = process.env.SystemRoot ?? process.env.windir;
	if (root === undefined) return null;
	const exe = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(exe) ? exe : null;
}

/**
 * Sends `$env:OMP_DELETE_TARGET` (a file or a directory, per `$env:OMP_DELETE_KIND`) to the Recycle Bin. The
 * path is never part of the script text. UNC paths and non-fixed drives have no Recycle Bin, where
 * `SendToRecycleBin` would delete permanently, so the script refuses them.
 */
const RECYCLE_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName Microsoft.VisualBasic",
	"$target = $env:OMP_DELETE_TARGET",
	"$root = [System.IO.Path]::GetPathRoot($target)",
	"if ($root.StartsWith('\\\\') -or ([System.IO.DriveInfo]::new($root).DriveType -ne [System.IO.DriveType]::Fixed)) { throw 'this drive has no Recycle Bin; use mode permanent to delete' }",
	"$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs",
	"$recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin",
	"if ($env:OMP_DELETE_KIND -eq 'directory') { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, $ui, $recycle) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, $ui, $recycle) }",
].join("; ");

/** Why the trash backend cannot run at all on this machine, checked before any path is touched. */
export function trashUnavailable(platform: Platform): string | null {
	switch (platform) {
		case "darwin":
			return existsSync(MAC_TRASH)
				? null
				: `${MAC_TRASH} is missing, so nothing can be moved to the Trash; use mode "permanent" to delete instead`;
		case "linux":
			return null;
		case "win32":
			return windowsPowershell() === null
				? 'powershell.exe was not found under %SystemRoot%\\System32, so nothing can be moved to the Recycle Bin; use mode "permanent" to delete instead'
				: null;
		default: {
			const unreachable: never = platform;
			return unreachable;
		}
	}
}

async function windowsTrash(target: Target): Promise<Outcome> {
	if (target.kind === "link") {
		return {
			kind: "failed",
			given: target.given,
			error:
				'symbolic links and junctions are not sent to the Recycle Bin (it could follow them); use mode "permanent" to remove the link itself',
		};
	}
	const exe = windowsPowershell();
	if (exe === null) return { kind: "failed", given: target.given, error: "powershell.exe is missing" };
	const child = Bun.spawn([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RECYCLE_SCRIPT], {
		env: { ...process.env, OMP_DELETE_TARGET: target.operand, OMP_DELETE_KIND: target.kind },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) return { kind: "failed", given: target.given, error: `powershell exited ${code}: ${`${stderr}\n${stdout}`.trim()}` };
	return { kind: "done", given: target.given, note: "moved to the Recycle Bin" };
}

/** `/usr/bin/trash -v` reports `Moved "<src>" to "<dest>"`; the path is passed as argv, never through a shell. */
async function macTrash(target: Target): Promise<Outcome> {
	const child = Bun.spawn([MAC_TRASH, "-v", target.operand], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	const report = `${stdout}\n${stderr}`;
	if (code !== 0) return { kind: "failed", given: target.given, error: `${MAC_TRASH} exited ${code}: ${report.trim()}` };
	const moved = report.split("\n").find((line) => line.includes("Moved "));
	const marker = moved?.lastIndexOf('" to "') ?? -1;
	const destination = moved !== undefined && marker >= 0 ? moved.slice(marker + 6).replace(/"\s*$/, "") : "the Trash";
	return { kind: "done", given: target.given, note: `moved to ${destination}` };
}

/** freedesktop.org Trash spec: `$XDG_DATA_HOME/Trash`, or `~/.local/share/Trash`. */
function homeTrashDir(): string {
	const dataHome = process.env.XDG_DATA_HOME;
	return path.join(dataHome !== undefined && path.isAbsolute(dataHome) ? dataHome : path.join(homedir(), ".local", "share"), "Trash");
}

/** The nearest existing directory at or above `dir`, for device comparison. */
function existingAncestor(dir: string): string {
	let current = dir;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}

/** The mount point holding `located` (a real path): the highest ancestor on the same device. */
function mountPoint(located: string): string {
	const device = lstatSync(located).dev;
	let current = path.dirname(located);
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current || statSync(parent).dev !== device) return current;
		current = parent;
	}
}

/** A trash directory; `topdir` is null for the home trash, which records absolute paths. */
type TrashDir = { readonly dir: string; readonly topdir: string | null };

/**
 * The spec's top-directory trashes in order: `$topdir/.Trash/$uid` when `$topdir/.Trash` is a real sticky
 * directory, then `$topdir/.Trash-$uid`, which the spec requires as the fallback when the first cannot be used.
 */
function topdirTrashes(topdir: string): readonly TrashDir[] {
	const uid = process.getuid?.() ?? 0;
	const shared = path.join(topdir, ".Trash");
	const own: TrashDir = { dir: path.join(topdir, `.Trash-${uid}`), topdir };
	try {
		const info = lstatSync(shared);
		if (info.isDirectory() && (info.mode & STICKY_BIT) !== 0) return [{ dir: path.join(shared, String(uid)), topdir }, own];
	} catch {
		// No shared .Trash on this mount: use the per-user directory.
	}
	return [own];
}

/**
 * Candidate trashes for `located`, the operand with its parent directory's links resolved (the entry itself is not
 * followed), so the mount and the recorded relative path describe where the entry really is.
 */
function trashesFor(located: string): readonly TrashDir[] {
	const home = homeTrashDir();
	if (statSync(existingAncestor(home)).dev === lstatSync(located).dev) return [{ dir: home, topdir: null }];
	return topdirTrashes(mountPoint(located));
}

/** Creates `files/` and `info/` of the first candidate that allows it; the last candidate's error is rethrown. */
function prepareTrash(candidates: readonly TrashDir[]): TrashDir {
	let failure: unknown = new Error("no trash directory");
	for (const candidate of candidates) {
		try {
			mkdirSync(path.join(candidate.dir, "files"), { recursive: true, mode: 0o700 });
			mkdirSync(path.join(candidate.dir, "info"), { recursive: true, mode: 0o700 });
			return candidate;
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}

/** RFC 2396 escaping per path segment, `/` kept, as the spec's `Path=` key requires. */
const encodeTrashPath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

const pad = (value: number): string => String(value).padStart(2, "0");

const deletionDate = (now: Date): string =>
	`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

/** Whether anything, a dangling link included, already sits at `file`. */
function occupied(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		// Nothing there.
		return false;
	}
}

/**
 * Claims a free name: `files/<name>` must be empty (a payload whose info file was lost is never overwritten) and
 * `info/<name>.trashinfo` is created exclusively; a taken name becomes `<name>.2`, `<name>.3`, …
 */
function claimInfo(trashDir: string, base: string, body: string): { readonly name: string; readonly infoPath: string } {
	for (let attempt = 1; ; attempt++) {
		const name = attempt === 1 ? base : `${base}.${attempt}`;
		if (occupied(path.join(trashDir, "files", name))) continue;
		const infoPath = path.join(trashDir, "info", `${name}.trashinfo`);
		let fd: number;
		try {
			fd = openSync(infoPath, "wx", 0o600);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
		try {
			writeSync(fd, body);
		} finally {
			closeSync(fd);
		}
		return { name, infoPath };
	}
}

function linuxTrash(target: Target): Outcome {
	try {
		const located = path.join(realpathSync(path.dirname(target.operand)), path.basename(target.operand));
		const trash = prepareTrash(trashesFor(located));
		const recorded = trash.topdir === null ? target.operand : path.relative(trash.topdir, located);
		const body = `[Trash Info]\nPath=${encodeTrashPath(recorded)}\nDeletionDate=${deletionDate(new Date())}\n`;
		const { name, infoPath } = claimInfo(trash.dir, path.basename(target.operand), body);
		const destination = path.join(trash.dir, "files", name);
		try {
			renameSync(target.operand, destination);
		} catch (error) {
			unlinkSync(infoPath);
			throw error;
		}
		return { kind: "done", given: target.given, note: `moved to ${destination}` };
	} catch (error) {
		return { kind: "failed", given: target.given, error: errorText(error) };
	}
}

function permanent(target: Target): Outcome {
	try {
		rmSync(target.operand, { recursive: true, force: false });
		return { kind: "done", given: target.given, note: "deleted permanently" };
	} catch (error) {
		return { kind: "failed", given: target.given, error: errorText(error) };
	}
}

function trashOne(platform: Platform, target: Target): Promise<Outcome> | Outcome {
	switch (platform) {
		case "darwin":
			return macTrash(target);
		case "linux":
			return linuxTrash(target);
		case "win32":
			return windowsTrash(target);
		default: {
			const unreachable: never = platform;
			return unreachable;
		}
	}
}

/**
 * Runs validated targets in order; a failure on one path, a backend that throws included, becomes that path's
 * `failed` outcome and leaves the others' results as they are.
 */
export async function runDeletion(platform: Platform, mode: Mode, targets: readonly Target[]): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (const target of targets) {
		try {
			switch (mode) {
				case "permanent":
					outcomes.push(permanent(target));
					break;
				case "trash":
					outcomes.push(await trashOne(platform, target));
					break;
				default: {
					const unreachable: never = mode;
					return unreachable;
				}
			}
		} catch (error) {
			outcomes.push({ kind: "failed", given: target.given, error: errorText(error) });
		}
	}
	return outcomes;
}
