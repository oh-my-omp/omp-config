import { classifyShellInvocation, programName, shellKind } from "./nested.ts";
import { parsePosix, type Script, type SimpleCommand, type StdinSource, type Word } from "./posix-parse.ts";
import { ALLOW, MAX_DEPTH, type Rule, type Verdict } from "./verdict.ts";

/** The posix deletion commands; names are compared lowercased (case-insensitive filesystems run `RM`). */
const DELETE_COMMANDS: Readonly<Record<string, true>> = { rm: true, unlink: true, rmdir: true, shred: true };

const SHELLS: Readonly<Record<string, true>> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };

/** Words that open or close compound commands; the command follows them. A Set: a `then` key reads as a thenable to Biome. */
const RESERVED: ReadonlySet<string> = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"esac",
	"coproc",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

type Flags = Readonly<Record<string, true>>;

/**
 * How a prefix command takes its options before the command it runs.
 * `values`: options consuming the next word unless attached (`-uroot`, `--user=root`).
 * `queries`: options after which nothing is executed. `nonLiteral`: options whose
 * value becomes the command line through the prefix's own splitting (`env -S`).
 * An option in none of the lists is read both ways (with and without a value).
 */
type PrefixSpec = {
	readonly values: Flags;
	readonly flags: Flags;
	readonly queries: Flags;
	readonly nonLiteral: Flags;
	/** Words between the options and the command (`timeout DURATION`). */
	readonly positional: number;
	/** `NAME=value` words and a bare `-` are options (`env`). */
	readonly assignments: boolean;
	/** `-10` is an option (`nice`). */
	readonly numeric: boolean;
};

const set = (...names: readonly string[]): Flags => Object.fromEntries(names.map((name) => [name, true] as const));

const NONE = set();
const HELP = set("--help", "--version");

const spec = (fields: Partial<PrefixSpec>): PrefixSpec => ({
	values: NONE,
	flags: NONE,
	queries: HELP,
	nonLiteral: NONE,
	positional: 0,
	assignments: false,
	numeric: false,
	...fields,
});

const PREFIXES: Readonly<Record<string, PrefixSpec>> = {
	sudo: spec({
		values: set(
			"-u",
			"-g",
			"-p",
			"-C",
			"-U",
			"-r",
			"-t",
			"-T",
			"-D",
			"-R",
			"--user",
			"--group",
			"--prompt",
			"--close-from",
			"--other-user",
			"--role",
			"--type",
			"--command-timeout",
			"--chdir",
			"--chroot",
			"--host",
		),
		flags: set(
			"-A",
			"-b",
			"-B",
			"-E",
			"-H",
			"-i",
			"-k",
			"-n",
			"-N",
			"-P",
			"-S",
			"-s",
			"--askpass",
			"--background",
			"--bell",
			"--preserve-env",
			"--set-home",
			"--login",
			"--reset-timestamp",
			"--non-interactive",
			"--no-update",
			"--preserve-groups",
			"--stdin",
			"--shell",
		),
		queries: set("-l", "-V", "-v", "-K", "-e", "--list", "--version", "--validate", "--remove-timestamp", "--edit", "--help"),
	}),
	doas: spec({ values: set("-u", "-C"), flags: set("-n", "-s", "-L"), queries: NONE }),
	command: spec({ flags: set("-p"), queries: set("-v", "-V") }),
	builtin: spec({ queries: NONE }),
	exec: spec({ values: set("-a"), flags: set("-c", "-l"), queries: NONE }),
	env: spec({
		values: set("-u", "-C", "-a", "--unset", "--chdir", "--argv0"),
		flags: set(
			"-i",
			"-0",
			"-v",
			"--ignore-environment",
			"--null",
			"--debug",
			"--block-signal",
			"--default-signal",
			"--ignore-signal",
			"--list-signal-handling",
		),
		nonLiteral: set("-S", "--split-string"),
		assignments: true,
	}),
	nice: spec({ values: set("-n", "--adjustment"), numeric: true }),
	nohup: spec({}),
	time: spec({
		values: set("-f", "-o", "--format", "--output"),
		flags: set("-p", "-a", "-v", "-q", "--append", "--verbose", "--quiet", "--portability"),
		queries: set("-V", "--help", "--version"),
	}),
	timeout: spec({
		values: set("-s", "-k", "--signal", "--kill-after"),
		flags: set("-v", "-f", "--verbose", "--foreground", "--preserve-status"),
		positional: 1,
	}),
	stdbuf: spec({ values: set("-i", "-o", "-e", "--input", "--output", "--error") }),
	busybox: spec({ queries: set("--list", "--list-full", "--install", "--help") }),
	xargs: spec({
		values: set(
			"-a",
			"-d",
			"-E",
			"-I",
			"-L",
			"-n",
			"-P",
			"-s",
			"--arg-file",
			"--delimiter",
			"--max-args",
			"--max-procs",
			"--max-chars",
			"--process-slot-var",
		),
		flags: set(
			"-0",
			"-o",
			"-p",
			"-r",
			"-t",
			"-x",
			"-e",
			"-i",
			"-l",
			"--null",
			"--open-tty",
			"--interactive",
			"--no-run-if-empty",
			"--verbose",
			"--exit",
			"--eof",
			"--replace",
			"--max-lines",
		),
		queries: set("--help", "--version", "--show-limits"),
	}),
};

const FIND_EXEC: Readonly<Record<string, true>> = { "-exec": true, "-execdir": true, "-ok": true, "-okdir": true };

/** Unknown prefix options read both ways at most this many times per command. */
const AMBIGUITY_BUDGET = 4;

type Context = {
	readonly depth: number;
	readonly stdin: StdinSource | null;
	/** The simple command's own text, quoted in the reason. */
	readonly fragment: string;
};

const block = (rule: Rule, fragment: string, detail: string): Verdict => ({ kind: "block", rule, fragment, detail });

function classifyNested(text: string, depth: number, fragment: string): Verdict {
	if (depth > MAX_DEPTH) return block("nonLiteral", fragment, `scripts nested more than ${MAX_DEPTH} levels deep are not classified`);
	return classifyPosix(text, depth);
}

/** `trap`, `alias` and `eval` take script text: literal text is classified as a script, anything else is non-literal. */
function classifyScriptWord(ctx: Context, word: Word, what: string): Verdict {
	if (!word.literal) return block("nonLiteral", ctx.fragment, `the ${what} \`${word.raw}\` is not a literal script`);
	return classifyNested(word.text, ctx.depth + 1, ctx.fragment);
}

function resolvePrefix(ctx: Context, words: readonly Word[], start: number, prefix: PrefixSpec, budget: number): Verdict {
	let j = start;
	while (j < words.length) {
		const word = words[j];
		if (word === undefined) break;
		const text = word.text;
		if (word.literal && text === "--") {
			j++;
			break;
		}
		if (prefix.assignments && (ASSIGNMENT.test(text) || (word.literal && text === "-"))) {
			j++;
			continue;
		}
		if (!text.startsWith("-") || text === "-") break;
		if (!word.literal)
			return block("nonLiteral", ctx.fragment, `the option \`${word.raw}\` comes from an expansion, so the command it runs is unknown`);
		if (prefix.numeric && /^-\d+$/.test(text)) {
			j++;
			continue;
		}
		let consumed: number | null = null;
		if (text.startsWith("--")) {
			const name = text.split("=")[0] ?? text;
			if (prefix.queries[name]) return ALLOW;
			if (prefix.nonLiteral[name]) return block("nonLiteral", ctx.fragment, `\`${name}\` builds the command line from a string`);
			if (text.includes("=") || prefix.flags[name]) consumed = 1;
			else if (prefix.values[name]) consumed = 2;
		} else {
			const letters = text.slice(1);
			consumed = 1;
			for (let k = 0; k < letters.length; k++) {
				const option = `-${letters.charAt(k)}`;
				if (prefix.queries[option]) return ALLOW;
				if (prefix.nonLiteral[option]) return block("nonLiteral", ctx.fragment, `\`${option}\` builds the command line from a string`);
				if (prefix.values[option]) {
					if (k === letters.length - 1) consumed = 2;
					break;
				}
				if (!prefix.flags[option]) {
					consumed = null;
					break;
				}
			}
		}
		if (consumed !== null) {
			j += consumed;
			continue;
		}
		if (budget <= 0) return block("nonLiteral", ctx.fragment, "too many unrecognized options before the command");
		const withoutValue = resolvePrefix(ctx, words, j + 1, prefix, budget - 1);
		if (withoutValue.kind === "block") return withoutValue;
		return resolvePrefix(ctx, words, j + 2, prefix, budget - 1);
	}
	return resolveCommand(ctx, words, j + prefix.positional);
}

function resolveFind(ctx: Context, words: readonly Word[], start: number): Verdict {
	for (let k = start; k < words.length; k++) {
		const word = words[k];
		if (word === undefined || !word.literal) continue;
		if (word.text === "-delete") return block("delete", ctx.fragment, "`find -delete` deletes files");
		if (!FIND_EXEC[word.text]) continue;
		let end = k + 1;
		while (end < words.length && !(words[end]?.literal && (words[end]?.text === ";" || words[end]?.text === "+"))) end++;
		if (ctx.depth + 1 > MAX_DEPTH)
			return block("nonLiteral", ctx.fragment, `scripts nested more than ${MAX_DEPTH} levels deep are not classified`);
		const verdict = resolveCommand({ depth: ctx.depth + 1, stdin: null, fragment: ctx.fragment }, words.slice(k + 1, end), 0);
		if (verdict.kind === "block") return verdict;
		k = end;
	}
	return ALLOW;
}

function stdinLabel(stdin: StdinSource | null): string {
	if (stdin === null) return "no script given";
	switch (stdin.kind) {
		case "pipe":
			return "a pipe";
		case "file":
			return "a file";
		case "other":
			return "a duplicated descriptor";
		case "herestring":
			return "a here-string";
		case "heredoc":
			return stdin.quoted ? "a quoted here-document" : "an unquoted here-document";
		default: {
			const unreachable: never = stdin;
			return unreachable;
		}
	}
}

/** `sh|bash|zsh|dash|ksh`: `-c` scripts and quoted here-documents on stdin are classified; script files are K5's. */
function resolveShell(ctx: Context, words: readonly Word[], start: number): Verdict {
	let j = start;
	let commandMode = false;
	let stdinMode = false;
	let noExec = false;
	while (j < words.length) {
		const word = words[j];
		if (word === undefined) break;
		const text = word.text;
		if (!word.literal) {
			if (text.startsWith("-") || text.startsWith("+"))
				return block("nonLiteral", ctx.fragment, `the shell option \`${word.raw}\` comes from an expansion`);
			break;
		}
		if (text === "--" || text === "-") {
			j++;
			break;
		}
		if (text.startsWith("--")) {
			j += text === "--rcfile" || text === "--init-file" ? 2 : 1;
			continue;
		}
		if (text.length < 2 || (!text.startsWith("-") && !text.startsWith("+"))) break;
		let takesValue = false;
		for (const letter of text.slice(1)) {
			if (letter === "c") commandMode = true;
			else if (letter === "s") stdinMode = true;
			else if (letter === "n" && text.startsWith("-")) noExec = true;
			else if (letter === "o" || letter === "O") takesValue = true;
		}
		j += takesValue ? 2 : 1;
	}
	if (commandMode) {
		const script = words[j];
		if (script === undefined) return block("nonLiteral", ctx.fragment, "the shell has `-c` but no script");
		if (!script.literal) return block("nonLiteral", ctx.fragment, `the nested shell script \`${script.raw}\` is not literal`);
		return noExec ? ALLOW : classifyNested(script.text, ctx.depth + 1, ctx.fragment);
	}
	if (!stdinMode && j < words.length) return ALLOW;
	const stdin = ctx.stdin;
	if (stdin?.kind === "file") return ALLOW;
	if (stdin?.kind === "heredoc" && stdin.quoted) return noExec ? ALLOW : classifyNested(stdin.body, ctx.depth + 1, ctx.fragment);
	return block(
		"nonLiteral",
		ctx.fragment,
		`the shell reads its script from stdin (${stdinLabel(stdin)}); only a here-document with a quoted delimiter is classified`,
	);
}

function resolveTrap(ctx: Context, words: readonly Word[], start: number): Verdict {
	let j = start;
	const first = words[j];
	if (first?.literal && (first.text === "-l" || first.text === "-p")) return ALLOW;
	if (first?.literal && first.text === "--") j++;
	const action = words[j];
	if (action === undefined || j + 1 >= words.length) return ALLOW;
	if (action.literal && (action.text === "-" || action.text === "")) return ALLOW;
	return classifyScriptWord(ctx, action, "trap action");
}

function resolveAlias(ctx: Context, words: readonly Word[], start: number): Verdict {
	for (const word of words.slice(start)) {
		const equals = word.text.indexOf("=");
		if (equals <= 0) continue;
		const body: Word = { text: word.text.slice(equals + 1), raw: word.raw, literal: word.literal };
		const verdict = classifyScriptWord(ctx, body, "alias body");
		if (verdict.kind === "block") return verdict;
	}
	return ALLOW;
}

function resolveEval(ctx: Context, words: readonly Word[], start: number): Verdict {
	const args = words.slice(start);
	if (args.length === 0) return ALLOW;
	const dynamic = args.find((word) => !word.literal);
	if (dynamic !== undefined) return block("nonLiteral", ctx.fragment, `the eval argument \`${dynamic.raw}\` is not literal`);
	return classifyNested(args.map((word) => word.text).join(" "), ctx.depth + 1, ctx.fragment);
}

/** Classifies the command `words[start]` runs, following prefix commands, `find`, nested shells and script-taking builtins. */
function resolveCommand(ctx: Context, words: readonly Word[], start: number): Verdict {
	const word = words[start];
	if (word === undefined) return ALLOW;
	if (!word.literal) return block("nonLiteral", ctx.fragment, `the command name \`${word.raw}\` comes from an expansion`);
	const name = programName(word.text);
	if (DELETE_COMMANDS[name]) return block("delete", ctx.fragment, `\`${name}\` deletes files`);
	const prefix = PREFIXES[name];
	if (prefix !== undefined) return resolvePrefix(ctx, words, start + 1, prefix, AMBIGUITY_BUDGET);
	if (SHELLS[name]) return resolveShell(ctx, words, start + 1);
	const kind = shellKind(word.text);
	if (kind !== null) return classifyShellInvocation(kind, word, words.slice(start + 1), ctx.depth, ctx.fragment);
	switch (name) {
		case "find":
			return resolveFind(ctx, words, start + 1);
		case "eval":
			return resolveEval(ctx, words, start + 1);
		case "trap":
			return resolveTrap(ctx, words, start + 1);
		case "alias":
			return resolveAlias(ctx, words, start + 1);
		default:
			return ALLOW;
	}
}

/** Skips assignments, reserved words and `function NAME`; `for`/`select` headers run no command. */
function classifyCommand(command: SimpleCommand, depth: number): Verdict {
	const { words } = command;
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (word === undefined) break;
		if (ASSIGNMENT.test(word.text) && !word.raw.startsWith("=")) {
			i++;
			continue;
		}
		if (!word.literal) break;
		if (RESERVED.has(word.text)) {
			i++;
			continue;
		}
		if (word.text === "function") {
			i += 2;
			continue;
		}
		if (word.text === "for" || word.text === "select") return ALLOW;
		break;
	}
	return resolveCommand({ depth, stdin: command.stdin, fragment: command.raw }, words, i);
}

function walkScript(script: Script, depth: number): Verdict {
	for (const command of script.commands) {
		const verdict = classifyCommand(command, depth);
		if (verdict.kind === "block") return verdict;
	}
	for (const nested of script.nested) {
		const verdict = walkScript(nested, depth);
		if (verdict.kind === "block") return verdict;
	}
	return ALLOW;
}

/** Classifies an argv list run without a shell (`subprocess.run([...])`, `Bun.spawn([...])`): argv[0] is the command. */
export function classifyPosixArgv(words: readonly { readonly text: string; readonly literal: boolean }[], depth: number): Verdict {
	const fragment = words.map((word) => (word.literal ? word.text : "<expr>")).join(" ");
	const argv: Word[] = words.map((word) => ({ text: word.text, raw: word.literal ? word.text : "<expr>", literal: word.literal }));
	return resolveCommand({ depth, stdin: null, fragment }, argv, 0);
}

/** Classifies posix shell text: every command it runs, including substitutions and literal nested scripts. */
export function classifyPosix(text: string, depth: number): Verdict {
	const parsed = parsePosix(text);
	switch (parsed.kind) {
		case "invalid":
			return block("nonLiteral", text, `the command text cannot be parsed (${parsed.detail})`);
		case "parsed":
			return walkScript(parsed.script, depth);
		default: {
			const unreachable: never = parsed;
			return unreachable;
		}
	}
}
