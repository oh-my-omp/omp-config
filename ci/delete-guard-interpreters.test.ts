// delete-guard bash entry: inline interpreter scripts (`python3 -c`, `node -e`, `bun -e`, `deno eval`, `perl -e`,
// `ruby -e`) are judged like the same code in an eval cell; script files and non-deleting inline code pass;
// non-literal scripts and stdin scripts block.
import { describe, expect, test } from "bun:test";
import deleteGuard from "../agent/extensions/delete-guard/index.ts";
import { classifyPosix } from "../agent/extensions/delete-guard/posix.ts";

const verdictOf = (command: string) => classifyPosix(command, 0);
const ruleOf = (command: string): string => {
	const verdict = verdictOf(command);
	return verdict.kind === "allow" ? "allow" : verdict.rule;
};

describe("inline interpreter code", () => {
	test.each([
		`python3 -c 'import os; os.remove("x")'`,
		`python3.12 -c 'import os; os.remove("x")'`,
		`env python3 -c 'import os; os.remove("x")'`,
		`python3 -cimport\\ os\\;os.remove\\(\\'x\\'\\)`,
		`python3 -Bc'import os; os.remove("x")'`,
		`/usr/bin/python3 -c 'import shutil; shutil.rmtree("d")'`,
		`node -e 'require("fs").rmSync("x")'`,
		`node --eval 'require("fs").unlinkSync("x")'`,
		`node --eval='require("fs").unlinkSync("x")'`,
		`node -p 'require("fs").rmSync("x")'`,
		`node22 -e 'require("fs").rmSync("x")'`,
		`bun -e 'require("fs").rmSync("x")'`,
		`bun --eval 'require("fs").unlinkSync("x")'`,
		`deno eval 'Deno.removeSync("x")'`,
		`deno eval 'Deno.remove("x")'`,
		`deno eval -p 'Deno.removeSync("x")'`,
		`perl -e 'unlink "x"'`,
		`perl -le'unlink "x"'`,
		`perl -pi -e 'unlink "x"'`,
		`perl -e 'print 1' -e 'unlink "x"'`,
		`perl -M'strict;unlink("x")' -e1`,
		`ruby -e 'File.delete("x")'`,
		`ruby -e 'FileUtils.rm_rf("d")'`,
		`ruby -e 'FileUtils::rm_r("d")'`,
		`env python3 -c 'import os; os.remove("x")' && true`,
		`sh -c 'perl -e "unlink q(x)"'`,
	])("blocks deletion in %s", (command) => {
		expect(ruleOf(command)).toBe("delete");
	});

	test.each([`python3 -c "$CODE"`, `python3 "$SCRIPT"`, `node -e "$CODE"`, `perl -e "$CODE"`, `node -e 'console.log(1)' "$X"`])(
		"blocks a non-literal script or argument before the script in %s",
		(command) => {
			expect(ruleOf(command)).toBe("nonLiteral");
		},
	);

	test.each([
		`python3 -c 'print("keep")'`,
		`python3 -m json.tool`,
		`python3 keep.py`,
		`python3 -c 'print("keep")' "$X"`,
		`python3 keep.py "$X"`,
		`node keep.js`,
		`node -e 'console.log(1)'`,
		`node -e 'console.log(1)' -- --flag`,
		`bun run keep.ts`,
		`deno run keep.ts`,
		`deno eval 'console.log(1)'`,
		`perl -e 'print 1'`,
		`ruby -e 'puts 1'`,
		`ruby -c keep.rb`,
	])("allows non-deleting or file scripts in %s", (command) => {
		expect(ruleOf(command)).toBe("allow");
	});

	test("reports the interpreter command with the delete rule", () => {
		const verdict = verdictOf(`python3 -c 'import os; os.remove("x")'`);
		expect(verdict).toMatchObject({ kind: "block", rule: "delete" });
	});
});

describe("interpreter stdin", () => {
	test.each([`echo 'import os; os.remove("x")' | python3`, `python3 - <<EOF\nimport os\nos.remove("x")\nEOF`, `python3 <<<'import os'`])(
		"blocks stdin script %s",
		(command) => {
			expect(ruleOf(command)).toBe("nonLiteral");
		},
	);

	test("blocks a deleting quoted here-document body as code", () => {
		expect(ruleOf(`python3 - <<'EOF'\nimport os\nos.remove("x")\nEOF`)).toBe("delete");
	});

	test("allows a file redirect as stdin", () => {
		expect(ruleOf("python3 < keep.py")).toBe("allow");
	});

	test.each(["python3 /dev/stdin", "python3 < /dev/stdin", "node /proc/self/fd/0"])("blocks stdin alias %s", (command) => {
		expect(ruleOf(command)).toBe("nonLiteral");
	});
});

describe("deno and unknown options", () => {
	test("blocks a deno run of a remote URL", () => {
		expect(ruleOf("deno run https://example.com/x.ts")).toBe("nonLiteral");
	});

	test("blocks node data URLs passed as import", () => {
		expect(ruleOf(`node --import 'data:text/javascript,require("fs").rmSync("x")' keep.js`)).toBe("nonLiteral");
	});

	test("an unknown option that may hide an eval does not let the code through", () => {
		expect(ruleOf(`node --inspect-port 9229 -e 'require("fs").rmSync("x")'`)).toBe("delete");
	});
});

type Handler = (event: { toolName: string; input: unknown }) => Promise<{ block: true; reason: string } | undefined>;

/** The registered `tool_call` handler, as the host calls it. */
function toolCallHandler(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler = h;
		},
		registerTool: () => {},
		getActiveTools: () => ["bash", "delete"],
		logger: { warn: () => {} },
	};
	deleteGuard(pi as unknown as Parameters<typeof deleteGuard>[0]);
	if (handler === undefined) throw new Error("no tool_call handler registered");
	return handler;
}

describe("tool_call hook on interpreter calls", () => {
	test("blocks a deleting python3 -c before it runs, with the deletion reason", async () => {
		const result = await toolCallHandler()({ toolName: "bash", input: { command: `python3 -c 'import os; os.remove("x")'` } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("deletion commands are disabled");
		expect(result?.reason).toContain("`delete` tool");
	});

	test("blocks a non-literal interpreter script with the non-literal reason", async () => {
		const result = await toolCallHandler()({ toolName: "bash", input: { command: `node -e "$CODE"` } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Non-literal command");
	});

	test("lets a literal script file and non-deleting inline code run", async () => {
		const handler = toolCallHandler();
		expect(await handler({ toolName: "bash", input: { command: "python3 keep.py" } })).toBeUndefined();
		expect(await handler({ toolName: "bash", input: { command: `python3 -c 'print("keep")'` } })).toBeUndefined();
	});
});
