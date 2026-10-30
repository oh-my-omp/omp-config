import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { errorText } from "../_shared/errors.ts";
import type { Target } from "./targets.ts";

/** `S_ISVTX`: the spec only trusts a shared `$topdir/.Trash` with the sticky bit set. */
const STICKY_BIT = 0o1000;

/** The platforms `delete` is registered on; any other platform registers no tool. */
export type Platform = "darwin" | "linux";

export const supportedPlatform = (platform: NodeJS.Platform): Platform | null =>
	platform === "darwin" || platform === "linux" ? platform : null;

export type Mode = "trash" | "permanent";

export type Outcome =
	| { readonly kind: "done"; readonly given: string; readonly note: string }
	| { readonly kind: "failed"; readonly given: string; readonly error: string };

const MAC_TRASH = "/usr/bin/trash";

/** Why the trash backend cannot run at all on this machine, checked before any path is touched. */
export function trashUnavailable(platform: Platform): string | null {
	switch (platform) {
		case "darwin":
			return existsSync(MAC_TRASH)
				? null
				: `${MAC_TRASH} is missing, so nothing can be moved to the Trash; use mode "permanent" to delete instead`;
		case "linux":
			return null;
		default: {
			const unreachable: never = platform;
			return unreachable;
		}
	}
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

/** The mount point holding `file`: the highest ancestor on the same device. */
function mountPoint(file: string): string {
	const device = lstatSync(file).dev;
	let current = path.dirname(file);
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current || statSync(parent).dev !== device) return current;
		current = parent;
	}
}

type TrashDir = { readonly dir: string; readonly topdir: string | null };

/** `$topdir/.Trash/$uid` when `$topdir/.Trash` is a real sticky directory, else `$topdir/.Trash-$uid`. */
function topdirTrash(topdir: string): TrashDir {
	const uid = process.getuid?.() ?? 0;
	const shared = path.join(topdir, ".Trash");
	try {
		const info = lstatSync(shared);
		if (info.isDirectory() && (info.mode & STICKY_BIT) !== 0) return { dir: path.join(shared, String(uid)), topdir };
	} catch {
		// No shared .Trash on this mount: use the per-user directory.
	}
	return { dir: path.join(topdir, `.Trash-${uid}`), topdir };
}

function trashDirFor(operand: string): TrashDir {
	const home = homeTrashDir();
	if (statSync(existingAncestor(home)).dev === lstatSync(operand).dev) return { dir: home, topdir: null };
	return topdirTrash(mountPoint(operand));
}

/** RFC 2396 escaping per path segment, `/` kept, as the spec's `Path=` key requires. */
const encodeTrashPath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

const pad = (value: number): string => String(value).padStart(2, "0");

const deletionDate = (now: Date): string =>
	`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

/** Claims a free name by creating `info/<name>.trashinfo` exclusively; a taken name becomes `<name>.2`, `<name>.3`, … */
function claimInfo(infoDir: string, base: string, body: string): { readonly name: string; readonly infoPath: string } {
	for (let attempt = 1; ; attempt++) {
		const name = attempt === 1 ? base : `${base}.${attempt}`;
		const infoPath = path.join(infoDir, `${name}.trashinfo`);
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
		const trash = trashDirFor(target.operand);
		const filesDir = path.join(trash.dir, "files");
		const infoDir = path.join(trash.dir, "info");
		mkdirSync(filesDir, { recursive: true, mode: 0o700 });
		mkdirSync(infoDir, { recursive: true, mode: 0o700 });
		const recorded = trash.topdir === null ? target.operand : path.relative(trash.topdir, target.operand);
		const body = `[Trash Info]\nPath=${encodeTrashPath(recorded)}\nDeletionDate=${deletionDate(new Date())}\n`;
		const { name, infoPath } = claimInfo(infoDir, path.basename(target.operand), body);
		const destination = path.join(filesDir, name);
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

/** Runs validated targets in order; a failure on one path leaves the others' results as they are. */
export async function runDeletion(platform: Platform, mode: Mode, targets: readonly Target[]): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (const target of targets) {
		switch (mode) {
			case "permanent":
				outcomes.push(permanent(target));
				break;
			case "trash":
				switch (platform) {
					case "darwin":
						outcomes.push(await macTrash(target));
						break;
					case "linux":
						outcomes.push(linuxTrash(target));
						break;
					default: {
						const unreachable: never = platform;
						return unreachable;
					}
				}
				break;
			default: {
				const unreachable: never = mode;
				return unreachable;
			}
		}
	}
	return outcomes;
}
