import { describe, expect, test } from "bun:test";
import { detectCommandViolations, detectEvalViolations, detectTraceViolations } from "../agent/extensions/tool-policy-nag/heuristic.ts";
import { inspectMaskedFailure, inspectRisk, maskedFailureReminder, riskReminder } from "../agent/extensions/tool-policy-nag/risk.ts";
import { scanShell } from "../agent/extensions/tool-policy-nag/shell-parser.ts";
import { type ExecutedTrace, shellOutcome } from "../agent/extensions/tool-policy-nag/trace.ts";
import fixtures from "./fixtures/tool-policy-nag-traces.json";

const violations = (line: string) =>
	detectCommandViolations(scanShell(line).commands, () => true).map(({ categories, program, target }) => ({
		categories: [...categories],
		program,
		target,
	}));

const LIMITS = { minCommands: 4, minChars: 600, minPrograms: 3 };

const traced = (name: keyof typeof fixtures): ExecutedTrace => {
	const { details, isError } = fixtures[name];
	const outcome = shellOutcome(details, isError);
	if (outcome.kind !== "traced") throw new Error(`${name} fixture is ${outcome.kind}`);
	return outcome.trace;
};

describe("form lane command analysis", () => {
	test("built-in tool operations are named with their category and target", () => {
		expect(violations("cat package.json")).toEqual([{ categories: ["read"], program: "cat", target: "package.json" }]);
		expect(violations("grep -rn TODO src")).toEqual([{ categories: ["search"], program: "grep", target: "src" }]);
		expect(violations("sed -i 's/a/b/' f.ts")).toEqual([{ categories: ["edit"], program: "sed", target: "f.ts" }]);
		expect(violations("echo hi > notes.md")).toEqual([{ categories: ["write"], program: "echo", target: "notes.md" }]);
		expect(violations("ls -la src")).toEqual([{ categories: ["list"], program: "ls", target: "src" }]);
	});

	test("wrappers and literal shell strings are looked through", () => {
		expect(violations("timeout 5 cat a.txt")).toEqual([{ categories: ["read"], program: "cat", target: "a.txt" }]);
		expect(violations("bash -c 'head -5 log.txt'")).toEqual([{ categories: ["read"], program: "head", target: "log.txt" }]);
		expect(violations("find . -name '*.ts' -exec cat {} ;")).toEqual([{ categories: ["read"], program: "cat", target: "{}" }]);
	});

	test("counted, captured, elevated, remote and device uses are exempt", () => {
		expect(violations("ls src | wc -l")).toEqual([]);
		expect(violations('x="$(cat VERSION)"; echo "$x"')).toEqual([]);
		expect(violations("sudo cat /etc/hosts")).toEqual([]);
		expect(violations("ssh host cat /etc/hosts")).toEqual([]);
		expect(violations("cat /dev/null")).toEqual([]);
		expect(violations("if grep -q x f; then echo y; fi")).toEqual([]);
	});

	test("real programs doing their own job pass", () => {
		expect(violations("git status --short && bun run check")).toEqual([]);
		expect(violations("npm test > test.log")).toEqual([]);
		expect(violations("docker ps | grep api")).toEqual([]);
	});

	test("eval cells reading or listing files are flagged once per category", () => {
		expect(detectEvalViolations("py", "print(open('a.txt').read())\nprint(open('b.txt').read())").map((v) => v.categories)).toEqual([
			["read"],
		]);
		expect(detectEvalViolations("js", "import fs from 'node:fs';\nfs.readdirSync('.')").map((v) => v.program)).toEqual(["readdirSync"]);
		expect(detectEvalViolations("py", "print(sum(range(10)))")).toEqual([]);
	});
});

describe("form lane on executed traces", () => {
	test("a listing whose output reached the result counts", () => {
		expect(detectTraceViolations(traced("listing")).map((v) => [v.program, v.categories[0]])).toEqual([["ls", "list"]]);
	});

	test("a redirect recorded in the step source still counts as a write", () => {
		expect(detectTraceViolations(traced("write")).map((v) => [v.program, v.categories[0]])).toEqual([["cat", "write"]]);
	});
});

describe("risk lane", () => {
	test("a long untraced chain that writes is flagged with its programs and writers", () => {
		const line = "cd repo && timeout 60 git push origin main && sudo rm -rf build && curl -s https://example.com";
		expect(inspectRisk(scanShell(line).commands, line, LIMITS)).toEqual({
			commands: 4,
			chars: line.length,
			programs: ["git", "sudo", "rm", "curl"],
			writes: ["git", "rm"],
		});
	});

	test("shell keywords do not count as external programs", () => {
		const line = "rm -f a.tmp; for r in a b; do git -C $r status; done";
		expect(inspectRisk(scanShell(line).commands, line, LIMITS)).toBeNull();
	});

	test("a pipeline stage that failed without output and without a test is a masked failure", () => {
		const masked = inspectMaskedFailure(traced("maskedGrep"));
		expect(masked?.map((step) => [step.argv[0], step.status])).toEqual([["grep", 1]]);
	});

	test("a clean traced listing has no masked failure", () => {
		expect(inspectMaskedFailure(traced("listing"))).toBeNull();
	});

	test("reminders quote the call with a fence longer than any backtick run inside it", () => {
		const line = "echo '```' > a && git push && rm b && curl -s x";
		const finding = inspectRisk(scanShell(line).commands, line, { minCommands: 1, minChars: 1, minPrograms: 1 });
		if (finding === null) throw new Error("expected a risk finding");
		expect(riskReminder("bash", line, finding)).toContain(`\`\`\`\`sh\n${line}\n\`\`\`\``);
		const masked = inspectMaskedFailure(traced("maskedGrep")) ?? [];
		expect(maskedFailureReminder("bash", "grep x | head", masked)).toContain("```sh\ngrep x | head\n```");
	});
});
