// Steps of the delete-guard Windows acceptance run (omp-config #69 rows 1-5,
// 7, 8). Each step prepares the probe files, gives the model one prompt asking
// for one tool call, and checks that call and the files afterwards.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ToolCall = {
	readonly tool: string;
	readonly args: { readonly [key: string]: unknown };
	readonly isError: boolean;
	readonly text: string;
};

export type Session = {
	readonly calls: readonly ToolCall[];
	/** The assistant's last text reply, printed when a step fails. */
	readonly reply: string;
	readonly finished: boolean;
	readonly code: number | null;
	readonly stderr: string;
};

export type Step = {
	readonly name: string;
	readonly prompt: string;
	readonly prepare: () => void;
	readonly check: (session: Session) => readonly string[];
	readonly readings: () => readonly string[];
};

const ROOT = "C:\\omp-dg";
const D = join(ROOT, "d");
const PROBE = join(D, "f");
const P = join(ROOT, "p");
const KEEP = join(ROOT, "keep");

function ensureFile(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "f"), "probe");
}

/** Names in the current user's Recycle Bin, or null when the runner account has none. */
function recycleBinNames(): readonly string[] | null {
	const script =
		"$ns = (New-Object -ComObject Shell.Application).NameSpace(10); if ($null -eq $ns) { 'NO_RECYCLE_BIN' } else { $ns.Items() | ForEach-Object { $_.Name } }";
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
	const names = (result.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return names.includes("NO_RECYCLE_BIN") ? null : names;
}

/**
 * The prompt says what the run is: the deletion guard is expected to refuse most of these calls and the paths are
 * throwaway probes, so a model has no reason to decline the call or rewrite it.
 */
const once = (tool: string, body: string): string =>
	`This is an automated acceptance test of a deletion guard on a throwaway CI runner; everything under C:\\omp-dg is a disposable probe, and the guard is expected to refuse most of these calls. Make exactly one ${tool} tool call with the input below, unchanged, then reply with the tool's result text. Do not call any other tool and do not retry.\n\n${body}`;

/** The first call of `tool`, or the reason the step cannot judge the guard (#69 row 8). */
function firstCall(session: Session, tool: string): ToolCall | string {
	return session.calls.find((call) => call.tool === tool) ?? `model did not call ${tool}`;
}

function probeKept(): readonly string[] {
	return existsSync(PROBE) ? [] : [`${PROBE} is gone`];
}

function blockedBash(command: string): Step {
	return {
		name: `bash: ${command}`,
		prompt: once("bash", `command:\n${command}`),
		prepare: () => ensureFile(D),
		check: (session) => {
			const call = firstCall(session, "bash");
			if (typeof call === "string") return [call];
			const failures: string[] = [];
			if (call.args.command !== command) failures.push(`model changed the command to ${JSON.stringify(call.args.command)}`);
			if (!call.isError || !call.text.startsWith("delete-guard:")) failures.push(`not blocked: ${call.text}`);
			return [...failures, ...probeKept()];
		},
		readings: () => [`Test-Path ${PROBE}: ${existsSync(PROBE)}`],
	};
}

function blockedEval(language: "py" | "js", code: string): Step {
	return {
		name: `eval ${language}: ${code}`,
		prompt: once("eval", `language: ${language}\ncode:\n${code}`),
		prepare: () => ensureFile(D),
		check: (session) => {
			const call = firstCall(session, "eval");
			if (typeof call === "string") return [call];
			const failures: string[] = [];
			if (call.args.code !== code || call.args.language !== language)
				failures.push(`model changed the cell to ${JSON.stringify(call.args)}`);
			if (!call.isError || !call.text.includes("delete-guard:")) failures.push(`not blocked: ${call.text}`);
			return [...failures, ...probeKept()];
		},
		readings: () => [`Test-Path ${PROBE}: ${existsSync(PROBE)}`],
	};
}

function deleteRequest(paths: readonly string[], mode: "trash" | "permanent"): string {
	return once("delete", `paths: ${JSON.stringify(paths)}\nmode: ${mode}`);
}

/** The model must pass exactly the requested paths and mode, or the step says nothing about batch validation. */
function deleteInputChanged(call: ToolCall, paths: readonly string[], mode: "trash" | "permanent"): readonly string[] {
	const given = JSON.stringify(call.args.paths);
	const givenMode = call.args.mode ?? "trash";
	return given === JSON.stringify(paths) && givenMode === mode
		? []
		: [`model changed the input to paths ${given}, mode ${JSON.stringify(givenMode)}`];
}

function deleted(dir: string, mode: "trash" | "permanent"): Step {
	return {
		name: `delete (${mode}) ${dir}`,
		prompt: deleteRequest([dir], mode),
		prepare: () => ensureFile(dir),
		check: (session) => {
			const call = firstCall(session, "delete");
			if (typeof call === "string") return [call];
			const failures: string[] = [...deleteInputChanged(call, [dir], mode)];
			if (call.isError) failures.push(`delete failed: ${call.text}`);
			if (existsSync(dir)) failures.push(`${dir} still exists`);
			const names = recycleBinNames();
			const name = dir.slice(dir.lastIndexOf("\\") + 1);
			if (names === null) failures.push("no recycle bin on runner");
			else if (mode === "trash" && !names.includes(name)) failures.push(`Recycle Bin does not list ${name}`);
			else if (mode === "permanent" && names.includes(name)) failures.push(`Recycle Bin lists ${name}`);
			return failures;
		},
		readings: () => [`Test-Path ${dir}: ${existsSync(dir)}`, `Recycle Bin: ${JSON.stringify(recycleBinNames())}`],
	};
}

function refused(danger: string): Step {
	return {
		name: `delete refuses ${danger}`,
		prompt: deleteRequest([KEEP, danger], "trash"),
		prepare: () => ensureFile(KEEP),
		check: (session) => {
			const call = firstCall(session, "delete");
			if (typeof call === "string") return [call];
			const failures: string[] = [...deleteInputChanged(call, [KEEP, danger], "trash")];
			if (!call.isError || !call.text.includes(JSON.stringify(danger))) failures.push(`not refused by name: ${call.text}`);
			if (!existsSync(KEEP)) failures.push(`${KEEP} is gone`);
			return failures;
		},
		readings: () => [`Test-Path ${KEEP}: ${existsSync(KEEP)}`],
	};
}

export function steps(cwd: string): readonly Step[] {
	const home = process.env.USERPROFILE ?? "";
	return [
		// Row 1: nested PowerShell and cmd from brush.
		blockedBash(String.raw`powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\omp-dg\d"`),
		blockedBash(String.raw`pwsh -c "ri C:\omp-dg\d -r"`),
		blockedBash(String.raw`pwsh -c "[IO.Directory]::Delete('C:\omp-dg\d', $true)"`),
		blockedBash(`powershell -Command "$p='x'; iex $p"`),
		blockedBash("pwsh -EncodedCommand ZABpAHIA"),
		blockedBash(String.raw`cmd /c rd /s /q C:\omp-dg\d`),
		blockedBash(String.raw`cmd /c "for %f in (C:\omp-dg\d\*) do del %f"`),
		// Row 2: eval handing commands to cmd (and Bun.$ to brush).
		blockedEval("py", String.raw`import subprocess; subprocess.run(r"del /q C:\omp-dg\d\f", shell=True)`),
		blockedEval("py", String.raw`import os; os.system(r"rd /s /q C:\omp-dg\d")`),
		blockedEval("js", String.raw`require("child_process").execSync("del /q C:\\omp-dg\\d\\f")`),
		blockedEval("js", "await Bun.$`rm C:/omp-dg/d/f`"),
		// Row 5: brush's own posix commands.
		blockedBash("rm -rf C:/omp-dg/d"),
		// Rows 3 and 7: the Recycle Bin backend and permanent mode.
		deleted(D, "trash"),
		deleted(P, "permanent"),
		// Row 4: Windows roots, the home directory and the session cwd.
		...["C:\\", "C:", "\\", "\\\\localhost\\C$", home, cwd].map(refused),
	];
}
