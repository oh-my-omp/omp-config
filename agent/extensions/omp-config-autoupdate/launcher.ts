import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { errorText } from "../_shared/errors.ts";
import { atomicWrite } from "./files.ts";
import type { ApplyOptions, ApplyReport } from "./report.ts";

export function installLauncher(opts: ApplyOptions, report: ApplyReport): void {
	const sourcePath = join(opts.source, "agent/omp-light.ts");
	if (!existsSync(sourcePath)) return;
	const found = Bun.which("omp");
	if (!found) {
		report.errors.push("omp-light not installed: omp is not on PATH");
		return;
	}
	const binDir = dirname(resolve(found));
	const script = readFileSync(sourcePath);
	const expected =
		process.platform === "win32"
			? installWindowsLauncher(opts, report, binDir, sourcePath, script)
			: installPosixLauncher(opts, report, binDir, script);
	const resolved = Bun.which("omp-light");
	if (!opts.check && resolved && resolve(resolved).toLowerCase() !== expected.toLowerCase()) {
		report.notes.push(`omp-light on PATH resolves to ${resolved}, not ${expected} (PATH shadowing)`);
	}
}

function installPosixLauncher(opts: ApplyOptions, report: ApplyReport, binDir: string, script: Buffer): string {
	const path = join(binDir, "omp-light");
	const same = existsSync(path) && Buffer.from(readFileSync(path)).equals(script) && (statSync(path).mode & 0o777) === 0o755;
	if (same) return path;
	if (opts.check) {
		report.written.push(path);
		return path;
	}
	try {
		atomicWrite(path, script, 0o755);
		report.written.push(path);
	} catch (error) {
		report.errors.push(`${path}: ${errorText(error)}`);
	}
	return path;
}

function installWindowsLauncher(opts: ApplyOptions, report: ApplyReport, binDir: string, sourcePath: string, script: Buffer): string {
	const source = join(binDir, "omp-light.ts");
	const executable = join(binDir, "omp-light.exe");
	const legacy = join(binDir, "omp-light.cmd");
	const current = existsSync(executable) && existsSync(source) && Buffer.from(readFileSync(source)).equals(script);
	if (opts.check) {
		if (!current) report.written.push(executable);
		if (existsSync(legacy)) report.deleted.push(legacy);
		return executable;
	}
	if (!current) {
		const bun = Bun.which("bun");
		if (!bun) {
			report.errors.push("omp-light not installed: bun is not on PATH to compile omp-light.exe");
			return executable;
		}
		try {
			const built = Bun.spawnSync([bun, "build", "--compile", sourcePath, "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
			if (built.exitCode !== 0) {
				report.errors.push(`${executable}: bun build --compile exited ${built.exitCode}: ${built.stderr.toString().trim()}`);
				return executable;
			}
			atomicWrite(source, script, undefined);
			report.written.push(executable);
		} catch (error) {
			report.errors.push(`${executable}: ${errorText(error)}`);
			return executable;
		}
	}
	if (existsSync(legacy)) {
		try {
			unlinkSync(legacy);
			report.deleted.push(legacy);
		} catch (error) {
			report.errors.push(`${legacy}: ${errorText(error)}`);
		}
	}
	return executable;
}
