#!/usr/bin/env bun
// delete-guard Windows acceptance (omp-config #69). Runs on a throwaway
// `windows-latest` runner: installs the latest omp, applies this repository
// with its own updater, binds every model role to opencode-go DeepSeek (key in
// OPENCODE_API_KEY), then runs one RPC session per step of
// `windows-guard-steps.ts` and checks the requested tool call's result and the
// probe files on disk. Every reading is printed. Design: ci/README.md.
//
// Exit 0: every step passed. 1: a step failed, or setup failed.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Session, type Step, steps, type ToolCall } from "./windows-guard-steps.ts";

const REPO = resolve(import.meta.dir, "..");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const ROLES = ["default", "smol", "slow", "plan", "commit", "tiny", "memory", "task", "advisor"];
const SESSION_TIMEOUT_MS = 300_000;
const SETUP_TIMEOUT_MS = 600_000;

type Mapping = { readonly [key: string]: unknown };

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

function run(command: readonly string[], cwd: string): { code: number | null; out: string } {
	const [program, ...args] = command;
	if (program === undefined) throw new Error("run: empty command");
	const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: SETUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
	return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}` };
}

function setup(agentDir: string): string | null {
	const install = run(["bun", "install", "-g", "@oh-my-pi/pi-coding-agent@latest"], REPO);
	if (install.code !== 0) return `bun install -g exited ${install.code}: ${install.out}`;
	const version = run(["omp", "--version"], REPO);
	if (version.code !== 0) return `omp --version exited ${version.code}: ${version.out}`;
	console.log(`omp ${version.out.trim()}`);
	const updater = join(REPO, "agent/extensions/omp-config-autoupdate/omp-config-update.ts");
	const apply = run(["bun", updater, "apply", "--source", REPO, "--agent-dir", agentDir, "--json"], REPO);
	if (apply.code !== 0) return `updater apply exited ${apply.code}: ${apply.out}`;
	// modelRoles and skills are machine-local: bind every role to the test model and keep
	// plugin skills from being compressed in the background.
	const configPath = join(agentDir, "config.yml");
	const config: unknown = Bun.YAML.parse(readFileSync(configPath, "utf8"));
	const modelRoles = Object.fromEntries(ROLES.map((role) => [role, MODEL]));
	writeFileSync(configPath, Bun.YAML.stringify({ ...(isMapping(config) ? config : {}), modelRoles, skills: { enabled: false } }, null, 2));
	return null;
}

function textOf(result: unknown): string {
	if (!isMapping(result) || !Array.isArray(result.content)) return "";
	return result.content.flatMap((part) => (isMapping(part) && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** One RPC session: send the step's prompt after `ready`, close stdin at `prompt_result`, collect tool calls. */
async function runSession(prompt: string, cwd: string): Promise<Session> {
	const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-ui", "--no-session", "--model", MODEL], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(proc.stderr).text();
	const timer = setTimeout(() => proc.kill(), SESSION_TIMEOUT_MS);
	const started = new Map<string, { name: string; args: unknown }>();
	const calls: ToolCall[] = [];
	let sent = false;
	let done = false;
	let buffer = "";
	const decoder = new TextDecoder();
	const handle = (line: string): void => {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// Not an RPC frame (a stray log line): ignored.
			return;
		}
		if (!isMapping(event)) return;
		if (!sent && event.type === "ready") {
			proc.stdin.write(`${JSON.stringify({ id: "step", type: "prompt", message: prompt })}\n`);
			proc.stdin.flush();
			sent = true;
		} else if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
			started.set(event.toolCallId, { name: event.toolName, args: event.args });
		} else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
			const args = started.get(event.toolCallId)?.args;
			calls.push({ tool: event.toolName, args: isMapping(args) ? args : {}, isError: event.isError === true, text: textOf(event.result) });
		} else if (!done && event.id === "step" && (event.type === "prompt_result" || (event.type === "response" && event.success === false))) {
			done = true;
			proc.stdin.end();
		}
	};
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line !== "") handle(line);
		}
	}
	if (buffer.trim() !== "") handle(buffer.trim());
	const code = await proc.exited;
	clearTimeout(timer);
	return { calls, finished: done, code, stderr: (await stderr).trim() };
}

async function runStep(step: Step, cwd: string): Promise<readonly string[]> {
	step.prepare();
	const session = await runSession(step.prompt, cwd);
	console.log(`  calls: ${session.calls.map((call) => `${call.tool}${call.isError ? "(error)" : ""}`).join(", ") || "none"}`);
	for (const call of session.calls) console.log(`  ${call.tool} ${JSON.stringify(call.args)} -> ${call.text.replaceAll("\n", " | ")}`);
	const failures: string[] = [];
	if (!session.finished) failures.push(`session ended without prompt_result (exit ${session.code}): ${session.stderr}`);
	failures.push(...step.check(session));
	return failures;
}

async function main(): Promise<number> {
	if (process.platform !== "win32") {
		console.error("windows-guard: runs on Windows only");
		return 1;
	}
	if (!process.env.OPENCODE_API_KEY) {
		console.error("windows-guard: OPENCODE_API_KEY is not set");
		return 1;
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const failure = setup(agentDir);
	if (failure !== null) {
		console.error(`setup: ${failure}`);
		return 1;
	}
	const cwd = join(process.env.RUNNER_TEMP ?? homedir(), "omp-dg-work");
	mkdirSync(cwd, { recursive: true });
	let failed = 0;
	for (const step of steps(cwd)) {
		console.log(`::group::${step.name}`);
		const failures = await runStep(step, cwd);
		for (const line of step.readings()) console.log(`  ${line}`);
		console.log("::endgroup::");
		if (failures.length === 0) console.log(`PASS ${step.name}`);
		else {
			failed++;
			for (const text of failures) console.log(`FAIL ${step.name}: ${text}`);
		}
	}
	console.log(failed === 0 ? "all steps passed" : `${failed} step(s) failed`);
	return failed === 0 ? 0 : 1;
}

process.exit(await main());
