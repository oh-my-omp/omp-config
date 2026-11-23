import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function errnoIs(error: unknown, ...codes: readonly string[]): boolean {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

export function lexists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

// Never write the contiguous marker literal here: the updater would then skip updating its own files.
const OTTY_MARKER = ["marker:", "_otty"].join(" ");

export function isAppManaged(path: string, strict = false): boolean {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (strict && !errnoIs(error, "ENOENT")) throw error;
		return false;
	}
	return text.split("\n", 1)[0]?.trim() === "// @orca-managed-pi-extension" || text.includes(OTTY_MARKER);
}

function writePath(target: string): string {
	let link = false;
	try {
		link = lstatSync(target).isSymbolicLink();
	} catch {}
	if (!link) return target;
	try {
		return realpathSync(target);
	} catch {
		return resolve(dirname(target), readlinkSync(target));
	}
}

export function atomicWrite(target: string, content: string | Uint8Array, mode?: number): void {
	const path = writePath(target);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.omp-config-update-${process.pid}.tmp`);
	try {
		writeFileSync(tmp, content);
		const keepMode = mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : undefined);
		if (keepMode !== undefined) chmodSync(tmp, keepMode);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}
