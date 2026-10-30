// omp-config-update three-way apply: unmodified items follow the repo,
// customizations survive (merged, kept, or reported as conflicts until
// resolved), seed and machine-owned paths are never overwritten, code stays
// repo-wins, deletions respect customizations, a machine without a base is
// matched against the repo's history, and --check writes nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApplyReport, applySnapshot } from "../agent/extensions/omp-config-autoupdate/omp-config-update.ts";

const UPDATER = join(import.meta.dir, "../agent/extensions/omp-config-autoupdate/omp-config-update.ts");
const roots: string[] = [];

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function writeTree(root: string, files: Record<string, string | null>): void {
	for (const [rel, text] of Object.entries(files)) {
		const path = join(root, rel);
		if (text === null) rmSync(path, { force: true });
		else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
	}
}

/** A source repo: each `commit` adds one snapshot of `agent/…` files (null deletes). */
function source(): { dir: string; commit: (files: Record<string, string | null>) => void } {
	const dir = temp("omp-src-");
	git(dir, "init", "-q");
	return {
		dir,
		commit: (files) => {
			writeTree(dir, files);
			git(dir, "add", "-A");
			git(dir, "commit", "-q", "--allow-empty", "-m", "snapshot");
		},
	};
}

const apply = (src: string, agentDir: string, check = false): Promise<ApplyReport> =>
	applySnapshot({ source: src, agentDir, previousCommit: undefined, check, plugins: false });

const host = (agentDir: string, rel: string): string => readFileSync(join(agentDir, rel), "utf8");

function resolveIds(src: string, agentDir: string, ids: readonly string[]): string {
	const result = spawnSync("bun", [UPDATER, "resolve", "--source", src, "--agent-dir", agentDir, ...ids], {
		encoding: "utf8",
		env: { ...process.env, HOME: temp("omp-home-") },
	});
	if (result.status !== 0) throw new Error(`resolve failed: ${result.stdout}${result.stderr}`);
	return result.stdout;
}

describe("plain files", () => {
	test("unmodified files follow upstream; a customized one keeps its edit and merges a separate upstream change", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/SYSTEM_TEMPLATE.md": "l1\nl2\nl3\nl4\nl5\n", "agent/agents/x.md": "a\nb\nc\n" });
		expect((await apply(src.dir, agentDir)).errors).toEqual([]);
		writeTree(agentDir, { "SYSTEM_TEMPLATE.md": "LOCAL\nl2\nl3\nl4\nl5\n" });
		src.commit({ "agent/SYSTEM_TEMPLATE.md": "l1\nl2\nl3\nl4\nUP\n", "agent/agents/x.md": "a\nB\nc\n" });
		const report = await apply(src.dir, agentDir);
		expect(report.conflicts).toEqual([]);
		expect(host(agentDir, "SYSTEM_TEMPLATE.md")).toBe("LOCAL\nl2\nl3\nl4\nUP\n");
		expect(host(agentDir, "agents/x.md")).toBe("a\nB\nc\n");
	});

	test("overlapping edits conflict, keep the local copy, and stay pending until resolved", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/x.md": "one\n" });
		await apply(src.dir, agentDir);
		writeTree(agentDir, { "agents/x.md": "mine\n" });
		src.commit({ "agent/agents/x.md": "theirs\n" });
		const first = await apply(src.dir, agentDir);
		expect(first.conflicts.map((conflict) => [conflict.rel, conflict.reason])).toEqual([["agent/agents/x.md", "both-changed"]]);
		expect(host(agentDir, "agents/x.md")).toBe("mine\n");
		const again = await apply(src.dir, agentDir);
		expect(again.conflicts.map((conflict) => conflict.id)).toEqual(first.conflicts.map((conflict) => conflict.id));
		resolveIds(src.dir, agentDir, [first.conflicts[0]?.id ?? ""]);
		expect((await apply(src.dir, agentDir)).conflicts).toEqual([]);
		expect(host(agentDir, "agents/x.md")).toBe("mine\n");
		src.commit({ "agent/agents/x.md": "theirs again\n" });
		expect((await apply(src.dir, agentDir)).conflicts.map((conflict) => conflict.reason)).toEqual(["both-changed"]);
	});

	test("a stale id is refused after upstream moves", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/x.md": "one\n" });
		await apply(src.dir, agentDir);
		writeTree(agentDir, { "agents/x.md": "mine\n" });
		src.commit({ "agent/agents/x.md": "two\n" });
		const id = (await apply(src.dir, agentDir)).conflicts[0]?.id ?? "";
		src.commit({ "agent/agents/x.md": "three\n" });
		const result = spawnSync("bun", [UPDATER, "resolve", "--source", src.dir, "--agent-dir", agentDir, id], {
			encoding: "utf8",
			env: { ...process.env, HOME: temp("omp-home-") },
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("stale");
	});

	test("code is repo-wins and lists the customization it overwrote", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/extensions/foo/index.ts": "export default 1;\n" });
		await apply(src.dir, agentDir);
		writeTree(agentDir, { "extensions/foo/index.ts": "export default 2;\n" });
		src.commit({ "agent/extensions/foo/index.ts": "export default 3;\n" });
		const report = await apply(src.dir, agentDir);
		expect(report.conflicts).toEqual([]);
		expect(report.overwritten).toEqual([join(agentDir, "extensions/foo/index.ts")]);
		expect(host(agentDir, "extensions/foo/index.ts")).toBe("export default 3;\n");
	});

	test("an upstream deletion removes an unmodified file and conflicts on a customized one", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/plain.md": "p\n", "agent/agents/edited.md": "e\n" });
		await apply(src.dir, agentDir);
		writeTree(agentDir, { "agents/edited.md": "mine\n" });
		src.commit({ "agent/agents/plain.md": null, "agent/agents/edited.md": null });
		const report = await apply(src.dir, agentDir);
		expect(existsSync(join(agentDir, "agents/plain.md"))).toBe(false);
		expect(host(agentDir, "agents/edited.md")).toBe("mine\n");
		expect(report.conflicts.map((conflict) => [conflict.rel, conflict.reason])).toEqual([["agent/agents/edited.md", "dropped-upstream"]]);
	});
});

describe("structured files", () => {
	test("managed keys merge per key; seed and machine-owned paths and host list entries stay the machine's", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({
			"agent/config.yml": [
				"extensions:",
				"  - repo-ext",
				"task:",
				"  eager: preferred",
				"  maxConcurrency: 64",
				"lsp:",
				"  enabled: false",
				"modelRoles:",
				"  default: repo/model",
				"",
			].join("\n"),
		});
		await apply(src.dir, agentDir);
		const fresh = Bun.YAML.parse(host(agentDir, "config.yml"));
		expect(fresh).toEqual({ extensions: ["repo-ext"], task: { eager: "preferred", maxConcurrency: 64 }, lsp: { enabled: false } });
		writeTree(agentDir, {
			"config.yml": [
				"extensions:",
				"  - ~/.claude",
				"  - repo-ext",
				"task:",
				"  eager: default",
				"  maxConcurrency: 8",
				"lsp:",
				"  enabled: false",
				"modelRoles:",
				"  default: mine/model",
				"",
			].join("\n"),
		});
		src.commit({
			"agent/config.yml": [
				"extensions:",
				"  - repo-ext-2",
				"task:",
				"  eager: never",
				"  maxConcurrency: 128",
				"lsp:",
				"  enabled: true",
				"",
			].join("\n"),
		});
		const report = await apply(src.dir, agentDir);
		expect(report.conflicts.map((conflict) => (conflict.kind === "key" ? conflict.path : []))).toEqual([["task", "eager"]]);
		expect(Bun.YAML.parse(host(agentDir, "config.yml"))).toEqual({
			extensions: ["~/.claude", "repo-ext-2"],
			task: { eager: "default", maxConcurrency: 8 },
			lsp: { enabled: true },
			modelRoles: { default: "mine/model" },
		});
	});

	test("a resolved key keeps the local value and follows the next upstream change only when unmodified again", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/config.yml": "task:\n  eager: preferred\n" });
		await apply(src.dir, agentDir);
		writeTree(agentDir, { "config.yml": "task:\n  eager: default\n" });
		src.commit({ "agent/config.yml": "task:\n  eager: never\n" });
		const id = (await apply(src.dir, agentDir)).conflicts[0]?.id ?? "";
		expect(resolveIds(src.dir, agentDir, [id])).toContain("resolved");
		expect((await apply(src.dir, agentDir)).conflicts).toEqual([]);
		expect(Bun.YAML.parse(host(agentDir, "config.yml"))).toEqual({ task: { eager: "default" } });
	});
});

describe("machines without a base", () => {
	test("a host copy equal to a committed version updates; one equal to none conflicts until resolved", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/old.md": "v1\n", "agent/agents/custom.md": "c1\n", "agent/config.yml": "lsp:\n  enabled: false\n" });
		src.commit({ "agent/agents/old.md": "v2\n", "agent/agents/custom.md": "c2\n", "agent/config.yml": "lsp:\n  enabled: true\n" });
		// What an older updater left behind: the first commit, plus one local edit; no base record.
		writeTree(agentDir, { "agents/old.md": "v1\n", "agents/custom.md": "mine\n", "config.yml": "lsp:\n  enabled: false\n" });
		const report = await apply(src.dir, agentDir);
		expect(host(agentDir, "agents/old.md")).toBe("v2\n");
		expect(Bun.YAML.parse(host(agentDir, "config.yml"))).toEqual({ lsp: { enabled: true } });
		expect(report.conflicts.map((conflict) => [conflict.rel, conflict.reason])).toEqual([["agent/agents/custom.md", "unknown-base"]]);
		const again = await apply(src.dir, agentDir);
		expect(again.conflicts.map((conflict) => conflict.id)).toEqual(report.conflicts.map((conflict) => conflict.id));
		resolveIds(src.dir, agentDir, [report.conflicts[0]?.id ?? ""]);
		expect((await apply(src.dir, agentDir)).conflicts).toEqual([]);
		expect(host(agentDir, "agents/custom.md")).toBe("mine\n");
	});

	test("--check reports the plan and writes neither files nor a base", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/x.md": "x\n" });
		const report = await apply(src.dir, agentDir, true);
		expect(report.written).toEqual([join(agentDir, "agents/x.md")]);
		expect(existsSync(join(agentDir, "agents/x.md"))).toBe(false);
		expect(existsSync(join(agentDir, ".omp-config-base"))).toBe(false);
	});
});
