// delete-guard eval entry: py and js deletion APIs block (aliases and cross-cell
// distinctive names included), commands handed to a shell or spawned are
// classified by the posix classifier, non-literal commands block, and ordinary
// cells pass. A launch whose command shape the source does not fix (spread,
// duplicate, computed or accessor key, spread argument) blocks as non-literal.
// Launcher aliases bound in one js cell, or in an earlier cell of the session
// until a reset cell, judge as their launcher.
import { describe, expect, test } from "bun:test";
import { EMPTY_CARRY } from "../agent/extensions/_shared/eval-js-launches.ts";
import { classifyJs } from "../agent/extensions/delete-guard/eval-js.ts";
import { classifyPy } from "../agent/extensions/delete-guard/eval-py.ts";
import { type EvalSession, guardToolCall, newEvalSession, resetEvalSession } from "../agent/extensions/delete-guard/guard.ts";
import type { Dialect } from "../agent/extensions/delete-guard/verdict.ts";

const POSIX: Dialect = { kind: "posix" };
const pyRule = (code: string): string => {
	const verdict = classifyPy(code, POSIX, POSIX);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};
const jsRule = async (code: string): Promise<string> => {
	const { verdict } = await classifyJs(code, POSIX, POSIX, EMPTY_CARRY);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};
const jsEval = (code: string, session: EvalSession, reset = false) =>
	guardToolCall("eval", { language: "js", code, reset }, () => true, session);

describe("python cells", () => {
	test.each([
		'import shutil; shutil.rmtree("/tmp/omp-dg-c3/d")',
		'import os; os.remove("/tmp/omp-dg-c3/d/f")',
		'from pathlib import Path; Path("/tmp/omp-dg-c3/d/f").unlink()',
		'from shutil import rmtree as r; r("/tmp/omp-dg-c3/d")',
		'import os as o\no.remove("f")',
		'from os import remove\nremove("f")',
		'clean_tree("d")  # alias made earlier\nimport shutil; x = shutil.rmtree',
		"list(map(os.unlink, files))",
		"p.rmdir()",
		'import subprocess; subprocess.run("rm -rf /tmp/omp-dg-c3/d", shell=True)',
		'import subprocess; subprocess.run(["rm", "/tmp/omp-dg-c3/d/f"])',
		'import subprocess as sp\nsp.check_call(("unlink", "f"))',
		'os.system("rm f")',
		'subprocess.Popen("rm -rf d", shell=True)',
		'await asyncio.create_subprocess_shell("rm f")',
		'await asyncio.create_subprocess_exec("rm", "f")',
		'await tool.bash({"command": "rm /tmp/omp-dg-c3/d/f"})',
		"!rm -rf /tmp/omp-dg-c3/d",
		"out = !rm f",
		"%%bash\nrm -rf d\n",
		"%time shutil.rmtree('d')",
		"%%capture out\nos.remove('f')\n",
		'print(f"{shutil.rmtree(p)}")',
		'os.system("\\x72m f")',
		"def cleanup(p):\n    shutil.rmtree(p)\n",
		'from os import remove as erase; erase("/tmp/omp-dg-c3/d/f")',
		"import os; f\"{1:{os.remove('/tmp/omp-dg-c3/d/f')}}\"",
		'import subprocess; flag = True; subprocess.run("echo ok; rm /tmp/omp-dg-c3/d/f", shell=flag)',
	])("blocks deletion: %p", (code) => {
		expect(pyRule(code)).toBe("delete");
	});

	test.each([
		'p="/tmp/omp-dg-c3/d"; import os; os.system(f"ls {p}")',
		"import subprocess; subprocess.run(cmd, shell=True)",
		"import subprocess; subprocess.run([prog, 'x'])",
		"subprocess.check_output(command)",
		'await tool.bash({"command": cmd})',
		"!echo 'rm f' | sh",
		"x = 'unterminated",
		"print((1, 2)",
	])("blocks non-literal: %p", (code) => {
		expect(pyRule(code)).toBe("nonLiteral");
	});

	test.each([
		'import subprocess; print(subprocess.run(["ls", "/tmp/omp-dg-c3/d"], capture_output=True, text=True).stdout)',
		'print("shutil.rmtree is banned")  # os.remove',
		"items.remove(3)",
		'subprocess.run(["git", "status"], check=True)',
		"!ls -la",
		"%%bash\necho ok\n",
		"%run script.py",
		'open("out.txt", "w").write("x")',
		'x = {"a": 1}\nprint(f"{x[\'a\']:>4}")',
		"def unlink_handler(): pass",
		"if a != b: print('!')",
		'await tool.bash({"command": "ls -la"})',
		'import subprocess; subprocess.run(["ls", "-l"], shell=False)',
		'x = f"{3.14159:.{2}f}"; print(x)',
		"constructor = 1; print(constructor)",
	])("allows: %p", (code) => {
		expect(pyRule(code)).toBe("allow");
	});
});

describe("js cells", () => {
	test.each([
		'require("node:fs").rmSync("/tmp/omp-dg-c3/d", {recursive:true})',
		'const { unlinkSync } = require("fs"); unlinkSync("/tmp/omp-dg-c3/d/f")',
		'await Bun.file("/tmp/omp-dg-c3/d/f").delete()',
		"const f = Bun.file(p); await f.delete()",
		'import { rm } from "node:fs/promises"; await rm("d", { recursive: true })',
		'import * as fs from "fs"; fs.rm("d", () => {})',
		'const fsp = require("fs").promises; await fsp.rm("d")',
		"paths.forEach(fs.unlinkSync)",
		"removeFile(p); const { unlinkSync: removeFile } = require('fs')",
		"await Bun.$`rm -rf /tmp/omp-dg-c3/d`",
		'await tool.bash({ command: "rm /tmp/omp-dg-c3/d/f" })',
		'require("child_process").execSync("rm -rf d")',
		'const cp = require("node:child_process"); cp.exec("unlink f")',
		'import { spawnSync } from "child_process"; spawnSync("rm", ["f"])',
		'const cp = require("child_process"); cp.spawn("sh", ["-c", "rm f"])',
		'execFileSync("rm", ["f"])',
		'Bun.spawn(["rm", "f"])',
		'Bun.spawnSync({ cmd: ["rm", "-rf", "d"] })',
		'require("child_process").spawn("rm f", { shell: true })',
		'await tool.write({ path: "xd://bash", content: JSON.stringify({ command: "rm f" }) })',
		'const fs = require("node:fs"); await fs.promises.rm("/tmp/omp-dg-c3/d/f")',
		'import { promises as fsp } from "fs"; await fsp.rm("/tmp/omp-dg-c3/d/f")',
		'const { promises: fsp } = require("fs"); await fsp.rm("/tmp/omp-dg-c3/d/f")',
		'const cp = require("child_process"); cp.spawn("echo ok; rm /tmp/omp-dg-c3/d/f", [], { shell: "/bin/sh" })',
		'const cp = require("child_process"); cp.spawn("echo ok; rm /tmp/omp-dg-c3/d/f", [], { shell: flag })',
		// Launcher aliases, same cell (the issue's 结果 4).
		"const $ = Bun.$; await $`rm -rf x`",
		"const a = Bun.$; const b = a; await b`rm -rf x`",
		"const sh = Bun.$; await sh`rm -rf x`",
		"const s = Bun.spawn; s(['rm', '-rf', 'x'])",
		"let s; s = Bun.spawn; s(['rm', '-rf', 'x'])",
		"const { spawn } = Bun; spawn(['rm', 'x'])",
		"const t = tool.bash; await t({ command: 'rm -rf x' })",
		"const e = require('child_process').execSync; e('rm -rf x')",
		"const cp = require('child_process'); const e = cp.execSync; e('rm -rf x')",
	])("blocks deletion: %p", async (code) => {
		expect(await jsRule(code)).toBe("delete");
	});

	test.each([
		`await Bun.$\`rm \${p}\``,
		`await Bun.$\`ls \${dir}\``,
		'require("child_process").execSync(cmd)',
		`require('child_process').execSync(\`ls \${dir}\`)`,
		"Bun.spawn([prog, 'x'])",
		"Bun.spawn(argv)",
		"await tool.bash({ command: cmd })",
		// Shapes the source does not fix (issue 结果 1–3).
		"await tool.bash({ command: 'ls', command: 'rm -rf x' })",
		"await tool.bash({ command: 'ls', command() { return 'rm -rf x' } })",
		"const k = 'command'; await tool.bash({ command: 'ls', [k]: 'rm -rf x' })",
		"require('child_process').spawn('rm -rf x', { shell: false, shell: true })",
		"require('child_process').spawn('rm -rf x', { get shell() { return true; } })",
		"require('child_process').spawn('rm -rf x', { ...opts })",
		"const { execSync } = require('child_process'); execSync(...['rm -rf x'], 'ls')",
		"const f = ['-delete']; Bun.spawn(['find', 'x', ...f])",
		"const f = ['-delete']; require('child_process').spawnSync('find', ['x', ...g])",
		"await tool.write({ path: 'xd://bash', content: JSON.stringify({ command: 'ls', command: 'rm -rf x' }) })",
	])("blocks non-literal: %p", async (code) => {
		expect(await jsRule(code)).toBe("nonLiteral");
	});

	test.each([
		"console.log(1 + 1)",
		'const m = new Map(); m.delete("k")',
		"cache.rm(key)",
		'const s = "fs.rmSync is banned"; // unlinkSync',
		'require("child_process").execSync("git status")',
		'Bun.spawn(["ls", "-la"])',
		"await Bun.$`echo ok`",
		"const re = /rm -rf/; console.log(re.test(x))",
		'await Bun.write("out.txt", "x")',
		"const o = { unlink() {} }",
		'await tool.bash({ command: "ls" })',
		"console.log((123).toString())",
		'const o = { a: 1 }; o.hasOwnProperty("a")',
		'const cp = require("child_process"); cp.spawn("ls", ["-l"], { cwd: "/tmp" })',
		// Literal forms whose verdict is unchanged (issue 结果 6).
		"require('child_process').execSync('echo ok')",
		"const { execSync } = require('child_process'); execSync('echo ok')",
		"const e = require('child_process').execSync; e('echo ok')",
		"await tool.bash({ 'command': `ls` })",
		"await tool.bash({ ['command']: 'ls' })",
		"const cp = require('child_process'); cp.spawn('ls', ['-l'], { ['cwd']: '/tmp' })",
		"const $ = 5; console.log($)",
	])("allows: %p", async (code) => {
		expect(await jsRule(code)).toBe("allow");
	});
});

describe("python cells: issue 151 bypasses", () => {
	test.each([
		"!echo ok\n!rm -rf /tmp/omp-dg-c3/d",
		"%sx rm -rf /tmp/omp-dg-c3/d",
		"%system rm -rf /tmp/omp-dg-c3/d",
		"import subprocess\nsubprocess.Popen('rm -rf x', -1, None, None, None, None, None, True, True)",
		"import subprocess\nsubprocess.call('rm -rf x', -1, None, None, None, None, None, True, True)",
		"await tool.write({'path': 'xd://bash', 'content': '{\"command\": \"rm -rf x\"}'})",
		"import json\nawait tool.write({'path': 'xd://bash', 'content': json.dumps({'command': 'rm -rf x'})})",
		"exec(\"import subprocess\\nsubprocess.run('rm -rf x', shell=True)\")",
		"exec(\"import os\\nos.system('rm -rf x')\")",
		"eval(\"__import__('os').system('rm -rf x')\")",
		"__import__('subprocess').run(['rm', '-rf', 'x'])",
		"import importlib\nsp = importlib.import_module('subprocess')\nsp.run(['rm', '-rf', 'x'])",
		"import importlib\nimportlib.import_module('subprocess').run(['rm', '-rf', 'x'])",
	])("blocks deletion: %p", (code) => {
		expect(pyRule(code)).toBe("delete");
	});

	test.each([
		"import subprocess\nsubprocess.run('rm -rf x', **{'shell': True})",
		"import subprocess\nsubprocess.run(['ls'], **opts)",
		"await tool.bash(**kw)",
		"await tool.write({'path': 'xd://bash', 'content': payload})",
		"await tool.write({'path': 'xd://bash', 'content': 'not json'})",
		"exec(code)",
		'exec("print(1)", **kw)',
		"name = 'subprocess'\n__import__(name).run(['rm', '-rf', 'x'])",
		"__import__(n)",
		"import importlib\nmod = 'subprocess'\nimportlib.import_module(mod).run(['rm', '-rf', 'x'])",
		"import importlib\nimportlib.import_module('.sub', package='p')",
	])("blocks non-literal: %p", (code) => {
		expect(pyRule(code)).toBe("nonLiteral");
	});

	test.each([
		"import subprocess\nsubprocess.run(['ls', 'd'])",
		"import subprocess\nsubprocess.call(['ls', 'd'], -1, None, None, None, None, None, True, False)",
		"import subprocess\nsubprocess.call(['ls', 'd'], -1, None, None, None, None, None, True, None)",
		"print(1 + 1)",
		'exec("print(1 + 1)")',
		"await tool.write({'path': 'xd://bash', 'content': '{\"command\": \"ls\"}'})",
		"!echo ok\n!ls -la",
		"%sx ls -la",
		"s = '''\n!rm -rf x\n'''",
		"def exec(src):\n    return src",
		"import importlib\nm = importlib.import_module('json')\nm.dumps({})",
		"import json\nprint(json.dumps({'command': 'ls'}))",
	])("allows: %p", (code) => {
		expect(pyRule(code)).toBe("allow");
	});
});

describe("launcher names carried between js cells", () => {
	test("a bound launcher name blocks in a later cell, and a module alias too", async () => {
		const first = await classifyJs("const $ = Bun.$; const cp = require('child_process')", POSIX, POSIX, EMPTY_CARRY);
		expect(first.verdict.kind).toBe("allow");
		expect((await classifyJs("await $`rm -rf x`", POSIX, POSIX, first.carry)).verdict.kind).toBe("block");
		expect((await classifyJs("cp.execSync('rm -rf x')", POSIX, POSIX, first.carry)).verdict.kind).toBe("block");
	});

	test("a cell that is blocked binds nothing", async () => {
		const session = newEvalSession();
		expect(await jsEval("const t = tool.bash; await t({ command: 'rm -rf x' })", session)).toMatchObject({ block: true });
		expect(await jsEval("await t({ command: 'rm -rf x' })", session)).toBeUndefined();
	});

	test("the hook judges cells in order: a reset cell clears launcher names, a python reset does not", async () => {
		const session = newEvalSession();
		expect(await jsEval("const s = Bun.spawn", session)).toBeUndefined();
		expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toMatchObject({ block: true });
		// A python reset wipes python's kernel only; the js alias still binds.
		expect(await guardToolCall("eval", { language: "py", code: "1", reset: true }, () => true, session)).toBeUndefined();
		expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toMatchObject({ block: true });
		// A js reset cell runs in a fresh kernel: the alias is gone, the call is not a launch.
		expect(await jsEval("1 + 1", session, true)).toBeUndefined();
		expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toBeUndefined();
	});
});

describe("standalone percent commands in js cells", () => {
	test.each([
		"%load skill://omp-subagent-more/orchestrate.js",
		"  %load /tmp/probe.js\n",
		"%bun add is-number",
		"%environment managed",
		"%pip install requests",
	])("%s passes", async (code) => {
		expect(await jsEval(code, newEvalSession())).toBeUndefined();
	});

	test.each([
		"%load /tmp/probe.js\nrequire('fs').rmSync('/tmp/omp-dg-c3/d', { recursive: true })",
		"%load /tmp/a.js\n%load /tmp/b.js",
		"%run /tmp/probe.js",
	])("%s is still parsed as js, which throws to the hook boundary that blocks it", async (code) => {
		expect(jsEval(code, newEvalSession())).rejects.toThrow();
	});

	test("a percent cell keeps the session's launcher names; a reset percent cell clears them", async () => {
		const session = newEvalSession();
		expect(await jsEval("const s = Bun.spawn", session)).toBeUndefined();
		expect(await jsEval("%load /tmp/probe.js", session)).toBeUndefined();
		expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toMatchObject({ block: true });
		expect(await jsEval("%load /tmp/probe.js", session, true)).toBeUndefined();
		expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toBeUndefined();
	});
});

test("a session switch resets the launcher names: an old alias no longer blocks", async () => {
	const session = newEvalSession();
	expect(await jsEval("const s = Bun.spawn", session)).toBeUndefined();
	expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toMatchObject({ block: true });
	resetEvalSession(session);
	expect(await jsEval("s(['rm', '-rf', 'x'])", session)).toBeUndefined();
});
