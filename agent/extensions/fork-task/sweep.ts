// Startup sweep of the per-process record directories. `replicas/<pid>/`,
// `overlays/<pid>/`, `parked/<pid>/` and `starts/<pid>/` belong to the OMP
// process with that pid; the main session removes its own roots at shutdown,
// so a directory whose pid names no live process is residue of a crash or kill
// that never reached session_shutdown. The main session sweeps those at startup
// (index.ts). Records of live processes are kept, and entries not named by a
// pid are left alone: their ownership cannot be decided by pid. Sweep failures
// warn; the session still starts.
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A directory name `String(process.pid)` produces for a real process. */
const PID_NAME = /^[1-9]\d*$/;

/** The process `pid` exists: signal 0 either succeeds or only lacks permission (EPERM). */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

/**
 * Removes every `<pid>` directory directly under each of `roots` whose pid names no live
 * process. Never rejects: a missing or unreadable root and each failed removal only warn.
 */
export async function sweepDeadProcessDirs(roots: readonly string[], warn: (message: string, error: unknown) => void): Promise<void> {
	for (const parent of roots) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(parent, { withFileTypes: true });
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			warn(`fork_task: listing ${parent} failed`, error);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !PID_NAME.test(entry.name)) continue;
			if (processAlive(Number(entry.name))) continue;
			await fs
				.rm(path.join(parent, entry.name), { recursive: true, force: true })
				.catch((error: unknown) => warn(`fork_task: removing records of dead process ${entry.name} failed`, error));
		}
	}
}
