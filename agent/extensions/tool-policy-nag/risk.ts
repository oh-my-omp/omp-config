import { quotedCall } from "./call-quote.ts";
import { detectCommandViolations } from "./heuristic.ts";
import { elevation, literalTokens, resolveCommand } from "./shell-command.ts";
import type { SimpleCommand } from "./shell-parser.ts";
import type { ExecutedTrace, TraceStep } from "./trace.ts";

export type RiskConfig = {
	readonly minCommands: number;
	readonly minChars: number;
	readonly minPrograms: number;
};

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
	for: true,
	case: true,
	exit: true,
	fi: true,
	done: true,
	esac: true,
	"}": true,
};

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

const WRITING_FLAGS: Record<string, RegExp> = {
	curl: /(^|\s)(-o|-O|-T|-d|--data[a-z-]*|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))/,
	wget: /(^|\s)(-o|-O|--post-data|--post-file|--method)/,
	tar: /(^|\s)-[a-z]*[cx]/,
};

type Step = { readonly program: string; readonly args: readonly string[] };

function stepsOf(commands: readonly SimpleCommand[]): Step[] {
	const steps: Step[] = [];
	for (const simple of commands) {
		const invocation = resolveCommand(simple.tokens, simple.piped, "none");
		if (invocation === null) continue;
		steps.push({ program: invocation.program, args: invocation.args });
		const elevated = elevation(invocation.program, invocation.args);
		const inner = elevated === null ? null : resolveCommand(literalTokens(elevated.command), false, "none");
		if (inner !== null) steps.push({ program: inner.program, args: inner.args });
	}
	return steps;
}

function writes(step: Step): boolean {
	if (WRITING_PROGRAMS[step.program] === true) return true;
	const verbs = WRITING_SUBCOMMANDS[step.program];
	const subcommands = step.args.filter((word) => word !== "" && !word.startsWith("-")).slice(0, 2);
	if (verbs !== undefined && subcommands.some((word) => verbs[word] === true)) return true;
	return WRITING_FLAGS[step.program]?.test(step.args.join(" ")) === true;
}

type RiskFinding = {
	readonly commands: number;
	readonly chars: number;
	readonly programs: readonly string[];
	readonly writes: readonly string[];
};

export function inspectRisk(commands: readonly SimpleCommand[], text: string, limits: RiskConfig): RiskFinding | null {
	const steps = stepsOf(commands);
	const simple = commands.length;
	const chars = text.length;
	if (simple < limits.minCommands && chars < limits.minChars) return null;
	const programs = [...new Set(steps.map((step) => step.program))];
	const foreign = programs.filter((program) => SHELL_PLUMBING[program] !== true);
	if (foreign.length < limits.minPrograms) return null;
	const writing = new Set<string>();
	for (const step of steps) if (writes(step)) writing.add(step.program);
	for (const violation of detectCommandViolations(commands, () => true)) {
		for (const category of violation.categories) {
			if (category === "edit" || category === "write") writing.add(violation.program);
		}
	}
	if (writing.size === 0) return null;
	return { commands: simple, chars, programs: foreign, writes: [...writing].sort() };
}

const codeList = (programs: readonly string[]): string => programs.map((program) => `\`${program}\``).join("、");

export function riskReminder(tool: string, command: string, finding: RiskFinding): string {
	const programs = `${codeList(finding.programs.slice(0, 8))}${finding.programs.length > 8 ? "…" : ""}`;
	return [
		`你这次 \`${tool}\` 调用有 ${finding.commands} 段命令、${finding.chars} 字符，牵涉 ${finding.programs.length} 个外部程序（${programs}），其中 ${codeList(finding.writes)} 会写入。`,
		"它太长、牵涉太多别的软件，执行结果没法只从这一行看出来：拆成几条分开跑，或先确认它到底会改动什么。",
		"",
		quotedCall(command, "sh"),
	].join("\n");
}

const SIGPIPE_STATUS = 141;

export function inspectMaskedFailure(trace: ExecutedTrace): readonly TraceStep[] | null {
	const steps = trace.steps.filter((step) => step.resolved !== "none" && !step.wrapsBody);
	if (steps.length < 2) return null;
	const masked = steps.filter((step, index) => {
		if (step.status === 0 || step.statusUsed || step.output) return false;
		if (step.status === SIGPIPE_STATUS && !step.lastStage) return false;
		const next = steps[index + 1]?.source ?? "";
		return !/\$\{?\?/.test(next);
	});
	return masked.length === 0 ? null : masked;
}

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
		quotedCall(command, "sh"),
	].join("\n");
}
