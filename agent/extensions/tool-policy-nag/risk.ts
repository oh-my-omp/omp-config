/**
 * Risk lane of tool-policy-nag: flags a watched shell call whose outcome cannot
 * be read off the call itself — one line that is long, runs many different
 * programs, and mostly talks to software outside the shell, so what it will do
 * (and what it will touch) cannot be predicted from reading it.
 *
 * This is NOT tool routing: which built-in tool should have done the work is the
 * intent lane's question. A call can be a tool violation, a risk, both or
 * neither, and a short call that writes is not a risk.
 *
 * DETECTION is deterministic, never judged:
 *   size — at least `minCommands` simple commands, or `minChars` characters;
 *   breadth — at least `minPrograms` distinct programs that are not shell
 *   plumbing, i.e. real programs interacting with other software;
 *   effect — at least one step that writes (a redirect or `tee`, an in-place
 *   edit, a program that writes by its own job, or a subcommand that writes).
 * A call that only reads is the intent lane's business, and one that only writes
 * a file the agent authored is the `write` rule's.
 *
 * REMINDER. One attributed message naming the length, the programs and the
 * writing steps, then the call. Nothing is blocked, nothing counts, and the same
 * call is reported once. Failures are logged, never thrown.
 */
import { detectShellViolations } from "./heuristic.ts";
import { splitSimpleCommands } from "./shell-parser.ts";

/** Limits a call must exceed to be worth a risk reminder. */
export type RiskConfig = {
	readonly minCommands: number;
	readonly minChars: number;
	readonly minPrograms: number;
};

/** Shell plumbing: steps that organize the line instead of touching other software. */
const SHELL_PLUMBING: Record<string, true> = {
	cd: true,
	echo: true,
	printf: true,
	export: true,
	set: true,
	unset: true,
	source: true,
	".": true,
	":": true,
	true: true,
	false: true,
	pwd: true,
	read: true,
	sleep: true,
	test: true,
	"[": true,
	"[[": true,
	mkdir: true,
};

/**
 * Programs that write as their own job, whatever they are asked to do with the
 * files they touch (`/bin/rm`, `/bin/cp`, package installers, remote copies).
 */
const WRITING_PROGRAMS: Record<string, true> = {
	rm: true,
	rmdir: true,
	shred: true,
	truncate: true,
	dd: true,
	chmod: true,
	chown: true,
	ln: true,
	mkfifo: true,
	mkswap: true,
	mkfs: true,
	cp: true,
	mv: true,
	install: true,
	tee: true,
	unzip: true,
	zip: true,
	rsync: true,
	scp: true,
	make: true,
	"ansible-playbook": true,
	patch: true,
};

/**
 * Programs that write only for some subcommands; only the first two non-flag
 * words are looked at, so a writing word inside a quoted argument (`gh api … --jq
 * '… fork= …'`) or a title does not count.
 */
const WRITING_SUBCOMMANDS: Record<string, Readonly<Record<string, true>>> = {
	git: {
		add: true,
		commit: true,
		push: true,
		pull: true,
		merge: true,
		rebase: true,
		reset: true,
		clean: true,
		checkout: true,
		switch: true,
		restore: true,
		stash: true,
		tag: true,
		rm: true,
		mv: true,
		init: true,
		clone: true,
		apply: true,
		am: true,
		"cherry-pick": true,
		config: true,
		remote: true,
		submodule: true,
		worktree: true,
		gc: true,
		prune: true,
		fetch: true,
	},
	gh: {
		create: true,
		delete: true,
		edit: true,
		merge: true,
		close: true,
		reopen: true,
		comment: true,
		download: true,
		upload: true,
		release: true,
		fork: true,
		clone: true,
		sync: true,
		add: true,
	},
	docker: {
		run: true,
		build: true,
		push: true,
		rm: true,
		rmi: true,
		stop: true,
		start: true,
		restart: true,
		kill: true,
		exec: true,
		compose: true,
		volume: true,
		network: true,
		system: true,
		container: true,
		image: true,
		tag: true,
		load: true,
		save: true,
		import: true,
		export: true,
	},
	kubectl: {
		apply: true,
		delete: true,
		exec: true,
		cp: true,
		patch: true,
		scale: true,
		rollout: true,
		create: true,
		edit: true,
		replace: true,
		set: true,
		drain: true,
		cordon: true,
		taint: true,
	},
	orb: { push: true, create: true, delete: true, stop: true, start: true, clone: true, run: true },
	npm: { install: true, i: true, ci: true, add: true, update: true, uninstall: true, publish: true, link: true, dedupe: true, prune: true },
	pnpm: { install: true, i: true, add: true, update: true, remove: true, publish: true, link: true, store: true },
	yarn: { install: true, add: true, upgrade: true, remove: true, publish: true, link: true },
	bun: { install: true, add: true, remove: true, update: true, link: true, publish: true },
	tofu: { apply: true, destroy: true, import: true, state: true, init: true, workspace: true },
	terraform: { apply: true, destroy: true, import: true, state: true, init: true, workspace: true },
};

/** Programs that write only behind a flag: `curl -o`, `wget -O`, `tar -czf`. */
const WRITING_FLAGS: Record<string, RegExp> = {
	curl: /(^|\s)(-o|-O|-T|-d|--data[a-z-]*|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))/,
	wget: /(^|\s)(-o|-O|--post-data|--post-file|--method)/,
	tar: /(^|\s)-[a-z]*[cx]/,
};

const basename = (path: string): string => {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
};

const isEnvAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

/** One step of the line: the program it runs and the arguments it was given. */
type Step = { readonly program: string; readonly args: string };

function stepsOf(command: string): Step[] {
	const steps: Step[] = [];
	for (const simple of splitSimpleCommands(command)) {
		const words: string[] = [];
		for (const token of simple.tokens) if (token.kind === "word") words.push(token.text);
		let head = words.shift();
		while (head !== undefined && isEnvAssignment(head)) head = words.shift();
		if (head === undefined) continue;
		steps.push({ program: basename(head), args: words.join(" ") });
	}
	return steps;
}

const writesByJob = (step: Step): boolean => WRITING_PROGRAMS[step.program] === true;

/** The subcommand words of a step: the first two non-flag words of its arguments. */
const subcommands = (args: string): string[] =>
	args
		.split(/\s+/)
		.filter((word) => word !== "" && !word.startsWith("-"))
		.slice(0, 2);

const writesBySubcommand = (step: Step): boolean => {
	const verbs = WRITING_SUBCOMMANDS[step.program];
	if (verbs === undefined) return false;
	return subcommands(step.args).some((word) => verbs[word] === true);
};

const writesByFlag = (step: Step): boolean => WRITING_FLAGS[step.program]?.test(step.args) === true;

export type RiskFinding = {
	readonly commands: number;
	readonly chars: number;
	readonly programs: readonly string[];
	readonly writes: readonly string[];
};

/** The finding when the call's outcome is unpredictable from the call, else null. */
export function inspectRisk(command: string, limits: RiskConfig): RiskFinding | null {
	const steps = stepsOf(command);
	const simple = splitSimpleCommands(command).length;
	const chars = command.length;
	if (simple < limits.minCommands && chars < limits.minChars) return null;
	const programs = [...new Set(steps.map((step) => step.program))];
	const foreign = programs.filter((program) => SHELL_PLUMBING[program] !== true);
	if (foreign.length < limits.minPrograms) return null;
	const writes = new Set<string>();
	for (const step of steps) if (writesByJob(step) || writesBySubcommand(step) || writesByFlag(step)) writes.add(step.program);
	for (const violation of detectShellViolations(command)) {
		for (const category of violation.categories) {
			if (category === "edit" || category === "write") writes.add(violation.program);
		}
	}
	if (writes.size === 0) return null;
	return { commands: simple, chars, programs: foreign, writes: [...writes].sort() };
}

/** The risk, why it is one, and the call itself, naming the tool that ran it. */
export function riskReminder(tool: string, command: string, finding: RiskFinding): string {
	return [
		`你这次 \`${tool}\` 调用有 ${finding.commands} 段命令、${finding.chars} 字符，牵涉 ${finding.programs.length} 个外部程序（${finding.programs
			.slice(0, 8)
			.map((program) => `\`${program}\``)
			.join(
				"、",
			)}${finding.programs.length > 8 ? "…" : ""}），其中 ${finding.writes.map((program) => `\`${program}\``).join("、")} 会写入。`,
		"它太长、牵涉太多别的软件，执行结果没法只从这一行看出来：拆成几条分开跑，或先确认它到底会改动什么。",
		"",
		"这次调用：",
		`\`\`\`sh\n${command}\n\`\`\``,
	].join("\n");
}
