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

export function ledgerStart(run: string, started: string, purpose: string): void {
	if (!existsSync(dirname(LEDGER))) throw new Error(`ledger directory ${dirname(LEDGER)} does not exist; nothing was created`);
	const text = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : HEADER;
	writeFileSync(LEDGER, `${text.endsWith("\n") ? text : `${text}\n`}${rowFor(run, started, purpose, "进行中", "—")}\n`);
}

export function ledgerInProgress(path: string = LEDGER): string[] {
	if (!existsSync(path)) return [];
	const runs: string[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^\| `omp-sandbox-([a-z0-9]+)` \|/.exec(line);
		if (match?.[1] === undefined) continue;
		const cols = line.split(" | ");
		if (cols[3]?.trim() === "进行中") runs.push(match[1]);
	}
	return runs;
}

export function ledgerEnd(run: string, state: string, evidence: string): void {
	const marker = `| \`omp-sandbox-${run}\` |`;
	const lines = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n") : HEADER.split("\n");
	const index = lines.findIndex((line) => line.startsWith(marker));
	if (index < 0) {
		const trailing = lines.at(-1) === "";
		if (trailing) lines.pop();
		lines.push(rowFor(run, "?", "（开始时未登记）", state, evidence));
		if (trailing) lines.push("");
	} else {
		const kept = (lines[index] ?? "").split(" | ").slice(0, 3).join(" | ");
		lines[index] = `${kept} | ${cell(state)} | ${cell(evidence)} |`;
	}
	writeFileSync(LEDGER, lines.join("\n"));
}
