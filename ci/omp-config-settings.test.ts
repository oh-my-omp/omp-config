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
import { parseManifest } from "../agent/extensions/omp-config-autoupdate/omomp-migration.ts";
import { type ApplyReport, applySnapshot } from "../agent/extensions/omp-config-autoupdate/omp-config-update.ts";
import { migrateProject, planProject } from "../agent/extensions/omp-config-autoupdate/project-migration.ts";

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

/**
 * Stand-in for the four `omp plugin` commands the updater uses; state and calls in $FAKE_OMP_STATE. Like OMP, `config list` lays the cwd's `.omp/plugin-overrides.json` over the machine's settings.
 * With `clobber`, `config list` also plays another writer of the agent dir's `config.yml`, rebinding a `"@smol"` `input-polish` role to `x/other`.
 */
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
	if (state.clobber) {
		const config = join(state.path, "..", "..", "config.yml");
		if (existsSync(config)) writeFileSync(config, readFileSync(config, "utf8").replace(/^(  input-polish: ).*@smol.*$/m, "$1x/other"));
	}
	const overrides = join(process.cwd(), ".omp", "plugin-overrides.json");
	const project = existsSync(overrides) ? (JSON.parse(readFileSync(overrides, "utf8")).settings?.["omp-config"] ?? {}) : {};
	console.log(JSON.stringify({ settings: { ...state.settings, ...project }, schema: {} }));
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

type FakeState = { path: string | null; settings: Record<string, unknown>; calls: string[]; refuse: string[]; clobber?: boolean };

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

function applyCli(
	src: string,
	agentDir: string,
	env: Record<string, string>,
	{ extra = [], cwd }: { readonly extra?: readonly string[]; readonly cwd?: string } = {},
): ApplyReport {
	const result = spawnSync("bun", [UPDATER, "apply", "--source", src, "--agent-dir", agentDir, "--json", ...extra], {
		encoding: "utf8",
		env,
		cwd,
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
	test("omp-config sections move into plugin settings, md files and unassigned roles; other owners' sections stay; a rerun changes nothing", () => {
		const src = repo({ "agent/PERSONALITY.md": "repo\n" });
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, {
			"omomp.yml": HOST_OMOMP,
			"agents/free1.md": AGENT,
			"PERSONALITY.md": "mine\n",
			"config.yml": "modelRoles:\n  default: x/main\n  task-split-check: x/pinned:medium\n",
		});
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
		// fallbackRole becomes a reference to that role, only where the machine assigned none.
		expect(Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8"))).toEqual({
			modelRoles: { default: "x/main", "task-split-check": "x/pinned:medium", "input-polish": "@smol" },
		});
		expect(report.notes).toContain("input-polish.fallbackRole became modelRoles.input-polish: @smol");
		expect(report.notes).toContain(
			'modelRoles.task-split-check already assigned ("x/pinned:medium"); task-split-check.fallbackRole @smol not applied',
		);
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

	test("a project's plugin-overrides.json does not hide the machine's settings: the move still writes the machine value", () => {
		const src = repo({ "agent/PERSONALITY.md": "repo\n" });
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, {
			"omomp.yml": "lang-nag:\n  language: 中文\n  instruction: from omomp\nomp-config-autoupdate:\n  exclude:\n    - PERSONALITY.md\n",
			"PERSONALITY.md": "mine\n",
		});
		// The updater runs from a project whose overrides set both keys; OMP lists them only for that cwd.
		const project = temp("omp-settings-project-");
		writeTree(project, {
			".omp/plugin-overrides.json": JSON.stringify({
				settings: { "omp-config": { "lang-nag.instruction": "from project", "omp-config-autoupdate.exclude": "" } },
			}),
		});
		const omp = fakeOmp();
		const report = applyCli(src, agentDir, omp.env, { cwd: project });
		expect(report.errors).toEqual([]);
		expect(omp.state().settings).toEqual({ "lang-nag.instruction": "from omomp", "omp-config-autoupdate.exclude": "PERSONALITY.md" });
		expect(report.notes.some((note) => note.includes("already set"))).toBe(false);
		expect(readFileSync(join(agentDir, "PERSONALITY.md"), "utf8")).toBe("mine\n");
		expect(existsSync(join(agentDir, "omomp.yml"))).toBe(false);
	});

	test("a role binding that reads back with another value keeps its section", () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		writeTree(agentDir, {
			"omomp.yml": "input-polish:\n  fallbackRole: smol\n",
			"config.yml": "modelRoles:\n  default: x/main\n",
		});
		const omp = fakeOmp({ clobber: true });
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		expect(report.notes).toContain("input-polish.fallbackRole became modelRoles.input-polish: @smol");
		expect(Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8"))).toEqual({
			modelRoles: { default: "x/main", "input-polish": "x/other" },
		});
		expect(report.notes).toContain('omomp section input-polish left in place: not stored: modelRoles.input-polish as "@smol"');
		expect(readFileSync(join(agentDir, "omomp.yml"), "utf8")).toBe("input-polish:\n  fallbackRole: smol\n");
	});

	test("invalid, customized, refused and excluded sections stay with a note while the rest moves and retired ones drop", () => {
		const src = repo();
		const agentDir = temp("omp-settings-agent-");
		const customRules = HOST_RULES.replace("^ssh://", "^sftp://");
		writeTree(agentDir, {
			"omomp.yml": `tool-policy-nag:\n  detector: other\nchild-memory-warning:\n  thresholdGiB: 8\nlang-nag:\n  language: German\ndoc-polish:\n  concurrency: 2\n  fallbackRole: smol\nsubagent-usage:\n  enabled: true\nomp-config-autoupdate:\n  enabled: false\n  exclude:\n    - omomp.yml:subagent-usage\n${customRules}`,
		});
		const omp = fakeOmp({ refuse: ["lang-nag.language"] });
		const report = applyCli(src, agentDir, omp.env);
		expect(report.errors).toEqual([]);
		expect(omp.state().settings).toEqual({
			"child-memory-warning.thresholdGiB": 8,
			"omp-config-autoupdate.exclude": "omomp.yml:subagent-usage",
		});
		const left: unknown = Bun.YAML.parse(readFileSync(join(agentDir, "omomp.yml"), "utf8"));
		expect(isMapping(left) && Object.keys(left).toSorted()).toEqual([
			"lang-nag",
			"subagent-usage",
			"tool-policy-nag",
			"tool-topic-injection",
		]);
		expect(
			report.notes.some((note) => note.startsWith("omomp section tool-policy-nag left in place: tool-policy-nag.detector must be one of")),
		).toBe(true);
		expect(report.notes.some((note) => note.startsWith("omomp section tool-topic-injection left in place: customized rules"))).toBe(true);
		expect(report.notes.some((note) => note.startsWith("omomp section lang-nag left in place: omp plugin config set: refused"))).toBe(true);
		expect(report.notes).toContain("doc-polish section dropped: the doc-polish extension is retired");
		expect(existsSync(join(agentDir, "config.yml")) && readFileSync(join(agentDir, "config.yml"), "utf8").includes("doc-polish")).toBe(
			false,
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
		const checked = applyCli(src, agentDir, omp.env, { extra: ["--check"] });
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

// A project's `.omp/omomp.*`: moved into the project itself when a main session starts there.
describe("project sections move", () => {
	const manifest = parseManifest(MANIFEST, "package.json");
	const PROJECT_OMOMP = [
		"# Project omomp sections; each replaces the machine's section of the same name.",
		"model-compaction:",
		"  rules:",
		'    - model: "argon"',
		"      thresholdTokens: 350000",
		'    - model: ".*"',
		"      thresholdTokens: 450000",
		"lang-nag:",
		"  instruction: project voice",
		"input-polish:",
		"  fallbackRole: smol",
		"omomp-lang:",
		"  language: en",
		"",
	].join("\n");

	test("scalars become project overrides and rules project COMPACTION files; sections with no project-level place stay", () => {
		const project = temp("omp-project-");
		writeTree(project, {
			".omp/omomp.yml": PROJECT_OMOMP,
			".omp/plugin-overrides.json": JSON.stringify({ disabled: ["other"], settings: { "omp-config": { "lang-nag.language": "English" } } }),
		});
		const work = planProject(project, manifest);
		if (work.kind !== "ready") throw new Error(`expected a ready plan, got ${work.kind}`);
		expect(work.files.toSorted()).toEqual(
			[".omp/COMPACTION-rule-01.md", ".omp/COMPACTION-rule-02.md", ".omp/omomp.yml", ".omp/plugin-overrides.json"].map((rel) =>
				join(project, rel),
			),
		);
		const result = migrateProject(work);
		expect(result.kept.map((entry) => entry.section).toSorted()).toEqual(["input-polish", "omomp-lang"]);
		expect(JSON.parse(readFileSync(join(project, ".omp/plugin-overrides.json"), "utf8"))).toEqual({
			disabled: ["other"],
			settings: { "omp-config": { "lang-nag.language": "English", "lang-nag.instruction": "project voice" } },
		});
		expect(readFileSync(join(project, ".omp/COMPACTION-rule-01.md"), "utf8")).toBe("---\nmodel: argon\nthresholdTokens: 350000\n---\n");
		expect(readFileSync(join(project, ".omp/COMPACTION-rule-02.md"), "utf8")).toBe("---\nmodel: .*\nthresholdTokens: 450000\n---\n");
		expect(Bun.YAML.parse(readFileSync(join(project, ".omp/omomp.yml"), "utf8"))).toEqual({
			"input-polish": { fallbackRole: "smol" },
			"omomp-lang": { language: "en" },
		});
		// Only sections with no project-level place are left: nothing to write, so nothing to announce.
		const again = planProject(project, manifest);
		expect(again.kind === "stuck" && again.kept.map((entry) => entry.section).toSorted()).toEqual(["input-polish", "omomp-lang"]);
	});

	test("a file left with nothing is deleted; a project without omomp sections has nothing to move", () => {
		const project = temp("omp-project-");
		writeTree(project, { ".omp/omomp.yml": PROJECT_OMOMP.split("lang-nag:")[0]! });
		const work = planProject(project, manifest);
		if (work.kind !== "ready") throw new Error(`expected a ready plan, got ${work.kind}`);
		const result = migrateProject(work);
		expect(result.deleted).toEqual([join(project, ".omp/omomp.yml")]);
		expect(existsSync(join(project, ".omp/plugin-overrides.json"))).toBe(false);
		expect(planProject(project, manifest).kind).toBe("none");
	});

	const LANG_ONLY = "lang-nag:\n  instruction: project voice\n";
	const snapshot = (project: string, rels: readonly string[]): Record<string, string | null> =>
		Object.fromEntries(rels.map((rel) => [rel, existsSync(join(project, rel)) ? readFileSync(join(project, rel), "utf8") : null]));

	test("a key the project overrides already holds with the same value needs no write; the section leaves", () => {
		const project = temp("omp-project-");
		const overrides = JSON.stringify({ settings: { "omp-config": { "lang-nag.instruction": "project voice" } } });
		writeTree(project, { ".omp/omomp.yml": LANG_ONLY, ".omp/plugin-overrides.json": overrides });
		const work = planProject(project, manifest);
		if (work.kind !== "ready") throw new Error(`expected a ready plan, got ${work.kind}`);
		expect(work.files).toEqual([join(project, ".omp/omomp.yml")]);
		const result = migrateProject(work);
		expect(result).toEqual({ written: [], deleted: [join(project, ".omp/omomp.yml")], kept: [], notes: [] });
		expect(readFileSync(join(project, ".omp/plugin-overrides.json"), "utf8")).toBe(overrides);
	});

	test("a key the project overrides with another value keeps the whole section, naming the key; nothing is written", () => {
		const project = temp("omp-project-");
		const overrides = JSON.stringify({ settings: { "omp-config": { "lang-nag.instruction": "override voice" } } });
		writeTree(project, { ".omp/omomp.yml": `${LANG_ONLY}  language: English\n`, ".omp/plugin-overrides.json": overrides });
		const before = snapshot(project, [".omp/omomp.yml", ".omp/plugin-overrides.json"]);
		const work = planProject(project, manifest);
		expect(work).toEqual({
			kind: "stuck",
			path: join(project, ".omp/omomp.yml"),
			kept: [
				{
					section: "lang-nag",
					reason: `${join(project, ".omp/plugin-overrides.json")} conflicts: lang-nag.instruction is "override voice" there, "project voice" here; keep one value and delete the other`,
				},
			],
		});
		expect(snapshot(project, [".omp/omomp.yml", ".omp/plugin-overrides.json"])).toEqual(before);
	});

	test("an unreadable overrides file or a rule file with other content keeps those sections and plans no write", () => {
		const project = temp("omp-project-");
		const rules = PROJECT_OMOMP.split("lang-nag:")[0]!;
		writeTree(project, {
			".omp/omomp.yml": `${rules}${LANG_ONLY}`,
			".omp/plugin-overrides.json": "{ not json",
			".omp/COMPACTION-rule-01.md": "---\nmodel: mine\nthresholdTokens: 1000\n---\n",
		});
		const work = planProject(project, manifest);
		if (work.kind !== "stuck") throw new Error(`expected a stuck plan, got ${work.kind}`);
		expect(work.kept.map((entry) => entry.section)).toEqual(["lang-nag", "model-compaction"]);
		expect(work.kept[1]?.reason).toBe(`${join(project, ".omp/COMPACTION-rule-01.md")} already exists with other content`);
		expect(work.kept[0]?.reason).toStartWith(`${join(project, ".omp/plugin-overrides.json")}: `);
	});
});
