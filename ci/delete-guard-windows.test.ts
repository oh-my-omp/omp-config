// delete-guard Windows dialects: PowerShell and cmd reached from brush as
// nested shells (any platform), and the cmd/PowerShell classifiers on their own
// (eval's system shell on Windows). Deletions and non-literal scripts block;
// ordinary commands and argument-only mentions pass.
import { describe, expect, test } from "bun:test";
import { classify } from "../agent/extensions/delete-guard/classify.ts";
import { classifyPosix } from "../agent/extensions/delete-guard/posix.ts";
import type { Dialect, Verdict } from "../agent/extensions/delete-guard/verdict.ts";

const ruleFrom = (verdict: Verdict): string => (verdict.kind === "allow" ? "allow" : verdict.rule);
const ruleOf = (command: string): string => ruleFrom(classifyPosix(command, 0));
const ruleIn = (dialect: Dialect, text: string): string => ruleFrom(classify(dialect, { kind: "script", text }, 0));

describe("nested PowerShell and cmd from brush", () => {
	test.each([
		String.raw`powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\omp-dg\d"`,
		String.raw`pwsh -c "ri C:\omp-dg\d -r"`,
		"pwsh.exe -c 'Remove-Item x'",
		"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command 'del x'",
		String.raw`pwsh -c '[IO.Directory]::Delete("C:\d", $true)'`,
		`pwsh -c '[System.IO.File] :: Delete("x")'`,
		"pwsh -c '(Get-Item x).Delete()'",
		"pwsh -c 'REMOVE-ITEM x'",
		String.raw`cmd /c rd /s /q C:\omp-dg\d`,
		'cmd.exe /C "del /q x"',
		String.raw`cmd /c "for %f in (C:\omp-dg\d\*) do del %f"`,
		'cmd /c "if exist x del x"',
		'cmd /c "echo a & erase x"',
		"pwsh -c 'cmd /c rmdir x'",
		'cmd /c "powershell -Command Remove-Item x"',
		"pwsh -c '& { Remove-Item x }'",
		"pwsh -c 'Get-ChildItem | ForEach-Object { $_ | Remove-Item }'",
		"pwsh -NoProfile -Command '$x=Remove-Item -LiteralPath /tmp/p'",
		"pwsh -NoProfile -Command 'return Remove-Item -LiteralPath /tmp/p'",
		"pwsh -NoProfile -Command '. Remove-Item -LiteralPath /tmp/p'",
		"pwsh -c 'if ($a) { Write-Output a } Remove-Item x'",
		String.raw`cmd /c 'start "" /b /wait /d C:\omp-dg cmd /c del C:\omp-dg\d\f'`,
	])("blocks deletion: %p", (command) => {
		expect(ruleOf(command)).toBe("delete");
	});

	test.each([
		`powershell -Command "$p='x'; iex $p"`,
		"pwsh -c 'iex $p'",
		`pwsh -c 'Invoke-Expression "ls"'`,
		"pwsh -EncodedCommand ZABpAHIA",
		"pwsh -enc ZABpAHIA",
		"pwsh -e ZABpAHIA",
		"pwsh -c '& $cmd x'",
		"pwsh",
		"cmd /c %X% f",
		'cmd /c "!X! f"',
		"cmd",
		"echo del x | cmd",
		"pwsh -c 'Write-Output hi >'",
		"pwsh -c 'Write-Output hi 2>'",
	])("blocks non-literal: %p", (command) => {
		expect(ruleOf(command)).toBe("nonLiteral");
	});

	test.each([
		"pwsh -c 'Get-ChildItem C:\\'",
		"pwsh -File build.ps1",
		"cmd /c dir C:\\",
		'cmd /c "echo del x"',
		`pwsh -c 'Write-Output "Remove-Item x"'`,
		"pwsh -c '$x = 1'",
		"pwsh -c 'git rm x'",
		"pwsh -c 'Get-Process 2>&1'",
		"pwsh -c 'Get-Process > out.txt'",
		`pwsh -c '$x = "rm"; Write-Output $x'`,
		"pwsh -c '. ./build.ps1'",
		"pwsh -c 'if ($a) { Write-Output a } else { Write-Output b }'",
		"pwsh -c '$n = Get-Date'",
		String.raw`cmd /c start "" /d C:\tmp notepad`,
		"cmd /c constructor",
		"pwsh -c 'constructor'",
	])("allows: %p", (command) => {
		expect(ruleOf(command)).toBe("allow");
	});
});

describe("cmd and PowerShell dialects", () => {
	test.each([
		[{ kind: "cmd" }, String.raw`del /q C:\omp-dg\d\f`, "delete"],
		[{ kind: "cmd" }, String.raw`rd /s /q C:\omp-dg\d`, "delete"],
		[{ kind: "cmd" }, "@ERASE x", "delete"],
		[{ kind: "cmd" }, "%X% f", "nonLiteral"],
		[{ kind: "cmd" }, "dir & echo ok", "allow"],
		[{ kind: "cmd" }, "rem del x", "allow"],
		[{ kind: "powershell" }, "Remove-Item -Recurse x", "delete"],
		[{ kind: "powershell" }, "iex $s", "nonLiteral"],
		[{ kind: "powershell" }, "Get-Process", "allow"],
	] as const)("%p %p is %p", (dialect, text, rule) => {
		expect(ruleIn(dialect, text)).toBe(rule);
	});
});
