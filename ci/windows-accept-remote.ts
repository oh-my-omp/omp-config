#!/usr/bin/env bun
// windows-accept, runner side (omp-config #311). Runs in the `windows-accept`
// workflow on a throwaway `windows-latest` runner: installs the latest omp,
// binds every model role (windows-env.ts), checks each requested repository out
// under `%RUNNER_TEMP%\src\<repo>` at its commit (with `bun install` where it
// has a package.json), then runs the given Bun script with cwd and `SRC` set to
// that directory and a PATH reduced to what a default Windows install has: of
// Git for Windows only `Git\cmd`. Design: ci/README.md.
//
// Input (environment): WA_CHECKOUTS, newline-separated `owner/repo@<full sha>`;
// WA_SCRIPT, the script text (empty: only set up and report the environment,
// the pull_request self-check). OPENCODE_API_KEY reaches the script unchanged.
//
// Output: setup readings, then the script's own stdout/stderr between
// SCRIPT_BEGIN and the `windows-accept: script exit <n>` line that the local
// side (windows-accept.ts) parses. Exit: the script's exit code; 1 when setup
// fails before the script runs (no exit line is printed then).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bindModelRoles } from "./windows-env.ts";

const SETUP_TIMEOUT_MS = 900_000;
const SCRIPT_BEGIN = "windows-accept: script begin";
const EXIT_LINE = "windows-accept: script exit";

type Checkout = { readonly owner: string; readonly repo: string; readonly sha: string };
type Setup = { readonly kind: "ready"; readonly path: string } | { readonly kind: "failed"; readonly reason: string };

function run(command: readonly string[], cwd: string): { code: number | null; out: string } {
	const [program, ...args] = command;
	if (program === undefined) throw new Error("run: empty command");
	const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: SETUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
	return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}` };
}

function parseCheckouts(text: string): Checkout[] | string {
	const checkouts: Checkout[] = [];
	for (const line of text.split(/\r?\n/).map((entry) => entry.trim())) {
		if (line === "") continue;
		const match = /^([\w.-]+)\/([\w.-]+)@([0-9a-f]{40})$/.exec(line);
		if (match === null) return `invalid checkout ${JSON.stringify(line)}: expected owner/repo@<40-hex sha>`;
		checkouts.push({ owner: match[1] ?? "", repo: match[2] ?? "", sha: match[3] ?? "" });
	}
	return checkouts;
}

/**
 * The PATH a default Git for Windows install leaves: every entry inside the Git install root is dropped except
 * `<root>\cmd`, so `git.exe` stays and `sh`, `env`, `ps` and the rest of its POSIX userland go.
 */
function defaultUserPath(path: string): string | undefined {
	const entries = path.split(";").filter((entry) => entry !== "");
	const gitCmd = entries.find((entry) => /[\\/]Git[\\/]cmd[\\/]?$/i.test(entry));
	if (gitCmd === undefined) return undefined;
	const root = `${dirname(gitCmd.replace(/[\\/]+$/, "")).toLowerCase()}\\`;
	return entries.filter((entry) => entry === gitCmd || !`${entry.toLowerCase().replaceAll("/", "\\")}\\`.startsWith(root)).join(";");
}

function setup(src: string, checkouts: readonly Checkout[]): Setup {
	const install = run(["bun", "install", "-g", "@oh-my-pi/pi-coding-agent@latest"], src);
	if (install.code !== 0) return { kind: "failed", reason: `bun install -g exited ${install.code}: ${install.out}` };
	const version = run(["omp", "--version"], src);
	if (version.code !== 0) return { kind: "failed", reason: `omp --version exited ${version.code}: ${version.out}` };
	console.log(`omp ${version.out.trim()}`);
	bindModelRoles(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"));
	for (const { owner, repo, sha } of checkouts) {
		const dir = join(src, repo);
		const clone = run(["git", "clone", "--quiet", `https://github.com/${owner}/${repo}.git`, dir], src);
		if (clone.code !== 0) return { kind: "failed", reason: `git clone ${owner}/${repo} exited ${clone.code}: ${clone.out}` };
		const checkout = run(["git", "-C", dir, "checkout", "--quiet", "--detach", sha], src);
		if (checkout.code !== 0)
			return { kind: "failed", reason: `git checkout ${owner}/${repo}@${sha} exited ${checkout.code}: ${checkout.out}` };
		if (existsSync(join(dir, "package.json"))) {
			const deps = run(["bun", "install"], dir);
			if (deps.code !== 0) return { kind: "failed", reason: `bun install in ${repo} exited ${deps.code}: ${deps.out}` };
		}
		console.log(`checkout ${owner}/${repo} ${sha} -> ${dir}`);
	}
	const path = defaultUserPath(process.env.PATH ?? "");
	if (path === undefined) return { kind: "failed", reason: "no Git\\cmd entry on PATH" };
	const found = Object.fromEntries(["sh", "env", "ps", "git"].map((name) => [name, Bun.which(name, { PATH: path })]));
	console.log(`PATH programs: ${JSON.stringify(found)}`);
	const posix = ["sh", "env", "ps"].filter((name) => found[name] !== null);
	if (posix.length > 0) return { kind: "failed", reason: `the reduced PATH still provides ${posix.join(", ")}` };
	if (!/[\\/]Git[\\/]cmd[\\/]git\.exe$/i.test(found.git ?? ""))
		return { kind: "failed", reason: `git resolves to ${found.git}, not Git\\cmd\\git.exe` };
	return { kind: "ready", path };
}

/** The process environment with PATH replaced; Windows environment names are case-insensitive. */
function envWith(path: string, src: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name.toUpperCase() !== "PATH") env[name] = value;
	return { ...env, PATH: path, SRC: src };
}

function main(): number {
	if (process.platform !== "win32") {
		console.error("windows-accept: runs on Windows only");
		return 1;
	}
	const checkouts = parseCheckouts(process.env.WA_CHECKOUTS ?? "");
	if (typeof checkouts === "string") {
		console.error(`windows-accept: ${checkouts}`);
		return 1;
	}
	const temp = process.env.RUNNER_TEMP ?? homedir();
	const src = join(temp, "src");
	mkdirSync(src, { recursive: true });
	const ready = setup(src, checkouts);
	if (ready.kind === "failed") {
		console.error(`windows-accept: setup failed: ${ready.reason}`);
		return 1;
	}
	const script = process.env.WA_SCRIPT ?? "";
	if (script.trim() === "") {
		console.log("windows-accept: no script given; environment ready");
		return 0;
	}
	const scriptPath = join(temp, "windows-accept", "script.ts");
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(scriptPath, script);
	console.log(SCRIPT_BEGIN);
	const result = spawnSync(process.execPath, [scriptPath], { cwd: src, env: envWith(ready.path, src), stdio: "inherit" });
	const code = result.status ?? 1;
	if (result.error) console.error(`windows-accept: ${basename(process.execPath)} ${result.error.message}`);
	console.log(`${EXIT_LINE} ${code}`);
	return code;
}

process.exit(main());
