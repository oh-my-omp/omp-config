/**
 * pty lane of tool-policy-nag: decides, before anything runs, whether a `bash`
 * command line or an eval cell starts a program that belongs in an
 * `exec_command` PTY session, and names the rule that says so.
 *
 * CATEGORIES. `passthrough`: the command is handed to another machine,
 * container, user or shell to interpret (`ssh`, `docker exec`, `zsh -c`).
 * `terminal`: the program needs a terminal or stops at an interactive prompt
 * (a bare REPL, a TUI, `git rebase -i`, `sudo` without `-n`). `open-ended`:
 * the command does not end on its own or waits on an outside condition
 * (`tail -f`, `watch`, a `sleep` inside a loop body, `nohup`, a trailing `&`).
 *
 * RULES. `RULES` is the closed registry: one entry per rule id, each with its
 * category; every entry has a hit and a miss fixture in CI. A line is a hit
 * when any of its simple commands — every pipeline stage, `$(…)` body, `;`/
 * `&&`/`||` link, the command behind `env`/`timeout`/`nice`/`nohup`/`stdbuf`/
 * `time`/`command`/`exec`, and the command after a non-interactive
 * `sudo -n`/`sudo -S`/`doas -n`/`run0 --no-ask-password` — matches a rule;
 * the first match in source order names the rule. A literal `sh -c` body is
 * itself a passthrough hit, so its contents never decide anything.
 *
 * FAIL OPEN. An unterminated line, a program word from `$…` or a substitution,
 * a program fed by `xargs` (or run by `find -exec`/`parallel`, which are not
 * command positions), an eval cell that does not tokenize or parse, a launch
 * through a renamed import, and any non-literal launch argument all pass: a
 * missed refusal is preferred over a wrong one.
 *
 * EVAL. Only these launches, spelled under their own names with literal
 * arguments, are judged: py `subprocess.run|call|check_call|check_output|Popen`
 * (argv; shell text with `shell=True`), `os.system`, `os.popen`, `!cmd` lines
 * and `%%bash` bodies; js `Bun.$` templates without `${}`, `Bun.spawn|spawnSync`
 * array literals, child_process `exec|execSync` (shell text) and
 * `spawn|spawnSync|execFile|execFileSync` (argv). A py cell that uses
 * `pexpect` or `pty.spawn`/`pty.fork` is a terminal hit. The `tool.bash`
 * bridge is not read here: it reaches the lane as a real `bash` call.
 */

import { jsLaunchOf, parseJs, walk } from "../_shared/eval-js-launches.ts";
import { type LaunchWord, type PyScan, pyLaunchAt, scanPy } from "../_shared/eval-py-launches.ts";
import { fenced } from "./intent.ts";
import { optionName, resolveCommand } from "./shell-command.ts";
import { type CommandToken, parseShellCommands } from "./shell-parser.ts";

export type PtyCategory = "passthrough" | "terminal" | "open-ended";

/** One simple command, resolved through wrappers to the program it runs, in its shell context. */
type Command = {
	readonly program: string;
	readonly args: readonly string[];
	readonly wrappers: readonly string[];
	/** stdin is a pipe, a `<` file or a here-document/here-string, not the terminal. */
	readonly stdinFed: boolean;
	readonly background: boolean;
	readonly loopBody: boolean;
};

type Rule =
	| { readonly on: "command"; readonly category: PtyCategory; readonly matches: (command: Command) => boolean }
	| { readonly on: "python"; readonly category: PtyCategory; readonly program: string; readonly matches: (scan: PyScan) => boolean };

// ── option reading ────────────────────────────────────────────────────────

type OptionSpec = {
	/** Short letters that take a value: the rest of the cluster, or the next word. */
	readonly valueLetters: string;
	/** `--long` options that take the next word as their value (`--long=v` never does). */
	readonly valueLongs: readonly string[];
	/** Options end at the first operand (`ssh host cmd -G`, `docker exec …`). */
	readonly stopAtOperand: boolean;
};

type Options = { readonly short: ReadonlySet<string>; readonly long: ReadonlySet<string>; readonly operands: readonly string[] };

const PLAIN: OptionSpec = { valueLetters: "", valueLongs: [], stopAtOperand: false };

/** Splits arguments into short letters (`-fn` → f, n), long names (`--follow=x` → `--follow`) and operands. */
function optionsOf(args: readonly string[], spec: OptionSpec): Options {
	const short = new Set<string>();
	const long = new Set<string>();
	const operands: string[] = [];
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!options || arg === "-" || !arg.startsWith("-")) {
			operands.push(arg);
			if (spec.stopAtOperand) options = false;
			continue;
		}
		if (arg === "--") {
			options = false;
			continue;
		}
		if (arg.startsWith("--")) {
			const name = optionName(arg);
			long.add(name);
			if (name === arg && spec.valueLongs.includes(name)) i++;
			continue;
		}
		for (let k = 1; k < arg.length; k++) {
			const letter = arg.charAt(k);
			short.add(letter);
			if (spec.valueLetters.includes(letter)) {
				if (k === arg.length - 1) i++;
				break;
			}
		}
	}
	return { short, long, operands };
}

const hasAny = (options: Options, letters: string, longs: readonly string[] = []): boolean =>
	[...letters].some((letter) => options.short.has(letter)) || longs.some((name) => options.long.has(name));

/** A subcommand verb after global options, and the arguments after it. */
function verbOf(args: readonly string[], spec: OptionSpec): { readonly verb: string; readonly rest: readonly string[] } {
	const [verb = "", ...rest] = optionsOf(args, { ...spec, stopAtOperand: true }).operands;
	return { verb, rest };
}

const DOCKER_GLOBAL: OptionSpec = {
	valueLetters: "Hcl",
	valueLongs: ["--host", "--context", "--config", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
	stopAtOperand: true,
};
const COMPOSE_GLOBAL: OptionSpec = {
	valueLetters: "fp",
	valueLongs: ["--file", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--progress", "--parallel"],
	stopAtOperand: true,
};
const KUBECTL_GLOBAL: OptionSpec = {
	valueLetters: "nsv",
	valueLongs: [
		"--namespace",
		"--context",
		"--kubeconfig",
		"--server",
		"--cluster",
		"--user",
		"--token",
		"--as",
		"--as-group",
		"--as-uid",
		"--request-timeout",
		"--certificate-authority",
		"--client-certificate",
		"--client-key",
		"--cache-dir",
		"--tls-server-name",
		"--username",
		"--password",
		"--profile",
		"--profile-output",
		"--log-file",
	],
	stopAtOperand: true,
};
const GIT_GLOBAL: OptionSpec = {
	valueLetters: "Cc",
	valueLongs: ["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"],
	stopAtOperand: true,
};
const SSH_OPTIONS: OptionSpec = { valueLetters: "BbcDEeFIiJLlmOopQRSWw", valueLongs: [], stopAtOperand: true };
const ORB_OPTIONS: OptionSpec = { valueLetters: "muw", valueLongs: ["--machine", "--user", "--workdir"], stopAtOperand: true };
const SUDO_OPTIONS: OptionSpec = {
	valueLetters: "ugCDhpRrtTU",
	valueLongs: [
		"--user",
		"--group",
		"--close-from",
		"--chdir",
		"--host",
		"--prompt",
		"--chroot",
		"--role",
		"--type",
		"--command-timeout",
		"--other-user",
	],
	stopAtOperand: true,
};

const CONTAINER_ENGINES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);
const COMPOSE_PROGRAMS: ReadonlySet<string> = new Set(["docker-compose", "podman-compose"]);

/** `docker [global] [container] <verb> …`, or null for another program. */
function containerVerb(command: Command): { readonly verb: string; readonly rest: readonly string[] } | null {
	if (!CONTAINER_ENGINES.has(command.program)) return null;
	const outer = verbOf(command.args, DOCKER_GLOBAL);
	return outer.verb === "container" ? verbOf(outer.rest, PLAIN) : outer;
}

/** `docker compose [global] <verb> …` or `docker-compose [global] <verb> …`, or null. */
function composeVerb(command: Command): { readonly verb: string; readonly rest: readonly string[] } | null {
	if (COMPOSE_PROGRAMS.has(command.program)) return verbOf(command.args, COMPOSE_GLOBAL);
	const outer = containerVerb(command);
	return outer?.verb === "compose" ? verbOf(outer.rest, COMPOSE_GLOBAL) : null;
}

function kubectlVerb(command: Command): { readonly verb: string; readonly rest: readonly string[] } | null {
	return command.program === "kubectl" ? verbOf(command.args, KUBECTL_GLOBAL) : null;
}

function gitVerb(command: Command): { readonly verb: string; readonly rest: readonly string[] } | null {
	return command.program === "git" ? verbOf(command.args, GIT_GLOBAL) : null;
}

const firstOperand = (command: Command): string => optionsOf(command.args, { ...PLAIN, stopAtOperand: true }).operands[0] ?? "";

const startsWith = (args: readonly string[], words: readonly string[]): boolean => words.every((word, index) => args[index] === word);

/** `bash -c`, `zsh -lc`, `fish --command`: the options before the script carry a `c`. */
function runsShellString(command: Command): boolean {
	for (let i = 0; i < command.args.length; i++) {
		const arg = command.args[i] ?? "";
		if (!arg.startsWith("-") && !arg.startsWith("+")) return false;
		if (arg === "--") return false;
		const name = optionName(arg);
		if (name === "--command") return true;
		if (name === "--rcfile" || name === "--init-file") i++;
		else if (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("c")) return true;
		// `-o opt` / `+O opt`: the option word ends the bundle and takes the next word.
		if (!arg.startsWith("--") && /[oO]$/.test(arg)) i++;
	}
	return false;
}

const POSIX_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);
const POWERSHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell", "pwsh.exe", "powershell.exe"]);
const REPLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "fish", "python", "python3", "node", "irb", "ghci"]);
/** Flags that keep a REPL interactive: no script, no `-c`/`-e`/`-m`, no version or help. */
const REPL_FLAGS: ReadonlySet<string> = new Set(["-i", "-l", "--login", "--interactive", "-q", "--norc", "--noprofile", "--no-rc"]);

/** sqlite3's single-dash options that take a value. */
const SQLITE_VALUES: ReadonlySet<string> = new Set(["-cmd", "-separator", "-nullvalue", "-newline", "-init", "-mmap", "-vfs", "-maxsize"]);

function sqliteOperands(args: readonly string[]): readonly string[] | null {
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "-version" || arg === "-help" || arg === "--version" || arg === "--help") return null;
		if (!arg.startsWith("-")) operands.push(arg);
		else if (SQLITE_VALUES.has(arg)) i++;
	}
	return operands;
}

/** `sudo`/`doas`/`run0` that may prompt for a password; its own options only. */
function elevationPrompts(command: Command): boolean {
	switch (command.program) {
		case "sudo":
			return !hasAny(optionsOf(command.args, SUDO_OPTIONS), "nS", ["--non-interactive", "--stdin"]);
		case "doas":
			return !hasAny(optionsOf(command.args, { valueLetters: "uC", valueLongs: [], stopAtOperand: true }), "n");
		case "run0":
			return !command.args.includes("--no-ask-password");
		default:
			return false;
	}
}

/** The command a non-interactive `sudo -n`/`doas -n`/`run0 --no-ask-password` runs, as words. */
function elevatedCommand(command: Command): readonly string[] | null {
	switch (command.program) {
		case "sudo":
			return optionsOf(command.args, SUDO_OPTIONS).operands;
		case "doas":
			return optionsOf(command.args, { valueLetters: "uC", valueLongs: [], stopAtOperand: true }).operands;
		case "run0":
			return optionsOf(command.args, {
				valueLetters: "uDgM",
				valueLongs: ["--user", "--group", "--chdir", "--machine", "--unit", "--property", "--description", "--slice"],
				stopAtOperand: true,
			}).operands;
		default:
			return null;
	}
}

// ── the registry ─────────────────────────────────────────────────────────

const command = (category: PtyCategory, matches: (command: Command) => boolean): Rule => ({ on: "command", category, matches });

/** The closed rule registry, in precedence order; adding or removing an entry needs a hit and a miss fixture. */
const RULES = {
	// passthrough
	ssh: command("passthrough", (c) => c.program === "ssh" && !hasAny(optionsOf(c.args, SSH_OPTIONS), "GVO")),
	mosh: command("passthrough", (c) => c.program === "mosh"),
	vagrantSsh: command("passthrough", (c) => c.program === "vagrant" && firstOperand(c) === "ssh"),
	gcloudSsh: command("passthrough", (c) => {
		const at = c.args.indexOf("compute");
		return c.program === "gcloud" && at !== -1 && c.args[at + 1] === "ssh";
	}),
	ssmSession: command("passthrough", (c) => {
		const at = c.args.indexOf("ssm");
		return c.program === "aws" && at !== -1 && c.args[at + 1] === "start-session";
	}),
	containerExec: command("passthrough", (c) => {
		const verb = containerVerb(c)?.verb;
		return verb === "exec" || verb === "run";
	}),
	composeExec: command("passthrough", (c) => {
		const verb = composeVerb(c)?.verb;
		return verb === "exec" || verb === "run";
	}),
	kubectlExec: command("passthrough", (c) => ["exec", "run", "debug", "attach"].includes(kubectlVerb(c)?.verb ?? "")),
	incusExec: command(
		"passthrough",
		(c) =>
			(c.program === "incus" || c.program === "lxc") &&
			["exec", "shell"].includes(verbOf(c.args, { valueLetters: "", valueLongs: ["--project"], stopAtOperand: true }).verb),
	),
	pctExec: command("passthrough", (c) => c.program === "pct" && (c.args[0] === "exec" || c.args[0] === "enter")),
	qmGuest: command("passthrough", (c) => c.program === "qm" && (startsWith(c.args, ["guest", "exec"]) || c.args[0] === "terminal")),
	orbShell: command("passthrough", (c) => {
		if (c.program !== "orb" && c.program !== "orbctl") return false;
		const options = optionsOf(c.args, ORB_OPTIONS);
		if (hasAny(options, "m", ["--machine"])) return true;
		const verb = options.operands[0];
		if (verb === undefined) return !hasAny(options, "hv", ["--help", "--version"]);
		return verb === "run" || verb === "shell";
	}),
	limaShell: command("passthrough", (c) => c.program === "limactl" && firstOperand(c) === "shell"),
	multipassExec: command("passthrough", (c) => c.program === "multipass" && ["exec", "shell"].includes(firstOperand(c))),
	distroboxEnter: command("passthrough", (c) => c.program === "distrobox" && firstOperand(c) === "enter"),
	nsenter: command("passthrough", (c) => c.program === "nsenter"),
	su: command("passthrough", (c) => c.program === "su"),
	shellString: command("passthrough", (c) => POSIX_SHELLS.has(c.program) && runsShellString(c)),
	powershellCommand: command(
		"passthrough",
		(c) => POWERSHELLS.has(c.program.toLowerCase()) && c.args.some((arg) => /^-(c|command|commandwithargs|cwa)$/i.test(arg)),
	),
	// terminal
	repl: command("terminal", (c) => REPLS.has(c.program) && !c.stdinFed && c.args.every((arg) => REPL_FLAGS.has(arg))),
	psql: command(
		"terminal",
		(c) =>
			c.program === "psql" &&
			!c.stdinFed &&
			!hasAny(optionsOf(c.args, { valueLetters: "cdfhpUvTLoPRFS", valueLongs: [], stopAtOperand: false }), "cflV", [
				"--command",
				"--file",
				"--list",
				"--help",
				"--version",
			]),
	),
	mysql: command(
		"terminal",
		(c) =>
			(c.program === "mysql" || c.program === "mariadb") &&
			!c.stdinFed &&
			!hasAny(optionsOf(c.args, { valueLetters: "ehuPSD", valueLongs: [], stopAtOperand: false }), "eV", [
				"--execute",
				"--help",
				"--version",
			]),
	),
	redisCli: command("terminal", (c) => {
		if (c.program !== "redis-cli" || c.stdinFed) return false;
		const options = optionsOf(c.args, { valueLetters: "hpsaunrid", valueLongs: ["--user", "--pass"], stopAtOperand: false });
		return options.operands.length === 0 && !hasAny(options, "x", ["--help", "--version"]);
	}),
	sqlite3: command("terminal", (c) => {
		if (c.program !== "sqlite3" || c.stdinFed) return false;
		const operands = sqliteOperands(c.args);
		return operands !== null && operands.length <= 1;
	}),
	mongosh: command(
		"terminal",
		(c) =>
			c.program === "mongosh" &&
			!c.stdinFed &&
			!c.args.some((arg) => ["--eval", "--file", "-f", "--help", "--version"].includes(optionName(arg)) || arg.endsWith(".js")),
	),
	editor: command("terminal", (c) => {
		if (c.program === "vim" || c.program === "vi" || c.program === "nvim")
			return !c.args.some((arg) => ["-es", "-Es", "--headless", "--version"].includes(arg));
		if (c.program === "nano") return !c.args.includes("--version");
		if (c.program === "emacs") return !c.args.some((arg) => ["--batch", "--script", "--version"].includes(optionName(arg)));
		return false;
	}),
	tui: command("terminal", (c) => {
		if (["htop", "btop", "lazygit", "lazydocker", "tig", "k9s"].includes(c.program)) return true;
		return c.program === "top" && !hasAny(optionsOf(c.args, { valueLetters: "dlnpsuUoOwEFm", valueLongs: [], stopAtOperand: false }), "bl");
	}),
	gitInteractive: command("terminal", (c) => {
		const git = gitVerb(c);
		if (git === null) return false;
		switch (git.verb) {
			case "rebase":
				return hasAny(optionsOf(git.rest, { valueLetters: "sxXC", valueLongs: [], stopAtOperand: false }), "i", ["--interactive"]);
			case "add":
				return hasAny(optionsOf(git.rest, PLAIN), "pi", ["--patch", "--interactive"]);
			case "commit":
				return !hasAny(optionsOf(git.rest, { valueLetters: "mFCct", valueLongs: [], stopAtOperand: false }), "mFC", [
					"--message",
					"--file",
					"--reuse-message",
					"--no-edit",
				]);
			default:
				return false;
		}
	}),
	fakeTerminal: command("terminal", (c) => c.program === "expect" || c.program === "script" || c.program === "unbuffer"),
	elevation: command("terminal", elevationPrompts),
	passwd: command("terminal", (c) => c.program === "passwd"),
	ghAuthLogin: command("terminal", (c) => c.program === "gh" && startsWith(c.args, ["auth", "login"]) && !c.args.includes("--with-token")),
	pexpect: {
		on: "python",
		category: "terminal",
		program: "pexpect",
		matches: (scan) => scan.tokens.some((token) => token.kind === "name" && token.value === "pexpect"),
	},
	ptySpawn: {
		on: "python",
		category: "terminal",
		program: "pty.spawn",
		matches: (scan) =>
			scan.tokens.some((token, k) => {
				const dot = scan.tokens[k + 1];
				const member = scan.tokens[k + 2];
				return (
					token.kind === "name" &&
					token.value === "pty" &&
					dot?.kind === "op" &&
					dot.value === "." &&
					member?.kind === "name" &&
					(member.value === "spawn" || member.value === "fork")
				);
			}),
	},
	// open-ended
	tailFollow: command(
		"open-ended",
		(c) =>
			c.program === "tail" &&
			hasAny(optionsOf(c.args, { valueLetters: "ncs", valueLongs: ["--pid", "--sleep-interval"], stopAtOperand: false }), "fF", [
				"--follow",
			]),
	),
	journalFollow: command(
		"open-ended",
		(c) =>
			c.program === "journalctl" &&
			hasAny(optionsOf(c.args, { valueLetters: "bcDiIkMnopStuU", valueLongs: [], stopAtOperand: false }), "f", ["--follow"]),
	),
	containerLogsFollow: command("open-ended", (c) => {
		const logs = containerVerb(c);
		return (
			logs?.verb === "logs" &&
			hasAny(optionsOf(logs.rest, { valueLetters: "n", valueLongs: ["--since", "--until", "--tail"], stopAtOperand: false }), "f", [
				"--follow",
			])
		);
	}),
	composeLogsFollow: command("open-ended", (c) => {
		const logs = composeVerb(c);
		return (
			logs?.verb === "logs" &&
			hasAny(optionsOf(logs.rest, { valueLetters: "n", valueLongs: ["--since", "--until", "--tail"], stopAtOperand: false }), "f", [
				"--follow",
			])
		);
	}),
	composeUp: command("open-ended", (c) => {
		const up = composeVerb(c);
		return (
			up?.verb === "up" &&
			!hasAny(
				optionsOf(up.rest, {
					valueLetters: "t",
					valueLongs: ["--scale", "--timeout", "--exit-code-from", "--pull", "--wait-timeout", "--attach", "--no-attach"],
					stopAtOperand: false,
				}),
				"d",
				["--detach", "--wait"],
			)
		);
	}),
	kubectlLogsFollow: command("open-ended", (c) => {
		const logs = kubectlVerb(c);
		return (
			logs?.verb === "logs" &&
			hasAny(
				optionsOf(logs.rest, {
					valueLetters: "cln",
					valueLongs: ["--container", "--since", "--since-time", "--tail", "--selector", "--max-log-requests"],
					stopAtOperand: false,
				}),
				"f",
				["--follow"],
			)
		);
	}),
	kubectlWatch: command("open-ended", (c) => {
		const get = kubectlVerb(c);
		return (
			get?.verb === "get" &&
			hasAny(
				optionsOf(get.rest, {
					valueLetters: "fLlno",
					valueLongs: ["--selector", "--output", "--sort-by", "--template"],
					stopAtOperand: false,
				}),
				"w",
				["--watch", "--watch-only"],
			)
		);
	}),
	watch: command("open-ended", (c) => c.program === "watch"),
	ghRunWatch: command("open-ended", (c) => c.program === "gh" && startsWith(c.args, ["run", "watch"])),
	ping: command(
		"open-ended",
		(c) =>
			(c.program === "ping" || c.program === "ping6") &&
			!hasAny(optionsOf(c.args, { valueLetters: "cisItWwlpQSmM", valueLongs: [], stopAtOperand: false }), "c"),
	),
	detach: command("open-ended", (c) => c.wrappers.includes("nohup") || c.program === "nohup" || c.program === "setsid"),
	background: command("open-ended", (c) => c.background),
	loopSleep: command("open-ended", (c) => c.program === "sleep" && c.loopBody),
} satisfies Record<string, Rule>;

export type PtyRuleId = keyof typeof RULES;

export type PtyHit = { readonly rule: PtyRuleId; readonly category: PtyCategory; readonly program: string };

const isRuleId = (key: string): key is PtyRuleId => Object.hasOwn(RULES, key);
const RULE_IDS: readonly PtyRuleId[] = Object.keys(RULES).filter(isRuleId);

// ── shell lines ──────────────────────────────────────────────────────────

type ShellContext = { readonly piped: boolean; readonly background: boolean; readonly loopBody: boolean };

/** The commands a simple command runs: its program after wrappers, then what a non-interactive `sudo -n` runs. */
function commandsOf(tokens: readonly CommandToken[], context: ShellContext): Command[] {
	const invocation = resolveCommand(tokens, context.piped, "none");
	// A program from an expansion is unknown; one xargs feeds is not at a command position the shell starts.
	if (invocation === null || invocation.programDynamic || invocation.feed.kind === "xargs") return [];
	const found: Command = {
		program: invocation.program,
		args: invocation.args,
		wrappers: invocation.wrappers,
		stdinFed: invocation.piped || invocation.readInputs.length > 0 || invocation.hereInput,
		background: context.background,
		loopBody: context.loopBody,
	};
	if (elevationPrompts(found)) return [found];
	const inner = elevatedCommand(found);
	if (inner === null || inner.length === 0) return [found];
	return [found, ...commandsOf(literalTokens(inner), { ...context, piped: found.stdinFed })];
}

const literalTokens = (words: readonly string[]): CommandToken[] => words.map((text) => ({ kind: "word", text, dynamic: false }));

function commandHit(found: Command): PtyHit | null {
	for (const rule of RULE_IDS) {
		const entry: Rule = RULES[rule];
		if (entry.on === "command" && entry.matches(found)) return { rule, category: entry.category, program: found.program };
	}
	return null;
}

/** The first rule a shell line hits, or null; an unterminated line passes. */
export function ptyShellHit(line: string): PtyHit | null {
	const parsed = parseShellCommands(line);
	if (parsed.kind === "unterminated") return null;
	for (const simple of parsed.commands) {
		for (const found of commandsOf(simple.tokens, simple)) {
			const hit = commandHit(found);
			if (hit !== null) return hit;
		}
	}
	return null;
}

/** An argv run without a shell; a word that is not literal leaves it unknown. */
function argvHit(words: readonly LaunchWord[] | null): PtyHit | null {
	if (words === null || words.length === 0 || words.some((word) => !word.literal)) return null;
	for (const found of commandsOf(literalTokens(words.map((word) => word.text)), { piped: false, background: false, loopBody: false })) {
		const hit = commandHit(found);
		if (hit !== null) return hit;
	}
	return null;
}

const scriptHit = (text: string | null): PtyHit | null => (text === null ? null : ptyShellHit(text));

// ── eval cells ───────────────────────────────────────────────────────────

const PY_LAUNCHES: ReadonlySet<string> = new Set([
	"subprocess.run",
	"subprocess.call",
	"subprocess.check_call",
	"subprocess.check_output",
	"subprocess.Popen",
	"os.system",
	"os.popen",
]);

function pythonHit(code: string): PtyHit | null {
	const scanned = scanPy(code);
	if (scanned.kind === "unlexable") return null;
	const { scan } = scanned;
	for (let k = 0; k < scan.tokens.length; k++) {
		const launch = pyLaunchAt(scan, k);
		if (launch === null || launch.kind === "bridge" || launch.via !== "direct" || !PY_LAUNCHES.has(launch.api)) continue;
		const hit = launch.kind === "script" ? scriptHit(launch.text) : argvHit(launch.words);
		if (hit !== null) return hit;
	}
	for (const rule of RULE_IDS) {
		const entry: Rule = RULES[rule];
		if (entry.on === "python" && entry.matches(scan)) return { rule, category: entry.category, program: entry.program };
	}
	for (const script of scan.shellScripts) {
		const hit = ptyShellHit(script);
		if (hit !== null) return hit;
	}
	return null;
}

async function javascriptHit(code: string): Promise<PtyHit | null> {
	let cell: Awaited<ReturnType<typeof parseJs>>;
	try {
		cell = await parseJs(code);
	} catch {
		// A cell Babel cannot parse does not run: nothing to route.
		return null;
	}
	let hit: PtyHit | null = null;
	walk(cell.program, null, (node) => {
		if (hit !== null) return;
		const launch = jsLaunchOf(node, cell.bindings);
		if (launch === null) return;
		switch (launch.kind) {
			case "bunShell":
				hit = scriptHit(launch.text);
				return;
			case "bunSpawn":
				hit = argvHit(launch.words);
				return;
			case "childScript":
				if (launch.via === "direct") hit = scriptHit(launch.text);
				return;
			case "childSpawn":
				if (launch.via !== "direct") return;
				if (!launch.shell) hit = argvHit(launch.words);
				else if (launch.words?.every((word) => word.literal)) hit = ptyShellHit(launch.words.map((word) => word.text).join(" "));
				return;
			case "bridge":
				// The bridged command reaches the lane as its own `bash` call.
				return;
			default: {
				const unreachable: never = launch;
				return unreachable;
			}
		}
	});
	return hit;
}

/** The first rule an eval cell hits, or null; other languages and unreadable cells pass. */
export async function ptyEvalHit(language: string, code: string): Promise<PtyHit | null> {
	if (language === "py") return pythonHit(code);
	if (language === "js") return javascriptHit(code);
	return null;
}

// ── refusal ──────────────────────────────────────────────────────────────

const CATEGORY_TEXT: Record<PtyCategory, string> = {
	passthrough: "把命令交给另一台机器、另一个容器、另一个用户或另一个 shell 去解释",
	terminal: "需要终端，或会停在交互提示上",
	"open-ended": "不会自己结束，或在等外部条件",
};

const RECIPES: Record<PtyCategory, readonly string[]> = {
	passthrough: [
		"- 内层是脚本：`cmd` 写成「外层程序 + 带引号的 heredoc」，例如 `ssh host bash -s <<'EOF'`、`docker exec -i c sh -s <<'EOF'`、`kubectl exec -i p -- sh -s <<'EOF'`；heredoc 体照原样写，不再转义，最后一行 `EOF`，退出码就是内层脚本的退出码。",
		'- 需要交互：`cmd` 只写外层（`ssh host`、`docker exec -it c sh`），再用 `write_stdin` 在提示符下输入；每行以 `\\r` 结尾，`chars` 会解码 `\\n \\t \\\\ \\"`，含反斜杠的文本改用 `chars_b64`。',
		"- 需要换 shell：用 `exec_command` 的 `shell` 参数选 shell，`cmd` 直接写原来 `-c` 后面的命令体。",
		"- 只是读远端 UTF-8 文本文件：用 `read ssh://host/path`。",
		"把原字符串原样搬进 `cmd`，引号层不会消失：`cmd` 本身仍由一层 shell 解析。",
	],
	terminal: [
		"- `cmd` 写该程序本身，再用 `write_stdin` 输入、`monitor` 等待输出。",
		"- 密码和 passphrase 由人在终端页里输入，不经过对话，也不通过 `write_stdin` 传递。",
	],
	"open-ended": [
		"- 用 `exec_command` 启动，用 `monitor` 等它结束或等匹配的输出。",
		"- 不要在 bash 里用 `sleep` 轮询，也不要用 `&`、`nohup` 放到后台。",
	],
};

/** The refusal the model reads as the tool result: category, program, rewrite recipes and the call itself. */
export function ptyRefusal(hit: PtyHit, tool: string, call: string, language: string): string {
	return [
		`pty 路由：这次 \`${tool}\` 调用没有执行。它属于 ${hit.category}（\`${hit.program}\` ${CATEGORY_TEXT[hit.category]}，规则 \`${hit.rule}\`），这类命令要用 \`xd://exec_command\`（PTY 会话）发出。`,
		"这是入口路由，不是风险判断：命令本身可以照做，只是换个工具。",
		"",
		"改写方法：",
		...RECIPES[hit.category],
		"",
		"这次调用：",
		fenced(call, language),
	].join("\n");
}
