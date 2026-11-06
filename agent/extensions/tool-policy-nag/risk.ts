/**
 * Risk lane of tool-policy-nag: flags a shell call whose outcome the agent
 * cannot read off the result it got back. A call can be a tool violation, a
 * risk, both or neither; which built-in tool should have done the work is the
 * intent lane's question.
 *
 * DETECTION is deterministic, never judged, and depends on what the run left:
 *
 * - A foreground `bash` run with its whole execution trace (`trace.ts`) is
 *   judged on what ran: it is a risk when at least two steps ran and one of
 *   them failed silently — a non-zero exit status that nothing tested (not an
 *   `if`/`elif`/`while`/`until` test, not negated by `!`, not a non-final
 *   `&&`/`||` operand, not inside a substitution, not read as `$?` by the
 *   next command), that is not a pipeline stage's SIGPIPE (141) before a
 *   later stage, and that wrote no output of its own. Function calls, `eval`,
 *   `source` and `.` stand for their bodies,
 *   whose steps are judged instead. Length, breadth and writes do not matter.
 * - A call that went to the background before it ended has no complete trace
 *   and is judged from its text, as before the trace existed:
 *   size — at least `minCommands` simple commands, or `minChars` characters;
 *   breadth — at least `minPrograms` distinct programs that are not shell
 *   plumbing; effect — at least one step that writes (a redirect or `tee`, an
 *   in-place edit, a program that writes by its own job, or a subcommand that
 *   writes). The same text rule covers any other call without a usable trace.
 * - A run cut short (timed out, cancelled) is not judged.
 *
 * REMINDER. One attributed message naming what was found, then the call.
 * Nothing is blocked, nothing counts, and the same call is reported once.
 */
import { detectShellViolations } from "./heuristic.ts";
import { splitSimpleCommands } from "./shell-parser.ts";
import type { ExecutedTrace, TraceStep } from "./trace.ts";

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

/** SIGPIPE: a stage stops writing because a later stage closed the pipe. */
const SIGPIPE_STATUS = 141;

/** The steps that failed where nothing in the call or its output shows it. */
export function inspectMaskedFailure(trace: ExecutedTrace): readonly TraceStep[] | null {
	const steps = trace.steps.filter((step) => step.resolved !== "none" && !step.wrapsBody);
	if (steps.length < 2) return null;
	const masked = steps.filter((step, index) => {
		if (step.status === 0 || step.statusUsed || step.output) return false;
		if (step.status === SIGPIPE_STATUS && !step.lastStage) return false;
		// `cmd; echo "$?"`: the next command reads the status, so the failure is shown.
		const next = steps[index + 1]?.source ?? "";
		return !/\$\{?\?/.test(next);
	});
	return masked.length === 0 ? null : masked;
}

/** The silent failures, why they matter, and the call itself. */
export function maskedFailureReminder(tool: string, command: string, masked: readonly TraceStep[]): string {
	const shown = (step: TraceStep): string => {
		const text = step.argv.join(" ");
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	};
	return [
		`你这次 \`${tool}\` 调用里有步骤失败了，但返回结果里看不出来：`,
		...masked.map((step) => `- \`${shown(step)}\` 退出码 ${step.status}，没有任何输出，也没有被 \`if\`/\`&&\`/\`||\`/\`!\` 检查。`),
		"后面的步骤照常执行了，整条调用的输出不能说明每一步都成功。先确认这一步为什么失败、对后续步骤有没有影响：把它单独运行，或用 `&&` 串联让失败停住整条命令。",
		"",
		"这次调用：",
		`\`\`\`sh\n${command}\n\`\`\``,
	].join("\n");
}
