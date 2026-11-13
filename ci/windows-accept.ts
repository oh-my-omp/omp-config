#!/usr/bin/env bun
// windows-accept, local side (omp-config #311):
//
//   bun ci/windows-accept.ts --checkout <owner/repo>@<ref> [--checkout …] --script <file.ts>
//
// Runs the given Bun script on a throwaway `windows-latest` runner whose PATH
// has no POSIX userland (windows-accept-remote.ts) beside the requested
// checkouts and the latest omp. Every argument is validated before anything is
// dispatched: the script must exist and each ref must resolve on GitHub. The
// workflow runs from the branch whose tip is this checkout's HEAD, so a pull
// request branch tests its own runner side. Prints the job's log to stdout and
// exits with the remote script's exit code. Design: ci/README.md.
//
// Exit: the remote script's code; 2 for invalid arguments (nothing dispatched);
// 1 when the run could not be dispatched, found or finished, or setup failed
// before the script ran.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SLUG = "oh-my-omp/omp-config";
const WORKFLOW_PATH = ".github/workflows/windows-accept.yml";
const EXIT_LINE = /^windows-accept: script exit (-?\d+)$/;
const MAX_SCRIPT_CHARS = 60_000;
const FIND_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 120 * 60_000;
const POLL_MS = 10_000;

type Args = { readonly checkouts: readonly string[]; readonly script: string };
type Checkout = { readonly slug: string; readonly sha: string };
type Outcome<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly message: string };

const ok = <T>(value: T): Outcome<T> => ({ kind: "ok", value });
const error = <T>(message: string): Outcome<T> => ({ kind: "error", message });

function gh(args: readonly string[], input?: string): { code: number | null; out: string; err: string } {
	const result = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
	return { code: result.status, out: result.stdout ?? "", err: `${result.stderr ?? ""}${result.error ? result.error.message : ""}` };
}

function ghJson(args: readonly string[]): Outcome<unknown> {
	const result = gh(args);
	if (result.code !== 0) return error(`gh ${args.join(" ")}: ${result.err.trim() || `exit ${result.code}`}`);
	try {
		return ok(JSON.parse(result.out));
	} catch (cause) {
		return error(`gh ${args.join(" ")}: unparsable output (${String(cause)})`);
	}
}

type Mapping = { readonly [key: string]: unknown };
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

function parseArgs(argv: readonly string[]): Outcome<Args> {
	const checkouts: string[] = [];
	let script: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if ((flag === "--checkout" || flag === "--script") && value === undefined) return error(`${flag} needs a value`);
		if (flag === "--checkout" && value !== undefined) checkouts.push(value);
		else if (flag === "--script" && value !== undefined) script = value;
		else return error(`unknown argument ${JSON.stringify(flag)}`);
		i++;
	}
	if (checkouts.length === 0) return error("at least one --checkout <owner/repo>@<ref> is required");
	if (script === undefined) return error("--script <file.ts> is required");
	return ok({ checkouts, script });
}

/** `owner/repo@ref` → the full commit SHA GitHub resolves the ref to (branch, tag or SHA prefix). */
function resolveCheckout(spec: string): Outcome<Checkout> {
	const match = /^([\w.-]+\/[\w.-]+)@(.+)$/.exec(spec);
	if (match === null) return error(`--checkout ${spec}: expected <owner/repo>@<ref>`);
	const [, slug = "", ref = ""] = match;
	const result = gh(["api", `repos/${slug}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"]);
	const sha = result.out.trim();
	if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return error(`--checkout ${spec}: ref ${ref} not found in ${slug}`);
	return ok({ slug, sha });
}

/** The omp-config branch to run the workflow from: the one whose tip is this checkout's HEAD (main preferred). */
function workflowBranch(): Outcome<string> {
	const head = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
	const current = spawnSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
	const remote = spawnSync("git", ["ls-remote", "--heads", `https://github.com/${SLUG}.git`], { encoding: "utf8" });
	if (remote.status !== 0) return error(`git ls-remote ${SLUG}: ${remote.stderr}`);
	const tips = (remote.stdout ?? "").split("\n").flatMap((line) => {
		const [sha, ref] = line.split("\t");
		return sha === head && ref?.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : [];
	});
	const branch = tips.find((name) => name === current) ?? tips.find((name) => name === "main") ?? tips[0];
	if (branch === undefined) return error(`this checkout's HEAD ${head.slice(0, 12)} is not the tip of any ${SLUG} branch; push it first`);
	return ok(branch);
}

function workflowId(): Outcome<number> {
	const listed = ghJson(["api", `repos/${SLUG}/actions/workflows?per_page=100`]);
	if (listed.kind === "error") return listed;
	const workflows = isMapping(listed.value) && Array.isArray(listed.value.workflows) ? listed.value.workflows : [];
	const found = workflows.find((entry) => isMapping(entry) && entry.path === WORKFLOW_PATH);
	if (!isMapping(found) || typeof found.id !== "number") return error(`${SLUG} has no registered ${WORKFLOW_PATH}`);
	return ok(found.id);
}

async function findRun(workflow: number, branch: string, nonce: string): Promise<Outcome<number>> {
	const deadline = Date.now() + FIND_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const runs = ghJson([
			"api",
			`repos/${SLUG}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=30`,
		]);
		if (runs.kind === "error") return runs;
		const list = isMapping(runs.value) && Array.isArray(runs.value.workflow_runs) ? runs.value.workflow_runs : [];
		const run = list.find((entry) => isMapping(entry) && entry.display_title === `windows-accept ${nonce}`);
		if (isMapping(run) && typeof run.id === "number") return ok(run.id);
		await Bun.sleep(5_000);
	}
	return error(`no windows-accept run named ${nonce} appeared within ${FIND_TIMEOUT_MS / 1000}s`);
}

async function awaitRun(run: number): Promise<Outcome<Mapping>> {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	let last = "";
	while (Date.now() < deadline) {
		const view = ghJson(["api", `repos/${SLUG}/actions/runs/${run}`]);
		if (view.kind === "error") return view;
		if (!isMapping(view.value)) return error(`run ${run}: unexpected response`);
		const status = String(view.value.status);
		if (status !== last) console.error(`windows-accept: run ${run} ${status} (${view.value.html_url})`);
		last = status;
		if (status === "completed") return ok(view.value);
		await Bun.sleep(POLL_MS);
	}
	return error(`run ${run} did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`);
}

/** The job log without GitHub's per-line timestamp prefix. */
function jobLog(run: number): Outcome<string> {
	const jobs = ghJson(["api", `repos/${SLUG}/actions/runs/${run}/jobs`]);
	if (jobs.kind === "error") return jobs;
	const job = isMapping(jobs.value) && Array.isArray(jobs.value.jobs) ? jobs.value.jobs[0] : undefined;
	if (!isMapping(job) || typeof job.id !== "number") return error(`run ${run} has no job`);
	const log = gh(["api", "--allow-escape-sequences", `repos/${SLUG}/actions/jobs/${job.id}/logs`]);
	if (log.code !== 0) return error(`job ${job.id} log: ${log.err.trim()}`);
	return ok(
		log.out
			.replace(/^\uFEFF/, "")
			.split(/\r?\n/)
			.map((line) => Bun.stripANSI(line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")))
			.join("\n"),
	);
}

async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.kind === "error") {
		console.error(`windows-accept: ${parsed.message}`);
		return 2;
	}
	const scriptPath = resolve(parsed.value.script);
	if (!existsSync(scriptPath)) {
		console.error(`windows-accept: --script ${parsed.value.script}: no such file`);
		return 2;
	}
	const script = readFileSync(scriptPath, "utf8");
	if (script.length > MAX_SCRIPT_CHARS) {
		console.error(
			`windows-accept: --script ${parsed.value.script}: ${script.length} characters, over the ${MAX_SCRIPT_CHARS} workflow input limit`,
		);
		return 2;
	}
	const checkouts: Checkout[] = [];
	for (const spec of parsed.value.checkouts) {
		const resolved = resolveCheckout(spec);
		if (resolved.kind === "error") {
			console.error(`windows-accept: ${resolved.message}`);
			return 2;
		}
		checkouts.push(resolved.value);
	}
	const branch = workflowBranch();
	if (branch.kind === "error") {
		console.error(`windows-accept: ${branch.message}`);
		return 1;
	}
	const workflow = workflowId();
	if (workflow.kind === "error") {
		console.error(`windows-accept: ${workflow.message}`);
		return 1;
	}
	const nonce = crypto.randomUUID();
	const inputs = { checkouts: checkouts.map(({ slug, sha }) => `${slug}@${sha}`).join("\n"), script, nonce };
	const dispatch = gh(
		["api", "-X", "POST", `repos/${SLUG}/actions/workflows/${workflow.value}/dispatches`, "--input", "-"],
		JSON.stringify({ ref: branch.value, inputs }),
	);
	if (dispatch.code !== 0) {
		console.error(`windows-accept: dispatch failed: ${dispatch.err.trim()}`);
		return 1;
	}
	console.error(`windows-accept: dispatched on ${SLUG}@${branch.value} (${nonce})`);
	const run = await findRun(workflow.value, branch.value, nonce);
	if (run.kind === "error") {
		console.error(`windows-accept: ${run.message}`);
		return 1;
	}
	const finished = await awaitRun(run.value);
	if (finished.kind === "error") {
		console.error(`windows-accept: ${finished.message}`);
		return 1;
	}
	const log = jobLog(run.value);
	if (log.kind === "error") {
		console.error(`windows-accept: ${log.message}`);
		return 1;
	}
	process.stdout.write(`${log.value}\n`);
	const exit = log.value
		.split("\n")
		.flatMap((line) => {
			const match = EXIT_LINE.exec(line.trim());
			return match ? [Number(match[1])] : [];
		})
		.at(-1);
	if (exit === undefined) {
		console.error(
			`windows-accept: the script did not run (run conclusion ${String(finished.value.conclusion)}, ${String(finished.value.html_url)})`,
		);
		return 1;
	}
	return exit;
}

process.exit(await main(Bun.argv.slice(2)));
