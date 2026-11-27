import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CHANGELOG_EXT = join(REPO_ROOT, "agent/extensions/omomp-changelog/index.ts");
const AUTOUPDATE_EXT = join(REPO_ROOT, "agent/extensions/omp-config-autoupdate/index.ts");

function isolatedEnv(home: string, agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		OMOMP_LANG: "en",
	};
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.XDG_DATA_HOME;
	delete env.XDG_STATE_HOME;
	delete env.XDG_CACHE_HOME;
	delete env.XDG_CONFIG_HOME;
	return env;
}

describe("idle visible sendMessage options", () => {
	test("/omomp-changelog delivers visible history with deliverAs nextTurn and triggerTurn false in an isolated HOME", () => {
		const root = mkdtempSync(join(tmpdir(), "omomp-changelog-send-"));
		try {
			const home = join(root, "home");
			const agentDir = join(home, ".omp", "agent");
			const pluginsDir = join(home, ".omp", "plugins");
			const pkgDir = join(pluginsDir, "node_modules", "fx-member");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(join(pluginsDir, "package.json"), JSON.stringify({ dependencies: { "fx-member": "0.2.0" } }));
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: "fx-member", version: "0.2.0", omomp: { changelog: "CHANGELOG.md" } }),
			);
			writeFileSync(
				join(pkgDir, "CHANGELOG.md"),
				["# Changelog", "", "## [0.2.0] - 2026-11-27", "", "### Fixed", "", "- isolated changelog entry", ""].join("\n"),
			);

			const script = `
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, getPluginsDir } from "@oh-my-pi/pi-utils/dirs";
import omompChangelog from ${JSON.stringify(CHANGELOG_EXT)};

const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
const sent: Array<{ message: unknown; options: unknown }> = [];
const pi = {
	registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
		commands.set(name, spec.handler);
	},
	on: () => {},
	sendMessage: (message: unknown, options?: unknown) => {
		sent.push({ message, options });
	},
	logger: { info: () => {}, warn: () => {} },
} as unknown as ExtensionAPI;
const ctx = {
	waitForIdle: async () => {},
	ui: { notify: () => {} },
} as unknown as ExtensionCommandContext;

omompChangelog(pi);
await commands.get("omomp-changelog")?.("last 1", ctx);
console.log(JSON.stringify({ agentDir: getAgentDir(), pluginsDir: getPluginsDir(), sent }));
`;
			const out = execFileSync(process.execPath, ["-e", script], {
				cwd: REPO_ROOT,
				env: isolatedEnv(home, agentDir),
				encoding: "utf8",
			});
			const parsed = JSON.parse(out.trim()) as {
				agentDir: string;
				pluginsDir: string;
				sent: Array<{
					message: { customType: string; content: string; display: boolean; attribution: string };
					options: unknown;
				}>;
			};
			expect(parsed.agentDir).toBe(agentDir);
			expect(parsed.pluginsDir).toBe(pluginsDir);
			expect(parsed.sent).toHaveLength(1);
			expect(parsed.sent[0]?.message.customType).toBe("omomp-changelog");
			expect(parsed.sent[0]?.message.display).toBe(true);
			expect(parsed.sent[0]?.message.content).toContain("fx-member v0.2.0");
			expect(parsed.sent[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("/omp-config-autoupdate run delivers its idle report with deliverAs nextTurn and triggerTurn false in an isolated HOME", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-autoupdate-send-"));
		try {
			const home = join(root, "home");
			const agentDir = join(home, ".omp", "agent");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(home, ".omp", "omp-config-update.lock"), { recursive: true });

			const script = `
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import ompConfigAutoupdate from ${JSON.stringify(AUTOUPDATE_EXT)};

const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
const sent: Array<{ message: unknown; options: unknown }> = [];
const pi = {
	registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
		commands.set(name, spec.handler);
	},
	on: () => {},
	sendMessage: (message: unknown, options?: unknown) => {
		sent.push({ message, options });
	},
	logger: { info: () => {}, warn: () => {} },
} as unknown as ExtensionAPI;
const ctx = {
	waitForIdle: async () => {},
	ui: { notify: () => {} },
} as unknown as ExtensionCommandContext;

ompConfigAutoupdate(pi);
await commands.get("omp-config-autoupdate")?.("run", ctx);
console.log(JSON.stringify({ agentDir: getAgentDir(), sent }));
`;
			const out = execFileSync(process.execPath, ["-e", script], {
				cwd: REPO_ROOT,
				env: isolatedEnv(home, agentDir),
				encoding: "utf8",
			});
			const parsed = JSON.parse(out.trim()) as {
				agentDir: string;
				sent: Array<{
					message: { customType: string; content: string; display: boolean; attribution: string };
					options: unknown;
				}>;
			};
			expect(parsed.agentDir).toBe(agentDir);
			expect(parsed.sent).toHaveLength(1);
			expect(parsed.sent[0]?.message.customType).toBe("omp-config-update");
			expect(parsed.sent[0]?.message.display).toBe(true);
			expect(parsed.sent[0]?.message.content).toContain("omp-config-update.lock");
			expect(parsed.sent[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
