import { jsLaunchOf, parseJs, walk } from "../_shared/eval-js-launches.ts";
import { type LaunchWord, type PyScan, pyLaunchAt, scanPy } from "../_shared/eval-py-launches.ts";
import {
	elevation,
	grammar,
	hasAny,
	hasOption,
	INTERLEAVED,
	literalTokens,
	OPTIONS_FIRST,
	type OptionGrammar,
	optionName,
	parseOptions,
	resolveCommand,
	shellStringOperand,
} from "./shell-command.ts";
import { type CommandToken, type ShellScan, scanShell } from "./shell-parser.ts";
import { sqliteArguments } from "./shell-programs.ts";

type PtyCategory = "passthrough" | "terminal" | "open-ended";

type Command = {
	readonly program: string;
	readonly args: readonly string[];
	readonly wrappers: readonly string[];
	readonly stdinFed: boolean;
	readonly background: boolean;
	readonly loopBody: boolean;
};

type Verb = { readonly verb: string; readonly rest: readonly string[] };

type Rule =
	| { readonly on: "command"; readonly category: PtyCategory; readonly matches: (command: Command) => boolean }
	| { readonly on: "python"; readonly category: PtyCategory; readonly program: string; readonly matches: (scan: PyScan) => boolean };

function verbOf(args: readonly string[], spec: OptionGrammar): Verb {
	const [verb = "", ...rest] = parseOptions(args, spec).operands;
	return { verb, rest };
}

const DOCKER_GLOBAL = grammar(
	"Hcl",
	["--host", "--context", "--config", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
	"optionsFirst",
);
const COMPOSE_GLOBAL = grammar(
	"fp",
	["--file", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--progress", "--parallel"],
	"optionsFirst",
);
const KUBECTL_GLOBAL = grammar(
	"nsv",
	[
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
	"optionsFirst",
);
const GIT_GLOBAL = grammar("Cc", ["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"], "optionsFirst");
const SSH_OPTIONS = grammar("BbcDEeFIiJLlmOopQRSWw", [], "optionsFirst");
const ORB_OPTIONS = grammar("muw", ["--machine", "--user", "--workdir"], "optionsFirst");
const INCUS_OPTIONS = grammar("", ["--project"], "optionsFirst");

const CONTAINER_ENGINES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);
const COMPOSE_PROGRAMS: ReadonlySet<string> = new Set(["docker-compose", "podman-compose"]);

function containerVerb(command: Command): Verb | null {
	if (!CONTAINER_ENGINES.has(command.program)) return null;
	const outer = verbOf(command.args, DOCKER_GLOBAL);
	return outer.verb === "container" ? verbOf(outer.rest, OPTIONS_FIRST) : outer;
}

function composeVerb(command: Command): Verb | null {
	if (COMPOSE_PROGRAMS.has(command.program)) return verbOf(command.args, COMPOSE_GLOBAL);
	const outer = containerVerb(command);
	return outer?.verb === "compose" ? verbOf(outer.rest, COMPOSE_GLOBAL) : null;
}

const kubectlVerb = (command: Command): Verb | null => (command.program === "kubectl" ? verbOf(command.args, KUBECTL_GLOBAL) : null);

const firstOperand = (command: Command): string => parseOptions(command.args, OPTIONS_FIRST).operands[0] ?? "";

const startsWith = (args: readonly string[], words: readonly string[]): boolean => words.every((word, index) => args[index] === word);

const POSIX_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);
const POWERSHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell", "pwsh.exe", "powershell.exe"]);
const REPLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "fish", "python", "python3", "node", "irb", "ghci"]);
const REPL_FLAGS: ReadonlySet<string> = new Set(["-i", "-l", "--login", "--interactive", "-q", "--norc", "--noprofile", "--no-rc"]);

const commandRule = (category: PtyCategory, matches: (command: Command) => boolean): Rule => ({ on: "command", category, matches });

const PSQL_OPTIONS = grammar("cdfhpUvTLoPRFS", [], "interleaved");
const MYSQL_OPTIONS = grammar("ehuPSD", [], "interleaved");
const REDIS_OPTIONS = grammar("hpsaunrid", ["--user", "--pass"], "interleaved");
const TOP_OPTIONS = grammar("dlnpsuUoOwEFm", [], "interleaved");
const PING_OPTIONS = grammar("cisItWwlpQSmM", [], "interleaved");
const TAIL_OPTIONS = grammar("ncs", ["--pid", "--sleep-interval"], "interleaved");
const JOURNAL_OPTIONS = grammar("bcDiIkMnopStuU", [], "interleaved");
const LOGS_OPTIONS = grammar("n", ["--since", "--until", "--tail"], "interleaved");
const GIT_REBASE_OPTIONS = grammar("sxXC", [], "interleaved");
const GIT_COMMIT_OPTIONS = grammar("mFCct", [], "interleaved");
const COMPOSE_UP_OPTIONS = grammar(
	"t",
	["--scale", "--timeout", "--exit-code-from", "--pull", "--wait-timeout", "--attach", "--no-attach"],
	"interleaved",
);
const KUBECTL_LOGS_OPTIONS = grammar(
	"cln",
	["--container", "--since", "--since-time", "--tail", "--selector", "--max-log-requests"],
	"interleaved",
);
const KUBECTL_GET_OPTIONS = grammar("fLlno", ["--selector", "--output", "--sort-by", "--template"], "interleaved");

const RULES = {
	ssh: commandRule("passthrough", (c) => c.program === "ssh" && !hasAny(parseOptions(c.args, SSH_OPTIONS), "GVO")),
	mosh: commandRule("passthrough", (c) => c.program === "mosh"),
	vagrantSsh: commandRule("passthrough", (c) => c.program === "vagrant" && firstOperand(c) === "ssh"),
	gcloudSsh: commandRule("passthrough", (c) => {
		const at = c.args.indexOf("compute");
		return c.program === "gcloud" && at !== -1 && c.args[at + 1] === "ssh";
	}),
	ssmSession: commandRule("passthrough", (c) => {
		const at = c.args.indexOf("ssm");
		return c.program === "aws" && at !== -1 && c.args[at + 1] === "start-session";
	}),
	containerExec: commandRule("passthrough", (c) => {
		const verb = containerVerb(c)?.verb;
		return verb === "exec" || verb === "run";
	}),
	composeExec: commandRule("passthrough", (c) => {
		const verb = composeVerb(c)?.verb;
		return verb === "exec" || verb === "run";
	}),
	kubectlExec: commandRule("passthrough", (c) => ["exec", "run", "debug", "attach"].includes(kubectlVerb(c)?.verb ?? "")),
	incusExec: commandRule(
		"passthrough",
		(c) => (c.program === "incus" || c.program === "lxc") && ["exec", "shell"].includes(verbOf(c.args, INCUS_OPTIONS).verb),
	),
	pctExec: commandRule("passthrough", (c) => c.program === "pct" && (c.args[0] === "exec" || c.args[0] === "enter")),
	qmGuest: commandRule("passthrough", (c) => c.program === "qm" && (startsWith(c.args, ["guest", "exec"]) || c.args[0] === "terminal")),
	orbShell: commandRule("passthrough", (c) => {
		if (c.program !== "orb" && c.program !== "orbctl") return false;
		const options = parseOptions(c.args, ORB_OPTIONS);
		if (hasAny(options, "m", ["--machine"])) return true;
		const verb = options.operands[0];
		if (verb === undefined) return !hasAny(options, "hv", ["--help", "--version"]);
		return verb === "run" || verb === "shell";
	}),
	limaShell: commandRule("passthrough", (c) => c.program === "limactl" && firstOperand(c) === "shell"),
	multipassExec: commandRule("passthrough", (c) => c.program === "multipass" && ["exec", "shell"].includes(firstOperand(c))),
	distroboxEnter: commandRule("passthrough", (c) => c.program === "distrobox" && firstOperand(c) === "enter"),
	nsenter: commandRule("passthrough", (c) => c.program === "nsenter"),
	su: commandRule("passthrough", (c) => c.program === "su"),
	shellString: commandRule("passthrough", (c) => POSIX_SHELLS.has(c.program) && shellStringOperand(c.args) !== null),
	powershellCommand: commandRule(
		"passthrough",
		(c) => POWERSHELLS.has(c.program.toLowerCase()) && c.args.some((arg) => /^-(c|command|commandwithargs|cwa)$/i.test(arg)),
	),
	repl: commandRule("terminal", (c) => REPLS.has(c.program) && !c.stdinFed && c.args.every((arg) => REPL_FLAGS.has(arg))),
	psql: commandRule(
		"terminal",
		(c) =>
			c.program === "psql" &&
			!c.stdinFed &&
			!hasAny(parseOptions(c.args, PSQL_OPTIONS), "cflV", ["--command", "--file", "--list", "--help", "--version"]),
	),
	mysql: commandRule(
		"terminal",
		(c) =>
			(c.program === "mysql" || c.program === "mariadb") &&
			!c.stdinFed &&
			!hasAny(parseOptions(c.args, MYSQL_OPTIONS), "eV", ["--execute", "--help", "--version"]),
	),
	redisCli: commandRule("terminal", (c) => {
		if (c.program !== "redis-cli" || c.stdinFed) return false;
		const options = parseOptions(c.args, REDIS_OPTIONS);
		return options.operands.length === 0 && !hasAny(options, "x", ["--help", "--version"]);
	}),
	sqlite3: commandRule("terminal", (c) => {
		if (c.program !== "sqlite3" || c.stdinFed) return false;
		const parsed = sqliteArguments(c.args);
		return !hasOption(parsed.flags, "-version", "-help") && parsed.operands.length <= 1;
	}),
	mongosh: commandRule(
		"terminal",
		(c) =>
			c.program === "mongosh" &&
			!c.stdinFed &&
			!c.args.some((arg) => ["--eval", "--file", "-f", "--help", "--version"].includes(optionName(arg)) || arg.endsWith(".js")),
	),
	editor: commandRule("terminal", (c) => {
		if (c.program === "vim" || c.program === "vi" || c.program === "nvim")
			return !c.args.some((arg) => ["-es", "-Es", "--headless", "--version"].includes(arg));
		if (c.program === "nano") return !c.args.includes("--version");
		if (c.program === "emacs") return !c.args.some((arg) => ["--batch", "--script", "--version"].includes(optionName(arg)));
		return false;
	}),
	tui: commandRule("terminal", (c) => {
		if (["htop", "btop", "lazygit", "lazydocker", "tig", "k9s"].includes(c.program)) return true;
		return c.program === "top" && !hasAny(parseOptions(c.args, TOP_OPTIONS), "bl");
	}),
	gitInteractive: commandRule("terminal", (c) => {
		if (c.program !== "git") return false;
		const git = verbOf(c.args, GIT_GLOBAL);
		switch (git.verb) {
			case "rebase":
				return hasAny(parseOptions(git.rest, GIT_REBASE_OPTIONS), "i", ["--interactive"]);
			case "add":
				return hasAny(parseOptions(git.rest, INTERLEAVED), "pi", ["--patch", "--interactive"]);
			case "commit":
				return !hasAny(parseOptions(git.rest, GIT_COMMIT_OPTIONS), "mFC", ["--message", "--file", "--reuse-message", "--no-edit"]);
			default:
				return false;
		}
	}),
	fakeTerminal: commandRule("terminal", (c) => c.program === "expect" || c.program === "script" || c.program === "unbuffer"),
	elevation: commandRule("terminal", (c) => elevation(c.program, c.args)?.prompts === true),
	passwd: commandRule("terminal", (c) => c.program === "passwd"),
	ghAuthLogin: commandRule(
		"terminal",
		(c) => c.program === "gh" && startsWith(c.args, ["auth", "login"]) && !c.args.includes("--with-token"),
	),
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
	tailFollow: commandRule("open-ended", (c) => c.program === "tail" && hasAny(parseOptions(c.args, TAIL_OPTIONS), "fF", ["--follow"])),
	journalFollow: commandRule(
		"open-ended",
		(c) => c.program === "journalctl" && hasAny(parseOptions(c.args, JOURNAL_OPTIONS), "f", ["--follow"]),
	),
	containerLogsFollow: commandRule("open-ended", (c) => {
		const logs = containerVerb(c);
		return logs?.verb === "logs" && hasAny(parseOptions(logs.rest, LOGS_OPTIONS), "f", ["--follow"]);
	}),
	composeLogsFollow: commandRule("open-ended", (c) => {
		const logs = composeVerb(c);
		return logs?.verb === "logs" && hasAny(parseOptions(logs.rest, LOGS_OPTIONS), "f", ["--follow"]);
	}),
	composeUp: commandRule("open-ended", (c) => {
		const up = composeVerb(c);
		return up?.verb === "up" && !hasAny(parseOptions(up.rest, COMPOSE_UP_OPTIONS), "d", ["--detach", "--wait"]);
	}),
	kubectlLogsFollow: commandRule("open-ended", (c) => {
		const logs = kubectlVerb(c);
		return logs?.verb === "logs" && hasAny(parseOptions(logs.rest, KUBECTL_LOGS_OPTIONS), "f", ["--follow"]);
	}),
	kubectlWatch: commandRule("open-ended", (c) => {
		const get = kubectlVerb(c);
		return get?.verb === "get" && hasAny(parseOptions(get.rest, KUBECTL_GET_OPTIONS), "w", ["--watch", "--watch-only"]);
	}),
	watch: commandRule("open-ended", (c) => c.program === "watch"),
	ghRunWatch: commandRule("open-ended", (c) => c.program === "gh" && startsWith(c.args, ["run", "watch"])),
	ping: commandRule(
		"open-ended",
		(c) => (c.program === "ping" || c.program === "ping6") && !hasAny(parseOptions(c.args, PING_OPTIONS), "c"),
	),
	detach: commandRule("open-ended", (c) => c.wrappers.includes("nohup") || c.program === "nohup" || c.program === "setsid"),
	background: commandRule("open-ended", (c) => c.background),
	loopSleep: commandRule("open-ended", (c) => c.program === "sleep" && c.loopBody),
} satisfies Record<string, Rule>;

type PtyRuleId = keyof typeof RULES;

export type PtyHit = { readonly rule: PtyRuleId; readonly category: PtyCategory; readonly program: string };

const isRuleId = (key: string): key is PtyRuleId => Object.hasOwn(RULES, key);
const RULE_IDS: readonly PtyRuleId[] = Object.keys(RULES).filter(isRuleId);

type ShellContext = { readonly piped: boolean; readonly background: boolean; readonly loopBody: boolean };

function commandsOf(tokens: readonly CommandToken[], context: ShellContext): Command[] {
	const invocation = resolveCommand(tokens, context.piped, "none");
	if (invocation === null || invocation.programDynamic || invocation.feed.kind === "xargs") return [];
	const found: Command = {
		program: invocation.program,
		args: invocation.args,
		wrappers: invocation.wrappers,
		stdinFed: invocation.piped || invocation.readInputs.length > 0 || invocation.hereInput,
		background: context.background,
		loopBody: context.loopBody,
	};
	const elevated = elevation(found.program, found.args);
	if (elevated === null || elevated.prompts || elevated.command.length === 0) return [found];
	return [found, ...commandsOf(literalTokens(elevated.command), { ...context, piped: found.stdinFed })];
}

function commandHit(found: Command): PtyHit | null {
	for (const rule of RULE_IDS) {
		const entry: Rule = RULES[rule];
		if (entry.on === "command" && entry.matches(found)) return { rule, category: entry.category, program: found.program };
	}
	return null;
}

export function ptyLineHit(scan: ShellScan): PtyHit | null {
	if (!scan.complete) return null;
	for (const simple of scan.commands) {
		for (const found of commandsOf(simple.tokens, simple)) {
			const hit = commandHit(found);
			if (hit !== null) return hit;
		}
	}
	return null;
}

const shellLineHit = (line: string): PtyHit | null => ptyLineHit(scanShell(line));

function argvHit(words: readonly LaunchWord[] | null): PtyHit | null {
	if (words === null || words.length === 0 || words.some((word) => !word.literal)) return null;
	for (const found of commandsOf(literalTokens(words.map((word) => word.text)), { piped: false, background: false, loopBody: false })) {
		const hit = commandHit(found);
		if (hit !== null) return hit;
	}
	return null;
}

const scriptHit = (text: string | null): PtyHit | null => (text === null ? null : shellLineHit(text));

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
		if (launch === null) continue;
		switch (launch.kind) {
			case "script":
			case "argv": {
				if (launch.via !== "direct" || !PY_LAUNCHES.has(launch.api)) continue;
				const hit = launch.kind === "script" ? scriptHit(launch.text) : argvHit(launch.words);
				if (hit !== null) return hit;
				continue;
			}
			case "shellHelper": {
				if (launch.via !== "direct") continue;
				const hit = scriptHit(launch.text);
				if (hit !== null) return hit;
				continue;
			}
			case "bridge":
			case "execEval":
			case "opaque":
				continue;
			default: {
				const unreachable: never = launch;
				return unreachable;
			}
		}
	}
	for (const rule of RULE_IDS) {
		const entry: Rule = RULES[rule];
		if (entry.on === "python" && entry.matches(scan)) return { rule, category: entry.category, program: entry.program };
	}
	for (const script of scan.shellScripts) {
		const hit = shellLineHit(script);
		if (hit !== null) return hit;
	}
	return null;
}

const JS_LAUNCH_HINT = /bun|spawn|exec|child_process|tool|\bsh\b|\\/i;

function javascriptHit(code: string): PtyHit | null {
	if (!JS_LAUNCH_HINT.test(code)) return null;
	let cell: ReturnType<typeof parseJs>;
	try {
		cell = parseJs(code);
	} catch {
		return null;
	}
	let hit: PtyHit | null = null;
	walk(cell.program, null, (node) => {
		const launch = jsLaunchOf(node, cell.bindings);
		if (launch === null) return false;
		switch (launch.kind) {
			case "bunShell":
				hit = scriptHit(launch.text);
				return hit !== null;
			case "shellHelper":
				if (launch.via === "direct") hit = scriptHit(launch.text);
				return hit !== null;
			case "bunSpawn":
				hit = argvHit(launch.words);
				return hit !== null;
			case "childScript":
				if (launch.via === "direct") hit = scriptHit(launch.text);
				return hit !== null;
			case "childSpawn":
				if (launch.via !== "direct") return false;
				if (!launch.shell) hit = argvHit(launch.words);
				else if (launch.words?.every((word) => word.literal)) hit = shellLineHit(launch.words.map((word) => word.text).join(" "));
				return hit !== null;
			case "bridge":
			case "indeterminate":
				return false;
			default: {
				const unreachable: never = launch;
				return unreachable;
			}
		}
	});
	return hit;
}

export function ptyEvalHit(language: string, code: string): PtyHit | null {
	if (language === "py") return pythonHit(code);
	if (language === "js") return javascriptHit(code);
	return null;
}

const CATEGORY_TEXT: Record<PtyCategory, string> = {
	passthrough: "把命令交给另一台机器、另一个容器、另一个用户或另一个 shell 去解释",
	terminal: "需要终端，或会停在交互提示上",
	"open-ended": "不会自己结束，或在等外部条件",
};

export function ptyRefusal(hit: PtyHit, tool: string): string {
	return [
		`pty 路由：这次 \`${tool}\` 调用没有执行：\`${hit.program}\` ${CATEGORY_TEXT[hit.category]}（${hit.category}，规则 \`${hit.rule}\`）。`,
		"help://bash/terminal",
	].join("\n");
}
