import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import wtTool from "../agent/extensions/wt-tool/index.ts";

describe("worktree:// internal URL", () => {
	test("registers without promptDoc and reports linked status, HEAD, and dirty summary", async () => {
		const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
				hooks.set(name, fn);
			},
			registerTool() {},
			getActiveTools: () => [],
			logger: { warn() {}, info() {}, debug() {}, error() {} },
			async exec(cmd: string, args: string[], opts?: { cwd?: string }) {
				const res = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
				return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
			},
		} as unknown as ExtensionAPI;

		wtTool(pi);
		const router = InternalUrlRouter.instance();
		const handler = router.getHandler("worktree");
		expect(handler).toBeDefined();
		expect(handler?.promptDoc).toBeUndefined();

		const start = hooks.get("before_agent_start");
		expect(start).toBeDefined();
		const repoDir = `${import.meta.dir}/..`;
		start?.({}, { sessionManager: { getCwd: () => repoDir } } as unknown as ExtensionContext);

		const res = await router.resolve("worktree://");
		expect(res.content).toContain("# worktree://");
		expect(res.content).toContain("- Linked worktree:");
		expect(res.content).toContain("- Branch:");
		expect(res.content).toContain("- HEAD:");
		expect(res.content).toContain("- Dirty entries:");

		await expect(router.resolve("worktree://invalid/path")).rejects.toThrow("Invalid worktree:// URL");
	});
});
