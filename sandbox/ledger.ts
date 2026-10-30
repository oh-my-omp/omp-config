// The run's entry in the machine's OrbStack ledger (S7). The ledger is the directory
// ~/Ext/work/orbstack/; sandbox runs have their own file there, one table row per run. The row is
// written before any resource exists and rewritten in place once the resources are gone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LEDGER = join(homedir(), "Ext", "work", "orbstack", "omp-sandbox.md");

const HEADER = `# omp-config 沙箱运行（omp-sandbox-*）

由 omp-config 的 \`sandbox/sandbox.ts\` 写入：创建任何资源之前登记一行，资源删除并确认后原地改写同一行。每次运行的资源都带标签 \`omp-sandbox.run=<run>\`：容器 \`omp-sandbox-<run>\`（\`oven/bun:latest\`）、可选的目标机 \`omp-sandbox-<run>-target\`（\`debian:stable-slim\` + sshd）、网络 \`omp-sandbox-<run>-net\`；不发布端口，不挂卷、bind mount 或 docker socket，不建数据库或 VM。容器内有本机 \`~/.omp\` 配置与凭据的副本。遗留的运行用 \`bun sandbox/sandbox.ts down <run>\` 删除。

| 运行 | 开始（UTC） | 用途 | 状态 | 清理证据 |
|---|---|---|---|---|
`;

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function rowFor(run: string, started: string, purpose: string, state: string, evidence: string): string {
	return `| \`omp-sandbox-${run}\` | ${cell(started)} | ${cell(purpose)} | ${cell(state)} | ${cell(evidence)} |`;
}

/** Registers the run as in progress. Throws (before anything is created) when the ledger directory is missing. */
export function ledgerStart(run: string, started: string, purpose: string): void {
	if (!existsSync(dirname(LEDGER))) throw new Error(`ledger directory ${dirname(LEDGER)} does not exist; nothing was created`);
	const text = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : HEADER;
	writeFileSync(LEDGER, `${text.endsWith("\n") ? text : `${text}\n`}${rowFor(run, started, purpose, "进行中", "—")}\n`);
}

/** Rewrites the run's row with its final state and the cleanup evidence. */
export function ledgerEnd(run: string, state: string, evidence: string): void {
	const marker = `| \`omp-sandbox-${run}\` |`;
	const lines = readFileSync(LEDGER, "utf8").split("\n");
	const index = lines.findIndex((line) => line.startsWith(marker));
	if (index < 0) {
		lines.push(rowFor(run, "?", "（开始时未登记）", state, evidence));
	} else {
		// Keep the run, start and purpose cells as written; replace state and evidence.
		const kept = (lines[index] ?? "").split(" | ").slice(0, 3).join(" | ");
		lines[index] = `${kept} | ${cell(state)} | ${cell(evidence)} |`;
	}
	writeFileSync(LEDGER, lines.join("\n"));
}
