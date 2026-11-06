// The updater's SETTINGS step: the plugin `omp-config` is linked from the
// agent dir, the omp-config sections of a machine's omomp file move into its
// plugin settings and their list data into md files, sections of other owners
// stay, and anything that cannot move stays with a note. OMP is replaced by a
// stand-in `omp` on PATH that keeps its plugin state in a JSON file; the real
// CLI behind these commands is exercised by the sandbox acceptance runs.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMapping } from "../agent/extensions/omp-config-autoupdate/merge.ts";
import { type ApplyReport, applySnapshot } from "../agent/extensions/omp-config-autoupdate/omp-config-update.ts";

const UPDATER = join(import.meta.dir, "../agent/extensions/omp-config-autoupdate/omp-config-update.ts");
const MANIFEST = readFileSync(join(import.meta.dir, "../agent/extensions/_shared/package.json"), "utf8");
const roots: string[] = [];

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

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

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function source(...snapshots: Record<string, string | null>[]): string {
	const dir = temp("omp-settings-src-");
	const git = (...args: string[]): void => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	};
	git("init", "-q");
	for (const files of snapshots) {
		writeTree(dir, files);
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", "snapshot");
	}
	return dir;
}

/** Stand-in for the four `omp plugin` commands the updater uses; state and calls in $FAKE_OMP_STATE. */
const FAKE_OMP = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const file = process.env.FAKE_OMP_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { path: null, settings: {}, calls: [], refuse: [] };
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const fail = (text) => { save(); process.stderr.write(text + "\\n"); process.exit(1); };
const [group, command, ...rest] = args;
if (group !== "plugin") fail("unsupported");
if (command === "list") {
	save();
	console.log(JSON.stringify({ npm: state.path === null ? [] : [{ name: "omp-config", version: "1.0.0", path: state.path }], marketplace: [] }));
} else if (command === "link") {
	if (!existsSync(join(rest[0], "package.json"))) fail("package.json not found");
	state.path = rest[0];
	save();
} else if (command === "config" && rest[0] === "list") {
	if (state.path === null) fail('Plugin "omp-config" not found');
	save();
	console.log(JSON.stringify({ settings: state.settings, schema: {} }));
} else if (command === "config" && rest[0] === "set") {
	const [, , key, ...value] = rest;
	const schema = JSON.parse(readFileSync(join(state.path, "package.json"), "utf8")).omp.settings[key];
	const text = value.join(" ");
	if (schema === undefined || state.refuse.includes(key)) fail("refused " + key);
	const parsed = schema.type === "number" ? Number(text) : schema.type === "boolean" ? text === "true" : text;
	if (schema.type === "enum" && !schema.values.includes(parsed)) fail("not allowed");
	state.settings[key] = parsed;
	save();
} else fail("unsupported");
`;

type FakeState = { path: string | null; settings: Record<string, unknown>; calls: string[]; refuse: string[] };

function fakeOmp(initial: Partial<FakeState> = {}): { readonly env: Record<string, string>; readonly state: () => FakeState } {
	const bin = temp("omp-fake-bin-");
	writeFileSync(join(bin, "omp"), FAKE_OMP);
	chmodSync(join(bin, "omp"), 0o755);
	const file = join(temp("omp-fake-state-"), "state.json");
	writeFileSync(file, JSON.stringify({ path: null, settings: {}, calls: [], refuse: [], ...initial }));
	return {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: temp("omp-fake-home-"), FAKE_OMP_STATE: file } as Record<
			string,
			string
		>,
		state: () => JSON.parse(readFileSync(file, "utf8")),
	};
}

function applyCli(src: string, agentDir: string, env: Record<string, string>, ...extra: string[]): ApplyReport {
	const result = spawnSync("bun", [UPDATER, "apply", "--source", src, "--agent-dir", agentDir, "--json", ...extra], {
		encoding: "utf8",
		env,
	});
	if (result.status !== 0 && result.stdout.trim() === "") throw new Error(`updater failed: ${result.stderr}`);
	const report: unknown = JSON.parse(result.stdout);
	if (!isMapping(report)) throw new Error("no report");
	return report as unknown as ApplyReport; // the updater's own --json output
}

const SHIPPED_RULES =
	"tool-topic-injection:\n  rules:\n    - id: read-ssh\n      tool: read\n      parameter: path\n      pattern: '^ssh://'\n      topic: tool://read/ssh\n";
const HOST_RULES = `tool-topic-injection:\n  rules:\n    - id: read-ssh\n      tool: read\n      parameter: path\n      pattern: ^ssh://\n      topic: tool://read/ssh\n`;

/** A repo whose history once shipped the omomp file, and now ships the manifest instead. */
const repo = (extra: Record<string, string | null> = {}): string =>
	source(
		{ "agent/omomp.yml": `${SHIPPED_RULES}lang-nag:\n  language: 中文\n  instruction: 说中文\n` },
		{
			"agent/omomp.yml": null,
			"agent/extensions/_shared/package.json": MANIFEST,
			...extra,
		},
	);

const HOST_OMOMP = [
	"lang-nag:",
	"  language: 中文",
	"  instruction: speak plainly",
	"input-polish:",
	"  key: ctrl+enter",
	"  instruction: tighten it",
	"  fallbackRole: smol",
	"tool-policy-nag:",
	"  detector: heuristic",
	"  form:",
	"    prompt: 你为什么不遵守system prompt，反思自己以后继续。",
	"    afterHits: 5",
	"    maxNags: 3",
	"  intent:",
	"    threshold: 0.5",
	"  risk:",
	"    minCommands: 4",
	"    minChars: 600",
	"    minPrograms: 3",
	"  pty: {}",
	"task-split-check:",
	"  fallbackRole: smol",
	"  agents:",
	"    - task:free1",
	"    - task:gone",
	"model-compaction:",
	"  rules:",
	'    - model: "[gG][pP][tT]"',
	"      thresholdTokens: 650000",
	"omp-config-autoupdate:",
	"  enabled: true",
	"  exclude:",
	"    - PERSONALITY.md",
	"judge:",
	"  fallbackRole: tiny",
	"omp-unified-exec:",
	"  stop: off",
	HOST_RULES.trimEnd(),
	"",
].join("\n");

const AGENT = "---\nname: task:free1\ndescription: worker\ncompletionJudge: true\n---\nBody.\n";

describe("settings move", () => {
	test("omp-config sections move into plugin settings and md files; other owners' sections stay; a rerun changes nothing", () => {
		const src = repo({ "agent/PERSONALITY.md": "repo\n" });
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, { "omomp.yml": HOST_OMOMP, "agents/free1.md": AGENT, "PERSONALITY.md": "mine\n" });
		const omp = fakeOmp();
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		const state = omp.state();
		expect(state.path).toBe(join(agentDir, "extensions/_shared"));
		expect(state.settings).toEqual({
			"lang-nag.instruction": "speak plainly",
			"input-polish.instruction": "tighten it",
			"tool-policy-nag.form.afterHits": 5,
			"omp-config-autoupdate.enabled": true,
			"omp-config-autoupdate.exclude": "PERSONALITY.md",
		});
		// The exclude list still in the omomp file already applied in this run.
		expect(readFileSync(join(agentDir, "PERSONALITY.md"), "utf8")).toBe("mine\n");
		expect(report.skipped).toContainEqual({ path: join(agentDir, "PERSONALITY.md"), reason: expect.stringContaining("exclude") });
		expect(readFileSync(join(agentDir, "omomp.yml"), "utf8")).toBe("omp-unified-exec:\n  stop: off\n");
		expect(readFileSync(join(agentDir, "extensions/model-compaction/COMPACTION-rule-01.md"), "utf8")).toBe(
			"---\nmodel: [gG][pP][tT]\nthresholdTokens: 650000\n---\n",
		);
		expect(readFileSync(join(agentDir, "agents/free1.md"), "utf8")).toBe(
			"---\nname: task:free1\ndescription: worker\ncompletionJudge: true\nsplitCheck: true\n---\nBody.\n",
		);
		expect(report.notes).toContain("input-polish.fallbackRole (smol) dropped: assign @input-polish in /model, or it uses the default role");
		expect(report.notes).toContain("judge.fallbackRole (tiny) dropped: an unassigned @<purpose> role now uses OMP's judge role chain");
		expect(report.notes).toContain(
			"task-split-check.agents names task:gone, which no agents/*.md defines; add splitCheck: true to its definition",
		);

		const again = applyCli(src, agentDir, omp.env);
		expect(again.errors).toEqual([]);
		expect(again.written).toEqual([]);
		expect(again.deleted).toEqual([]);
		expect(omp.state().calls.filter((call) => call.includes(" set ") || call.includes(" link "))).toEqual(
			state.calls.filter((call) => call.includes(" set ") || call.includes(" link ")),
		);
		// The exclude option is now the plugin setting.
		expect(readFileSync(join(agentDir, "PERSONALITY.md"), "utf8")).toBe("mine\n");
	});

	test("a key the machine already set keeps its plugin value; the section still leaves; an empty file is deleted", () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, { "omomp.yml": "lang-nag:\n  language: 中文\n  instruction: from omomp\n" });
		const omp = fakeOmp({ path: join(agentDir, "extensions/_shared"), settings: { "lang-nag.instruction": "from settings" } });
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		expect(omp.state().settings).toEqual({ "lang-nag.instruction": "from settings" });
		expect(report.notes).toContain(
			'plugin setting lang-nag.instruction already set ("from settings"); omomp value "from omomp" not applied',
		);
		expect(existsSync(join(agentDir, "omomp.yml"))).toBe(false);
		expect(report.deleted).toContain(join(agentDir, "omomp.yml"));
	});

	test("invalid, customized, refused and excluded sections stay with a note while the rest moves", () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		const customRules = HOST_RULES.replace("^ssh://", "^sftp://");
		writeTree(agentDir, {
			"omomp.yml": `tool-policy-nag:\n  detector: other\nchild-memory-warning:\n  thresholdGiB: 8\ndoc-polish:\n  concurrency: 2\nsubagent-usage:\n  enabled: true\nomp-config-autoupdate:\n  enabled: false\n  exclude:\n    - omomp.yml:subagent-usage\n${customRules}`,
		});
		const omp = fakeOmp({ refuse: ["doc-polish.concurrency"] });
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		expect(omp.state().settings).toEqual({
			"child-memory-warning.thresholdGiB": 8,
			"omp-config-autoupdate.exclude": "omomp.yml:subagent-usage",
		});
		const left: unknown = Bun.YAML.parse(readFileSync(join(agentDir, "omomp.yml"), "utf8"));
		expect(isMapping(left) && Object.keys(left).toSorted()).toEqual([
			"doc-polish",
			"subagent-usage",
			"tool-policy-nag",
			"tool-topic-injection",
		]);
		expect(
			report.notes.some((note) => note.startsWith("omomp section tool-policy-nag left in place: tool-policy-nag.detector must be one of")),
		).toBe(true);
		expect(report.notes.some((note) => note.startsWith("omomp section tool-topic-injection left in place: customized rules"))).toBe(true);
		expect(report.notes.some((note) => note.startsWith("omomp section doc-polish left in place: omp plugin config set: refused"))).toBe(
			true,
		);
		expect(report.skipped).toContainEqual({
			path: `${join(agentDir, "omomp.yml")}:subagent-usage`,
			reason: expect.stringContaining("exclude"),
		});
	});

	test("an old standalone JSON moves and is deleted; an app-managed one is left alone", () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		const managed = JSON.stringify({ detector: "heuristic", note: ["marker:", "_otty"].join(" ") });
		writeTree(agentDir, {
			"extensions/lang-nag/lang-nag.json": JSON.stringify({ language: "English", instruction: "Reply in English" }),
			"extensions/tool-policy-nag/tool-policy-nag.json": managed,
		});
		const omp = fakeOmp();
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		expect(omp.state().settings).toEqual({ "lang-nag.language": "English", "lang-nag.instruction": "Reply in English" });
		expect(existsSync(join(agentDir, "extensions/lang-nag/lang-nag.json"))).toBe(false);
		expect(readFileSync(join(agentDir, "extensions/tool-policy-nag/tool-policy-nag.json"), "utf8")).toBe(managed);
		expect(report.notes.some((note) => note.includes("tool-policy-nag.json is app-managed"))).toBe(true);
	});

	test("--check and --no-plugins report the move and change nothing", async () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, { "omomp.yml": HOST_OMOMP, "agents/free1.md": AGENT });
		const omp = fakeOmp();
		const checked = applyCli(src, agentDir, omp.env, "--check");
		expect(checked.errors).toEqual([]);
		expect(
			checked.notes.some(
				(note) =>
					note.startsWith("omomp sections apply moves into plugin omp-config: ") && note.includes("lang-nag: lang-nag.instruction="),
			),
		).toBe(true);
		expect(omp.state().calls.every((call) => !call.includes(" set ") && !call.includes(" link "))).toBe(true);
		const offline = await applySnapshot({ source: src, agentDir, previousCommit: undefined, check: false, plugins: false });
		expect(offline.errors).toEqual([]);
		expect(offline.notes.some((note) => note.startsWith("omomp sections left in place without plugin steps"))).toBe(true);
		expect(readFileSync(join(agentDir, "omomp.yml"), "utf8")).toBe(HOST_OMOMP);
		expect(readFileSync(join(agentDir, "agents/free1.md"), "utf8")).toBe(AGENT);
	});
});
