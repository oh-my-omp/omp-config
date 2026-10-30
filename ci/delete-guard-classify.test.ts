// delete-guard posix classifier and tool_call hook: deletion commands in any
// executed position block, non-literal commands block, argument-only mentions
// and ordinary shell pass; the reason follows delete availability; a hook error
// blocks.
import { describe, expect, test } from "bun:test";
import deleteGuard from "../agent/extensions/delete-guard/index.ts";
import { classifyPosix } from "../agent/extensions/delete-guard/posix.ts";

const ruleOf = (command: string): string => {
	const verdict = classifyPosix(command, 0);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};

describe("classifyPosix", () => {
	test.each([
		'X=; rm -rf "$X"/omp-dg-probe',
		"rm /tmp/omp-dg-probe/f",
		"RM /tmp/omp-dg-probe/f",
		"/bin/rm /tmp/omp-dg-probe/f",
		"\\rm /tmp/omp-dg-probe/f",
		'"rm" f',
		"sudo -n rm /tmp/omp-dg-probe/f",
		"sudo -u root rm f",
		"SUDO rm f",
		"echo /tmp/omp-dg-probe/f | xargs rm",
		"echo f | xargs -I {} rm {}",
		"find /tmp/omp-dg-probe -name f -delete",
		"find /tmp/omp-dg-probe -exec rm {} +",
		"find . -execdir sh -c 'unlink x' \\;",
		"cd /tmp && rm omp-dg-probe/f",
		"sh -c 'unlink /tmp/omp-dg-probe/f'",
		"bash -lc 'rmdir d'",
		'echo "$(rm /tmp/omp-dg-probe/f)"',
		"echo `shred f`",
		"diff <(rm f) x",
		"timeout 5 rm f",
		"timeout -s KILL 5 rm f",
		"timeout --mystery 5 rm f",
		"env FOO=1 nice -n 5 nohup rm f",
		"command rm f",
		"busybox rm f",
		"if true; then rm f; fi",
		"for f in a b; do rm $f; done",
		"while read f; do unlink $f; done < list",
		"{ rm f; }",
		"(cd /tmp; rm f)",
		"f() { rm x; }",
		"trap 'rm -rf \"$tmp\"' EXIT",
		"alias d=rm",
		"eval 'rm f'",
		"sh <<'EOF'\nrm /tmp/omp-dg-probe/f\nEOF",
		"sh < safe.sh <<'EOF'\nrm f\nEOF",
		"cat <<EOF\n$(rm f)\nEOF",
		"case x in a) rm f;; esac",
		"echo $(case x in a) rm f;; esac)",
		`unset x; echo "\${x:-'$(rm /tmp/omp-dg-probe/f)'}"`,
		"cat 3<<EOF\n'$(rm /tmp/omp-dg-probe/f)'\nEOF",
		"zsh --emulate sh -c 'rm /tmp/omp-dg-probe/f'",
		"zsh --no-rcs -c 'rm f'",
		"bash -n +n -c 'rm /tmp/omp-dg-probe/f'",
		"echo /tmp/omp-dg-probe/f | xargs --show-limits rm",
		"bash -c 'coproc WORKER { rm /tmp/omp-dg-probe/f; }; wait'",
	])("blocks deletion: %p", (command) => {
		expect(ruleOf(command)).toBe("delete");
	});

	test.each([
		"C=rm; $C /tmp/omp-dg-probe/f",
		"$(printf rm) /tmp/omp-dg-probe/f",
		"`printf rm` f",
		"s='ls'; sh -c \"$s\"",
		's=x; eval "$s"',
		"echo 'rm /tmp/omp-dg-probe/f' | sh",
		"cat x | bash -s",
		"sh <<< 'echo ok'",
		"sh <<EOF\necho ok\nEOF",
		"sh",
		"sh <<'EOF' <<< 'rm f'\nx\nEOF",
		"/bin/r? f",
		"{rm,x} f",
		"env -S 'rm f'",
		"sudo $FLAGS rm f",
		'trap "$cleanup" EXIT',
		"echo 'unterminated",
		"echo $(ls",
		"FLAGS=-s; echo 'rm f' | bash \"$FLAGS\"",
		"FLAGS=-c; bash \"$FLAGS\" 'rm f'",
	])("blocks non-literal: %p", (command) => {
		expect(ruleOf(command)).toBe("nonLiteral");
	});

	test.each([
		"echo rm -rf /",
		"git -C /tmp/omp-dg-git rm --cached --dry-run README.md",
		"npm rm left-pad",
		"ls $HOME",
		"sh -c 'echo ok'",
		"bash x.sh",
		"sh < install.sh",
		"sh <<'EOF' < safe.sh\nrm f\nEOF",
		"bash -n -c 'rm f'",
		"command -v rm",
		"sudo -l rm",
		"echo ok # don't rm anything",
		"[ -f x ] && echo y",
		"[[ $x =~ ^(rm|b)$ ]] && echo y",
		"(( i = 2 * 3 ))",
		"arr=(*.txt); echo $arr",
		"case $x in rm) echo hit;; *) echo miss;; esac",
		"cat <<'EOF'\n$(rm f)\nEOF",
		"for ((i=0; i<3; i++)); do echo $i; done",
		"~/bin/tool --flag",
		"xargs < list",
		"find . -name '*.log' -print",
		"trap - EXIT",
		"git clean -fdx",
		'echo "a" > out.txt 2>&1',
		"bash --version",
		"cat 3<<'EOF'\nrm f\nEOF",
		"echo \"$'x'\"",
	])("allows: %p", (command) => {
		expect(ruleOf(command)).toBe("allow");
	});
});

type Handler = (event: { toolName: string; input: unknown }) => Promise<{ block: true; reason: string } | undefined>;

function loadHook(activeTools: readonly string[]): { readonly handler: Handler; readonly warnings: unknown[] } {
	let handler: Handler | undefined;
	const warnings: unknown[] = [];
	const pi = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler = h;
		},
		registerTool: () => {},
		getActiveTools: () => [...activeTools],
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
	};
	// The extension takes the host ExtensionAPI; this test supplies only the members it calls.
	deleteGuard(pi as unknown as Parameters<typeof deleteGuard>[0]);
	if (handler === undefined) throw new Error("no tool_call handler registered");
	return { handler, warnings };
}

describe("tool_call hook", () => {
	test("points to delete when the session has it", async () => {
		const { handler } = loadHook(["bash", "delete"]);
		const result = await handler({ toolName: "bash", input: { command: "rm /tmp/omp-dg-probe/f" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("`delete` tool");
		expect(result?.reason).toContain("rm /tmp/omp-dg-probe/f");
	});

	test("says the session cannot delete without naming the tool when delete is absent", async () => {
		const { handler } = loadHook(["bash"]);
		const result = await handler({ toolName: "bash", input: { command: "rm /tmp/omp-dg-probe/f" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("cannot delete");
		expect(result?.reason).not.toContain("`delete` tool");
	});

	test("judges writes to xd://bash and eval cells, and ignores other devices", async () => {
		const { handler } = loadHook(["bash", "delete"]);
		expect((await handler({ toolName: "write", input: { path: "xd://bash", content: JSON.stringify({ command: "rm f" }) } }))?.block).toBe(
			true,
		);
		expect(
			await handler({ toolName: "write", input: { path: "xd://exec_command", content: JSON.stringify({ cmd: "rm f" }) } }),
		).toBeUndefined();
		expect(await handler({ toolName: "bash", input: { command: "ls -la" } })).toBeUndefined();
		expect((await handler({ toolName: "eval", input: { language: "py", code: "import shutil; shutil.rmtree('d')" } }))?.block).toBe(true);
		expect((await handler({ toolName: "eval", input: { language: "js", code: "require('fs').rmSync('d')" } }))?.block).toBe(true);
		expect(await handler({ toolName: "eval", input: { language: "js", code: "console.log(1 + 1)" } })).toBeUndefined();
	});

	test("blocks and warns once when reading the call throws", async () => {
		const { handler, warnings } = loadHook(["bash", "delete"]);
		const input = {
			get command(): string {
				throw new Error("boom");
			},
		};
		const result = await handler({ toolName: "bash", input });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("internal error");
		expect(warnings).toHaveLength(1);
	});
});
