// delete-guard eval entry: py and js deletion APIs block (aliases and cross-cell
// distinctive names included), commands handed to a shell or spawned are
// classified by the posix classifier, non-literal commands block, and ordinary
// cells pass.
import { describe, expect, test } from "bun:test";
import { classifyJs } from "../agent/extensions/delete-guard/eval-js.ts";
import { classifyPy } from "../agent/extensions/delete-guard/eval-py.ts";
import type { Dialect } from "../agent/extensions/delete-guard/verdict.ts";

const POSIX: Dialect = { kind: "posix" };
const pyRule = (code: string): string => {
	const verdict = classifyPy(code, POSIX, POSIX);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};
const jsRule = async (code: string): Promise<string> => {
	const verdict = await classifyJs(code, POSIX, POSIX);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};

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
	])("allows: %p", async (code) => {
		expect(await jsRule(code)).toBe("allow");
	});
});
