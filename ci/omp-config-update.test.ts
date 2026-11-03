// omp-config-update three-way apply: unmodified items follow the repo,
// customizations survive (merged, kept, or reported as conflicts until
// resolved), seed and machine-owned paths are never overwritten, code stays
// repo-wins, deletions respect customizations, a machine without a base is
// matched against the repo's history, a first install over omp's own
// first-run config.yml writes every managed key, and --check writes nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter, unquote } from "../agent/extensions/_shared/spec-files.ts";
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

	test("translator cutover leaves existing bytes alone with an old structured base and deletion history", async () => {
		const src = source();
		const original = '{\n  "enabled": true,\n  "trace": false\n}\n';
		src.commit({ "agent/thinking-translator.json": original });
		src.commit({ "agent/thinking-translator.json": null, "agent/config.yml": "lsp:\n  enabled: false\n" });
		for (const content of [original, '{ "enabled": false, "custom": "本机" }\n']) {
			const agentDir = temp("omp-translator-cutover-");
			writeTree(agentDir, {
				"thinking-translator.json": content,
				".omp-config-base/state.json": JSON.stringify({
					version: 1,
					unknownPlain: [],
					structured: { "agent/thinking-translator.json": { value: { trace: false }, unknown: [] } },
				}),
			});
			for (const check of [true, false]) {
				const report = await applySnapshot({
					source: src.dir,
					agentDir,
					previousCommit: "HEAD~1",
					check,
					plugins: false,
				});
				expect(report.errors).toEqual([]);
				expect(report.conflicts).toEqual([]);
				expect(readFileSync(join(agentDir, "thinking-translator.json"))).toEqual(Buffer.from(content));
			}
		}
	});

	test("a translator file in an older snapshot is not seeded on a fresh machine", async () => {
		const src = source();
		const agentDir = temp("omp-translator-unmanaged-");
		src.commit({ "agent/thinking-translator.json": '{"enabled":true}\n' });
		expect((await apply(src.dir, agentDir)).errors).toEqual([]);
		expect(existsSync(join(agentDir, "thinking-translator.json"))).toBe(false);
	});
});

describe("machines without a base", () => {
	test("a host copy equal to a committed version updates; one equal to none conflicts until resolved", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({ "agent/agents/old.md": "v1\n", "agent/agents/custom.md": "c1\n", "agent/config.yml": "lsp:\n  enabled: false\n" });
		src.commit({ "agent/agents/old.md": "v2\n", "agent/agents/custom.md": "c2\n", "agent/config.yml": "lsp:\n  enabled: true\n" });
		// What an older updater left behind: the first commit, plus one local edit, and the updater itself; no base record.
		writeTree(agentDir, {
			"agents/old.md": "v1\n",
			"agents/custom.md": "mine\n",
			"config.yml": "lsp:\n  enabled: false\n",
			"extensions/omp-config-autoupdate/omp-config-update.ts": "// installed updater\n",
		});
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

	test("a first install over omp's own config.yml writes every managed key; a key the user already set conflicts", async () => {
		const src = source();
		const agentDir = temp("omp-agent-");
		src.commit({
			"agent/config.yml": [
				"github:",
				"  enabled: true",
				"fetch:",
				"  enabled: true",
				"task:",
				"  eager: preferred",
				"  maxConcurrency: 64",
				"composer:",
				"  shape: band",
				"",
			].join("\n"),
		});
		// omp's first-run setup, plus one managed key the user set before installing; no base record, no updater.
		writeTree(agentDir, {
			"config.yml": [
				"modelRoles:",
				"  default: mine/model",
				"symbolPreset: unicode",
				"composer:",
				"  shape: box",
				"setupVersion: 2",
				"fetch:",
				"  enabled: false",
				"",
			].join("\n"),
		});
		const report = await apply(src.dir, agentDir);
		expect(report.conflicts.map((conflict) => [conflict.kind === "key" ? conflict.path : [], conflict.reason])).toEqual([
			[["fetch", "enabled"], "both-changed"],
		]);
		expect(Bun.YAML.parse(host(agentDir, "config.yml"))).toEqual({
			modelRoles: { default: "mine/model" },
			symbolPreset: "unicode",
			composer: { shape: "box" },
			setupVersion: 2,
			fetch: { enabled: false },
			github: { enabled: true },
			task: { eager: "preferred", maxConcurrency: 64 },
		});
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

describe("legacy model appendix fragments", () => {
	const missingSourceNotes = [
		"agent/omomp.yml: not in source, host copy left alone",
		"agent/config.yml: not in source, host copy left alone",
	];
	const extensionDir = "extensions/append-system-model";
	const legacyLocations = ["APPEND_SYSTEM_MODEL.md", `${extensionDir}/APPEND_SYSTEM_MODEL.md`];
	const first = `${extensionDir}/APPEND-SYSTEM-model-01.md`;
	const second = `${extensionDir}/APPEND-SYSTEM-model-02.md`;
	const old = [
		"---",
		String.raw`model: '^gpt-\d+\."x"/$'`,
		"---",
		"  Model-only body.  ",
		"",
		"---",
		'model: "(opus|o3)"',
		"provider: ^anthropic$",
		"---",
		"Both constraints.",
		"Second line.",
		"",
	].join("\n");
	const expected = [
		["---", "target: *", String.raw`model: "^gpt-\d+\."x"/$"`, "---", "Model-only body.", ""].join("\n"),
		["---", "target: *", 'model: "(opus|o3)"', 'provider: "^anthropic$"', "---", "Both constraints.", "Second line.", ""].join("\n"),
	];

	for (const legacy of legacyLocations) {
		test(`splits two legacy blocks at ${legacy}, preserving regex strings, scope and order`, async () => {
			const src = source();
			src.commit({ "agent/.keep": "" });
			const agentDir = temp("omp-model-split-");
			writeTree(agentDir, { [legacy]: old });
			const report = await apply(src.dir, agentDir);
			expect(report.errors).toEqual([]);
			expect(report.notes).toEqual([...missingSourceNotes]);
			expect(report.moved).toEqual([
				{ from: join(agentDir, legacy), to: join(agentDir, first) },
				{ from: join(agentDir, legacy), to: join(agentDir, second) },
			]);
			expect(report.restartNeeded).toBe(false);
			expect(existsSync(join(agentDir, legacy))).toBe(false);
			expect(host(agentDir, first)).toBe(expected[0]!);
			expect(host(agentDir, second)).toBe(expected[1]!);
			for (const [index, rel] of [first, second].entries()) {
				const parsed = parseFrontmatter(host(agentDir, rel));
				expect(parsed).not.toBeNull();
				expect(unquote(parsed!.fields.target!)).toBe("*");
				expect(unquote(parsed!.fields.model!)).toBe(index === 0 ? String.raw`^gpt-\d+\."x"/$` : "(opus|o3)");
				if (index === 1) expect(unquote(parsed!.fields.provider!)).toBe("^anthropic$");
				else expect(parsed!.fields.provider).toBeUndefined();
			}
			const again = await apply(src.dir, agentDir);
			expect(again.errors).toEqual([]);
			expect(again.moved).toEqual([]);
			expect(again.written).toEqual([]);
			expect(again.deleted).toEqual([]);
			expect(host(agentDir, first)).toBe(expected[0]!);
			expect(host(agentDir, second)).toBe(expected[1]!);
		});

		test(`CLI --check plans the split at ${legacy} without writing files or directories`, () => {
			const src = source();
			src.commit({ "agent/.keep": "" });
			const agentDir = temp("omp-model-check-");
			writeTree(agentDir, { [legacy]: old });
			const before = readdirSync(agentDir, { recursive: true }).sort();
			const result = spawnSync("bun", [UPDATER, "apply", "--source", src.dir, "--agent-dir", agentDir, "--no-plugins", "--check"], {
				encoding: "utf8",
				env: { ...process.env, HOME: temp("omp-home-") },
			});
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				`would move: ${join(agentDir, legacy)} -> ${join(agentDir, first)}\n` +
					`would move: ${join(agentDir, legacy)} -> ${join(agentDir, second)}\n` +
					missingSourceNotes.map((note) => `note: ${note}\n`).join(""),
			);
			expect(readdirSync(agentDir, { recursive: true }).sort()).toEqual(before);
			expect(host(agentDir, legacy)).toBe(old);
			expect(existsSync(join(agentDir, first))).toBe(false);
			expect(existsSync(join(agentDir, second))).toBe(false);
			expect(existsSync(join(agentDir, ".omp-config-base"))).toBe(false);
		});

		test(`an occupied second fragment keeps all legacy blocks at ${legacy}`, async () => {
			const src = source();
			src.commit({ "agent/.keep": "" });
			const agentDir = temp("omp-model-collision-");
			writeTree(agentDir, { [legacy]: old, [second]: "host-owned fragment\n" });
			for (const check of [true, false]) {
				const report = await apply(src.dir, agentDir, check);
				expect(report.errors).toEqual([]);
				expect(report.moved).toEqual([]);
				expect(report.notes).toEqual([
					...missingSourceNotes,
					`${join(agentDir, legacy)} left in place: ${join(agentDir, second)} already exists`,
				]);
				expect(host(agentDir, legacy)).toBe(old);
				expect(existsSync(join(agentDir, first))).toBe(false);
				expect(host(agentDir, second)).toBe("host-owned fragment\n");
			}
		});

		test(`a malformed later block leaves the whole legacy file at ${legacy}`, async () => {
			const src = source();
			src.commit({ "agent/.keep": "" });
			const agentDir = temp("omp-model-invalid-");
			const malformed = old.replace('model: "(opus|o3)"', "unknown: opus");
			writeTree(agentDir, { [legacy]: malformed });
			for (const check of [true, false]) {
				const report = await apply(src.dir, agentDir, check);
				expect(report.errors).toEqual([]);
				expect(report.moved).toEqual([]);
				expect(report.notes).toEqual([
					...missingSourceNotes,
					`${join(agentDir, legacy)} left in place: cannot split APPEND_SYSTEM_MODEL.md: line 6: unknown header key \`unknown\` (allowed: model, provider)`,
				]);
				expect(host(agentDir, legacy)).toBe(malformed);
				expect(existsSync(join(agentDir, first))).toBe(false);
				expect(existsSync(join(agentDir, second))).toBe(false);
			}
		});
	}

	test("shipped APPEND-SYSTEM templates are managed without a restart; host fragments stay untouched", async () => {
		const src = source();
		const template = `${extensionDir}/APPEND-SYSTEM-decision-support.md`;
		const shipped = '---\ntarget: *\nmodel: "gpt"\n---\nRepo instructions.\n';
		src.commit({ [`agent/${template}`]: shipped });
		const agentDir = temp("omp-model-managed-");
		writeTree(agentDir, { [first]: expected[0]! });
		const report = await apply(src.dir, agentDir);
		expect(report.errors).toEqual([]);
		expect(report.written).toEqual([join(agentDir, template)]);
		expect(report.restartNeeded).toBe(false);
		expect(host(agentDir, template)).toBe(shipped);
		expect(host(agentDir, first)).toBe(expected[0]!);
		src.commit({ [`agent/${template}`]: `${shipped}Updated.\n` });
		const updated = await apply(src.dir, agentDir);
		expect(updated.errors).toEqual([]);
		expect(updated.written).toEqual([join(agentDir, template)]);
		expect(updated.restartNeeded).toBe(false);
		expect(host(agentDir, template)).toBe(`${shipped}Updated.\n`);
		expect(host(agentDir, first)).toBe(expected[0]!);
	});

	test("both legacy locations keep their files when numbered destinations overlap", async () => {
		const src = source();
		src.commit({ "agent/.keep": "" });
		const agentDir = temp("omp-model-overlap-");
		writeTree(agentDir, Object.fromEntries(legacyLocations.map((legacy) => [legacy, old])));
		const report = await apply(src.dir, agentDir);
		expect(report.errors).toEqual([]);
		expect(report.moved).toEqual([]);
		expect(report.notes).toEqual([
			...missingSourceNotes,
			`${join(agentDir, legacyLocations[0]!)} left in place: numbered fragment targets overlap with ${join(agentDir, legacyLocations[1]!)}`,
			`${join(agentDir, legacyLocations[1]!)} left in place: numbered fragment targets overlap with ${join(agentDir, legacyLocations[0]!)}`,
		]);
		for (const legacy of legacyLocations) expect(host(agentDir, legacy)).toBe(old);
		expect(existsSync(join(agentDir, first))).toBe(false);
		expect(existsSync(join(agentDir, second))).toBe(false);
	});

	test("a numbered fragment shipped by the source is not overwritten by host migration", async () => {
		const src = source();
		src.commit({ [`agent/${second}`]: "source fragment\n" });
		const agentDir = temp("omp-model-source-collision-");
		writeTree(agentDir, { APPEND_SYSTEM_MODEL: "unrelated\n", "APPEND_SYSTEM_MODEL.md": old });
		const report = await apply(src.dir, agentDir);
		expect(report.errors).toEqual([]);
		expect(report.moved).toEqual([]);
		expect(report.notes).toEqual([
			...missingSourceNotes,
			`${join(agentDir, "APPEND_SYSTEM_MODEL.md")} left in place: ${join(agentDir, second)} is a managed source file`,
		]);
		expect(host(agentDir, "APPEND_SYSTEM_MODEL.md")).toBe(old);
		expect(existsSync(join(agentDir, first))).toBe(false);
		expect(host(agentDir, second)).toBe("source fragment\n");
	});

	test("legacy symlinks are noted and app-managed legacy files are skipped", async () => {
		const src = source();
		src.commit({ "agent/.keep": "" });
		const agentDir = temp("omp-model-links-");
		writeTree(agentDir, { "backing.md": old });
		symlinkSync(join(agentDir, "backing.md"), join(agentDir, "APPEND_SYSTEM_MODEL.md"));
		const report = await apply(src.dir, agentDir);
		expect(report.errors).toEqual([]);
		expect(report.moved).toEqual([]);
		expect(report.notes).toEqual([
			...missingSourceNotes,
			`${join(agentDir, "APPEND_SYSTEM_MODEL.md")} is a symlink and was not moved; split it into ${join(agentDir, extensionDir)}/APPEND-SYSTEM-model-NN.md yourself`,
		]);
		expect(lstatSync(join(agentDir, "APPEND_SYSTEM_MODEL.md")).isSymbolicLink()).toBe(true);
		expect(host(agentDir, "backing.md")).toBe(old);
		expect(existsSync(join(agentDir, first))).toBe(false);
		const managedDir = temp("omp-model-app-managed-");
		const managed = `// @orca-managed-pi-extension\n${old}`;
		writeTree(managedDir, { "APPEND_SYSTEM_MODEL.md": managed });
		const skipped = await apply(src.dir, managedDir);
		expect(skipped.errors).toEqual([]);
		expect(skipped.skipped).toEqual([{ path: join(managedDir, "APPEND_SYSTEM_MODEL.md"), reason: "app-managed" }]);
		expect(host(managedDir, "APPEND_SYSTEM_MODEL.md")).toBe(managed);
	});

	test("BOM, CRLF and provider-only YAML blocks preserve their decoded regex", async () => {
		const src = source();
		src.commit({ "agent/.keep": "" });
		const agentDir = temp("omp-model-yaml-");
		writeTree(agentDir, { "APPEND_SYSTEM_MODEL.md": '\uFEFF\r\n--- \t\r\nprovider: "^anthropic\\\\d+$"\r\n---\r\nProvider only.\r\n' });
		const report = await apply(src.dir, agentDir);
		expect(report.errors).toEqual([]);
		expect(report.notes).toEqual([...missingSourceNotes]);
		expect(host(agentDir, first)).toBe('---\ntarget: *\nprovider: "^anthropic\\d+$"\n---\nProvider only.\n');
		const parsed = parseFrontmatter(host(agentDir, first));
		expect(unquote(parsed!.fields.provider!)).toBe(String.raw`^anthropic\d+$`);
		expect(parsed!.fields.model).toBeUndefined();
	});

	const invalidFiles = [
		{ text: "preamble\n---\nmodel: gpt\n---\nbody\n", reason: "line 1: content before the first `---` header" },
		{
			text: "---\nmodel: gpt\n",
			reason: "line 1: `---` opens a header that is never closed (a body cannot contain a bare `---` line)",
		},
		{ text: "---\n{}\n---\nbody\n", reason: "line 1: header must set `model` and/or `provider`" },
		{ text: "---\nmodel: 42\n---\nbody\n", reason: "line 1: `model` must be a non-empty regex string" },
		{ text: "---\nmodel: gpt\n---\n \n", reason: "line 1: block has an empty body" },
		{
			text: '---\nmodel: " gpt "\n---\nbody\n',
			reason: "line 1: `model` cannot be preserved in single-line fragment frontmatter",
		},
		{
			text: '---\nmodel: "gpt\\nnext"\n---\nbody\n',
			reason: "line 1: `model` cannot be preserved in single-line fragment frontmatter",
		},
	];
	for (const { text, reason } of invalidFiles) {
		test(`invalid legacy input is left untouched: ${reason}`, async () => {
			const src = source();
			src.commit({ "agent/.keep": "" });
			const agentDir = temp("omp-model-invalid-input-");
			writeTree(agentDir, { "APPEND_SYSTEM_MODEL.md": text });
			const report = await apply(src.dir, agentDir);
			expect(report.errors).toEqual([]);
			expect(report.moved).toEqual([]);
			expect(report.notes).toEqual([
				...missingSourceNotes,
				`${join(agentDir, "APPEND_SYSTEM_MODEL.md")} left in place: cannot split APPEND_SYSTEM_MODEL.md: ${reason}`,
			]);
			expect(host(agentDir, "APPEND_SYSTEM_MODEL.md")).toBe(text);
			expect(existsSync(join(agentDir, first))).toBe(false);
		});
	}
});
