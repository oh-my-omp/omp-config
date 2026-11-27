import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import omompChangelog from "../agent/extensions/omomp-changelog/index.ts";
import ompConfigAutoupdate from "../agent/extensions/omp-config-autoupdate/index.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function createCommandHarness() {
	const commands = new Map<string, CommandHandler>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const pi = {
		registerCommand: (name: string, spec: { handler: CommandHandler }) => {
			commands.set(name, spec.handler);
		},
		on: () => {},
		sendMessage: (message: unknown, options?: unknown) => {
			sent.push({ message, options });
		},
		logger: {
			info: () => {},
			warn: () => {},
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		waitForIdle: async () => {},
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	return { pi, ctx, commands, sent, notifications };
}

describe("idle visible sendMessage options", () => {
	test("/omomp-changelog delivers visible history with deliverAs nextTurn and triggerTurn false", async () => {
		const root = mkdtempSync(join(tmpdir(), "omomp-changelog-send-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			process.env.PI_CODING_AGENT_DIR = agentDir;

			const harness = createCommandHarness();
			omompChangelog(harness.pi);
			const handler = harness.commands.get("omomp-changelog");
			expect(handler).toBeDefined();
			await handler?.("last 1", harness.ctx);

			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("/omp-config-autoupdate run delivers its idle report with deliverAs nextTurn and triggerTurn false", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-autoupdate-send-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevPath = process.env.PATH;
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(root, "omp-config-update.lock"), "busy");
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.PATH = "";

			const harness = createCommandHarness();
			ompConfigAutoupdate(harness.pi);
			const handler = harness.commands.get("omp-config-autoupdate");
			expect(handler).toBeDefined();
			await handler?.("run", harness.ctx);

			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
