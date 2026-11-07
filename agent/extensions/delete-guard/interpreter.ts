import { EMPTY_CARRY } from "../_shared/eval-js-launches.ts";
import type { ArgvWord } from "./classify.ts";
import { classifyJs } from "./eval-js.ts";
import { classifyPy } from "./eval-py.ts";
import { heredocText, STDIN_SCRIPT, type StdinSource, stdinLabel } from "./posix-parse.ts";
import { ALLOW, BRUSH, type Fragment, fragmentText, MAX_DEPTH, type Rule, SYSTEM_SHELL, type Verdict } from "./verdict.ts";

/** Interpreters whose inline code (`-c`, `-e`, `eval`, …) runs with the filesystem of the bash call. */
export type InterpreterKind = "python" | "node" | "bun" | "deno" | "perl" | "ruby";

const PATTERNS: ReadonlyArray<readonly [RegExp, InterpreterKind]> = [
	[/^python(\d+(\.\d+)*)?$/, "python"],
	[/^node\d*$/, "node"],
	[/^bun$/, "bun"],
	[/^deno$/, "deno"],
	[/^perl(\d+(\.\d+)*)?$/, "perl"],
	[/^ruby(\d+(\.\d+)*)?$/, "ruby"],
];

/** The interpreter a program name (basename, lowercased, without `.exe`) runs as, or null. */
export function interpreterKind(program: string): InterpreterKind | null {
	return PATTERNS.find(([pattern]) => pattern.test(program))?.[1] ?? null;
}

/** Unknown options are read both ways (takes a value or not) at most this many times per command. */
const AMBIGUITY_BUDGET = 4;

/** What one option word does to the walk over the interpreter's arguments. */
type Step =
	| { readonly kind: "flag" }
	| { readonly kind: "value"; readonly attached: string | null }
	| { readonly kind: "code"; readonly attached: string | null; readonly ends: boolean }
	| { readonly kind: "module" }
	| { readonly kind: "unknown" };

/**
 * An interpreter's option table. `operand` is what its first positional word is: a script file, or the code itself
 * (`deno eval CODE`). `option` gets one option word that starts with `-` and is not `-` or `--`.
 */
type Spec = {
	readonly operand: "file" | "code";
	readonly option: (word: string) => Step;
};

type Env = {
	readonly kind: InterpreterKind;
	readonly depth: number;
	readonly fragment: Fragment;
	readonly stdin: StdinSource | null;
};

const block = (rule: Rule, fragment: Fragment, detail: string): Verdict => ({
	kind: "block",
	rule,
	fragment: fragmentText(fragment),
	detail,
});

/** A URL-scheme specifier names code fetched or decoded at run time, so it cannot be judged here. `file:` is a file. */
const REMOTE_SPECIFIER = /^(?:data|https?|ftp|blob):/i;

/** The bundled letters of an option word after its `-`: the rest of the word is the value of a letter that takes one. */
const attachedRest = (word: string, index: number): string | null => (word.length > index + 1 ? word.slice(index + 1) : null);

/** Parses `--name` or `--name=value`: the name and the attached value, if any. */
function longOption(word: string): { readonly name: string; readonly attached: string | null } {
	const eq = word.indexOf("=");
	return eq === -1 ? { name: word, attached: null } : { name: word.slice(0, eq), attached: word.slice(eq + 1) };
}

const PYTHON: Spec = {
	operand: "file",
	option(word) {
		if (word.startsWith("--")) return { kind: "unknown" };
		for (let j = 1; j < word.length; j++) {
			const letter = word.charAt(j);
			if (letter === "c") return { kind: "code", attached: attachedRest(word, j), ends: true };
			if (letter === "m") return { kind: "module" };
			if (letter === "W" || letter === "X") return { kind: "value", attached: attachedRest(word, j) };
		}
		return { kind: "flag" };
	},
};

/** Node options that take a module specifier, a condition or a title as their value. */
const NODE_VALUE_LONG: Readonly<Record<string, true>> = {
	"--require": true,
	"--import": true,
	"--loader": true,
	"--experimental-loader": true,
	"--input-type": true,
	"--conditions": true,
	"--title": true,
};

/** Shared by `node` and `bun`, which both take inline code as `-e`/`--eval` and `-p`/`--print`. */
const NODE: Spec = {
	operand: "file",
	option(word) {
		if (word.startsWith("--")) {
			const { name, attached } = longOption(word);
			if (name === "--eval" || name === "--print") return { kind: "code", attached, ends: false };
			if (Object.hasOwn(NODE_VALUE_LONG, name)) return { kind: "value", attached };
			return attached === null ? { kind: "unknown" } : { kind: "flag" };
		}
		if (word === "-e" || word === "-p") return { kind: "code", attached: null, ends: false };
		for (let j = 1; j < word.length; j++) {
			const letter = word.charAt(j);
			if (letter === "e") return { kind: "code", attached: attachedRest(word, j), ends: false };
			if (letter === "r" || letter === "C") return { kind: "value", attached: attachedRest(word, j) };
		}
		return { kind: "flag" };
	},
};

const DENO_VALUE_LONG: Readonly<Record<string, true>> = {
	"--config": true,
	"--import-map": true,
	"--log-level": true,
	"--ext": true,
	"--seed": true,
	"--location": true,
	"--cert": true,
	"--lock": true,
	"--eval-file": true,
};

/** Deno options: `--eval` is inline code in `repl`; `-p`/`--print` are plain flags of `eval`. */
const DENO: Spec = {
	operand: "file",
	option(word) {
		if (word.startsWith("--")) {
			const { name, attached } = longOption(word);
			if (name === "--eval") return { kind: "code", attached, ends: false };
			if (Object.hasOwn(DENO_VALUE_LONG, name)) return { kind: "value", attached };
			return attached === null ? { kind: "unknown" } : { kind: "flag" };
		}
		for (let j = 1; j < word.length; j++) {
			const letter = word.charAt(j);
			if (letter === "c" || letter === "L") return { kind: "value", attached: attachedRest(word, j) };
		}
		return { kind: "flag" };
	},
};

const DENO_EVAL: Spec = { ...DENO, operand: "code" };

/** Perl switches: `-e`/`-E` and `-M` take code; `-m` and `-I` take a value; `-i`, `-x`, `-F`, `-D`, `-C` take the rest of the word. */
const PERL: Spec = {
	operand: "file",
	option(word) {
		if (word.startsWith("--")) return { kind: "unknown" };
		for (let j = 1; j < word.length; j++) {
			const letter = word.charAt(j);
			if (letter === "e" || letter === "E" || letter === "M") {
				return { kind: "code", attached: attachedRest(word, j), ends: false };
			}
			if (letter === "m" || letter === "I") return { kind: "value", attached: attachedRest(word, j) };
			if ("ixFDC".includes(letter)) return { kind: "flag" };
			if (letter === "l" || letter === "0") while (j + 1 < word.length && /\d/.test(word.charAt(j + 1))) j++;
		}
		return { kind: "flag" };
	},
};

/** Ruby switches: `-e` takes code; `-r`, `-I`, `-C`, `-E` take a value; `-K`, `-F`, `-W`, `-x` take the rest of the word. */
const RUBY: Spec = {
	operand: "file",
	option(word) {
		if (word.startsWith("--")) return { kind: "unknown" };
		for (let j = 1; j < word.length; j++) {
			const letter = word.charAt(j);
			if (letter === "e") return { kind: "code", attached: attachedRest(word, j), ends: false };
			if (letter === "r" || letter === "I" || letter === "C" || letter === "E") {
				return { kind: "value", attached: attachedRest(word, j) };
			}
			if ("KFWx".includes(letter)) return { kind: "flag" };
			if (letter === "0") while (j + 1 < word.length && /\d/.test(word.charAt(j + 1))) j++;
		}
		return { kind: "flag" };
	},
};

/** Perl and Ruby have no judged language: their inline code is scanned for the filesystem deletion names. */
const NAMED_DELETE = /\b(?:unlink|rmtree|remove_tree)\b|\b(?:File|FileUtils)(?:\.|::)(?:delete|rm\w*|remove_entry\w*)\b/;

function scanNamedDeletes(code: string, fragment: Fragment): Verdict {
	const match = NAMED_DELETE.exec(code);
	return match === null ? ALLOW : block("delete", fragment, `\`${match[0]}\` deletes files`);
}

/** Classifies one inline code word (`-c`, `-e`, `eval`, a quoted here-document body) as the interpreter's language. */
function classifyInline(env: Env, code: ArgvWord): Verdict {
	if (!code.literal) return block("nonLiteral", env.fragment, `the ${env.kind} code comes from an expansion`);
	switch (env.kind) {
		case "python":
			return classifyPy(code.text, SYSTEM_SHELL, BRUSH, env.depth + 1);
		case "node":
		case "bun":
		case "deno":
			// A nested interpreter runs in a fresh process, so no launcher name from the outer session reaches it.
			return classifyJs(code.text, SYSTEM_SHELL, BRUSH, EMPTY_CARRY, env.depth + 1).verdict;
		case "perl":
		case "ruby":
			return scanNamedDeletes(code.text, env.fragment);
		default: {
			const unreachable: never = env.kind;
			return unreachable;
		}
	}
}

/**
 * Stdin is the script when no code or script file was named: a file redirect is allowed, a quoted here-document's
 * body is judged as code, and anything else (pipe, here-string, unquoted here-document, inherited stdin) is blocked.
 */
function classifyStdin(env: Env): Verdict {
	const stdin = env.stdin;
	if (stdin?.kind === "file") return ALLOW;
	if (stdin?.kind === "heredoc" && stdin.quoted) return classifyInline(env, { text: heredocText(stdin.body), literal: true });
	return block(
		"nonLiteral",
		env.fragment,
		`${env.kind} reads its script from stdin (${stdinLabel(stdin)}); only a file redirect or a quoted here-document is classified`,
	);
}

/** Classifies the walk's outcome: the inline codes it collected, else the script operand. */
function finish(env: Env, spec: Spec, codes: readonly ArgvWord[], operand: ArgvWord | "-" | null): Verdict {
	for (const code of codes) {
		const verdict = classifyInline(env, code);
		if (verdict.kind === "block") return verdict;
	}
	if (codes.length > 0) return ALLOW;
	if (spec.operand === "code") {
		return operand === null || operand === "-" ? classifyStdin(env) : classifyInline(env, operand);
	}
	if (operand === null || operand === "-") return classifyStdin(env);
	if (!operand.literal) return block("nonLiteral", env.fragment, `${env.kind} runs a script file from an expansion`);
	if (STDIN_SCRIPT.test(operand.text)) return classifyStdin(env);
	if (REMOTE_SPECIFIER.test(operand.text))
		return block("nonLiteral", env.fragment, `\`${operand.text}\` is a URL, not a local script file`);
	return ALLOW;
}

/**
 * Walks the interpreter's arguments from `start` the way the interpreter parses them: options until the first
 * positional word, `--`, `-` or an option that ends option parsing. A word from an expansion before that point
 * could be an option or the script, so it blocks. An unknown option is read both ways, each must allow.
 */
function walk(env: Env, spec: Spec, args: readonly ArgvWord[], start: number, codes: readonly ArgvWord[], budget: number): Verdict {
	let i = start;
	let inline = codes;
	for (;;) {
		const word = args[i];
		if (word === undefined) return finish(env, spec, inline, null);
		if (!word.literal)
			return block(
				"nonLiteral",
				env.fragment,
				`${env.kind} has an argument from an expansion before its script, so the script cannot be read`,
			);
		if (word.text === "--") return finish(env, spec, inline, args[i + 1] ?? null);
		if (word.text === "-") return finish(env, spec, inline, "-");
		if (!word.text.startsWith("-")) return finish(env, spec, inline, word);
		const step = spec.option(word.text);
		switch (step.kind) {
			case "flag":
				i += 1;
				continue;
			case "module":
				// `python -m name`: runs a named module, not inline code.
				return ALLOW;
			case "value": {
				const value = step.attached !== null ? { text: step.attached, literal: word.literal } : args[i + 1];
				if (value !== undefined && (!value.literal || REMOTE_SPECIFIER.test(value.text)))
					return block("nonLiteral", env.fragment, `the ${env.kind} option \`${word.text}\` takes a value that is not a local literal`);
				i += step.attached === null && value !== undefined ? 2 : 1;
				continue;
			}
			case "code": {
				const code = step.attached !== null ? { text: step.attached, literal: word.literal } : args[i + 1];
				if (code === undefined) return block("nonLiteral", env.fragment, `the ${env.kind} option \`${word.text}\` has no code`);
				inline = [...inline, code];
				if (step.ends) return finish(env, spec, inline, null);
				i += step.attached === null ? 2 : 1;
				continue;
			}
			case "unknown": {
				if (budget <= 0)
					return block(
						"nonLiteral",
						env.fragment,
						`the option \`${word.text}\` may or may not take a value, so the script cannot be read past it`,
					);
				const flag = walk(env, spec, args, i + 1, inline, budget - 1);
				if (flag.kind === "block") return flag;
				return walk(env, spec, args, i + 2, inline, budget - 1);
			}
			default: {
				const unreachable: never = step;
				return unreachable;
			}
		}
	}
}

/** Deno's subcommands that never run inline code or a script the call names; their own tools judge them. */
const DENO_SUBCOMMANDS: Readonly<Record<string, true>> = {
	add: true,
	bench: true,
	cache: true,
	check: true,
	clean: true,
	compile: true,
	doc: true,
	fmt: true,
	info: true,
	init: true,
	install: true,
	jupyter: true,
	lint: true,
	lsp: true,
	publish: true,
	remove: true,
	serve: true,
	task: true,
	test: true,
	uninstall: true,
	upgrade: true,
	vendor: true,
	x: true,
};

/** `deno eval CODE` and `deno repl --eval CODE` run inline code; `deno run FILE` and bare `deno FILE` run a script. */
function classifyDeno(env: Env, args: readonly ArgvWord[]): Verdict {
	const first = args[0];
	if (first !== undefined && !first.literal) return block("nonLiteral", env.fragment, "the deno subcommand comes from an expansion");
	if (first?.text === "eval") return walk(env, DENO_EVAL, args, 1, [], AMBIGUITY_BUDGET);
	if (first?.text === "run" || first?.text === "repl") return walk(env, DENO, args, 1, [], AMBIGUITY_BUDGET);
	if (first !== undefined && Object.hasOwn(DENO_SUBCOMMANDS, first.text)) return ALLOW;
	return walk(env, DENO, args, 0, [], AMBIGUITY_BUDGET);
}

/**
 * Classifies an interpreter invoked with `args` (the words after its name): the inline code it runs, the script
 * file it reads, or its stdin. `depth` counts enclosing nested scripts and is shared with the code it runs.
 */
export function classifyInterpreter(
	kind: InterpreterKind,
	args: readonly ArgvWord[],
	ctx: { readonly depth: number; readonly fragment: Fragment; readonly stdin: StdinSource | null },
): Verdict {
	if (ctx.depth > MAX_DEPTH)
		return block("nonLiteral", ctx.fragment, `scripts nested more than ${MAX_DEPTH} levels deep are not classified`);
	const env: Env = { kind, depth: ctx.depth, fragment: ctx.fragment, stdin: ctx.stdin };
	switch (kind) {
		case "python":
			return walk(env, PYTHON, args, 0, [], AMBIGUITY_BUDGET);
		case "node":
		case "bun":
			return walk(env, NODE, args, 0, [], AMBIGUITY_BUDGET);
		case "perl":
			return walk(env, PERL, args, 0, [], AMBIGUITY_BUDGET);
		case "ruby":
			return walk(env, RUBY, args, 0, [], AMBIGUITY_BUDGET);
		case "deno":
			return classifyDeno(env, args);
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}
