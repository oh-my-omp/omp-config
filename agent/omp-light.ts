#!/usr/bin/env bun

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ChildSignal = NodeJS.Signals;

function activeAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return resolve(configured || join(homedir(), ".omp", "agent"));
}

function readableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * config-light.yml empties `extensions` to drop the full-mode-only entries
 * under `extensions-last/`. Every other config.yml entry (the machine's own,
 * such as ~/.claude) is passed back with `-e`, a load lane the override does
 * not reach, so light mode keeps it. An unreadable config.yml adds nothing;
 * omp reports it on its own.
 */
function machineExtensionArgs(agentDir: string): string[] {
	let config: unknown;
	try {
		config = Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8"));
	} catch {
		return [];
	}
	const entries = typeof config === "object" && config !== null && "extensions" in config ? config.extensions : undefined;
	if (!Array.isArray(entries)) return [];
	return entries
		.filter((entry): entry is string => typeof entry === "string" && !entry.replaceAll("\\", "/").includes("/extensions-last/"))
		.flatMap((entry) => ["-e", entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry]);
}

function childExitCode(code: number | null, signal: ChildSignal | null): number {
	if (code !== null) return code;
	if (signal === "SIGINT") return 128 + 2;
	if (signal === "SIGTERM") return 128 + 15;
	return 1;
}

async function runOmp(ompPath: string, args: string[]): Promise<number> {
	let child: ChildProcess;
	try {
		child = spawn(ompPath, args, { shell: false, stdio: "inherit", env: { ...process.env, OMOMP_MODE: "light" } });
	} catch {
		console.error(`omp-light: unable to launch omp: ${ompPath}`);
		return 126;
	}

	return await new Promise<number>((finish) => {
		let settled = false;
		const onSignal = (signal: ChildSignal): void => {
			if (settled || child.exitCode !== null || child.signalCode !== null) return;
			try {
				child.kill(signal);
			} catch {
				// The child can exit between the state check and kill().
			}
		};
		const onInterrupt = (): void => onSignal("SIGINT");
		const onTerminate = (): void => onSignal("SIGTERM");
		const complete = (status: number): void => {
			if (settled) return;
			settled = true;
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
			finish(status);
		};

		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		child.once("error", () => {
			console.error(`omp-light: unable to launch omp: ${ompPath}`);
			complete(126);
		});
		child.once("exit", (code, signal) => complete(childExitCode(code, signal)));
	});
}

async function main(): Promise<number> {
	const agentDir = activeAgentDir();
	const configPath = join(agentDir, "config-light.yml");
	const promptPath = join(agentDir, "APPEND_SYSTEM_LIGHT.md");

	if (!readableFile(configPath)) {
		console.error(`omp-light: unavailable config: ${configPath}`);
		return 1;
	}
	if (!readableFile(promptPath)) {
		console.error(`omp-light: unavailable system prompt: ${promptPath}`);
		return 1;
	}

	const discoveredOmp = Bun.which("omp");
	if (!discoveredOmp) {
		console.error("omp-light: omp not found on PATH");
		return 127;
	}

	const ompPath = resolve(discoveredOmp);
	const args = ["--config", configPath, "--append-system-prompt", promptPath, ...machineExtensionArgs(agentDir), ...process.argv.slice(2)];
	return await runOmp(ompPath, args);
}

try {
	process.exitCode = await main();
} catch {
	console.error("omp-light: failed unexpectedly");
	process.exitCode = 1;
}
