import type { CommandToken } from "./shell-parser.ts";

export type ShellWord = { readonly text: string; readonly dynamic: boolean };

type OutputRedirect = { readonly operator: "write" | "append"; readonly target: string };

type ArgumentFeed = { readonly kind: "argv" } | { readonly kind: "xargs"; readonly replace: boolean };

export type Invocation = {
	readonly program: string;
	readonly programDynamic: boolean;
	readonly wrappers: readonly string[];
	readonly words: readonly ShellWord[];
	readonly args: readonly string[];
	readonly readInputs: readonly string[];
	readonly hereInput: boolean;
	readonly outputs: readonly OutputRedirect[];
	readonly piped: boolean;
	readonly condition: boolean;
	readonly feed: ArgumentFeed;
};

type Exemption = "elevatedAndRemote" | "none";

export const basename = (path: string): string => {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
};

export const isEnvAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

export const isFlag = (text: string): boolean => text.length > 1 && text.startsWith("-");

export const isDeviceTarget = (target: string): boolean => target.startsWith("/dev/");

export const optionName = (flag: string): string => {
	const equals = flag.indexOf("=");
	return equals === -1 ? flag : flag.slice(0, equals);
};

export type ValueArity = (flag: string) => number;

export const noValues: ValueArity = () => 0;

export const valueOptions =
	(table: Readonly<Record<string, number>>): ValueArity =>
	(flag) => {
		const name = optionName(flag);
		return flag === name ? (table[name] ?? 0) : 0;
	};

type OptionOrder = "interleaved" | "optionsFirst";

export type OptionGrammar = { readonly arity: ValueArity; readonly valueLetters: string; readonly order: OptionOrder };

export const grammar = (valueLetters: string, valueLongs: readonly string[], order: OptionOrder): OptionGrammar => ({
	arity: valueOptions(Object.fromEntries(valueLongs.map((name) => [name, 1]))),
	valueLetters,
	order,
});

export const OPTIONS_FIRST = grammar("", [], "optionsFirst");

export const INTERLEAVED = grammar("", [], "interleaved");

export type ParsedArguments = {
	readonly flags: readonly string[];
	readonly letters: ReadonlySet<string>;
	readonly operands: readonly string[];
	readonly values: ReadonlyMap<string, string>;
};

const isShortCluster = (flag: string): boolean => flag.length > 1 && flag.startsWith("-") && !flag.startsWith("--");

function addClusterLetters(flag: string, valueLetters: string, letters: Set<string>): number {
	for (let k = 1; k < flag.length; k++) {
		const letter = flag.charAt(k);
		letters.add(letter);
		if (valueLetters.includes(letter)) return k === flag.length - 1 ? 1 : 0;
	}
	return 0;
}

export function parseOptions(args: readonly string[], spec: OptionGrammar): ParsedArguments {
	const flags: string[] = [];
	const letters = new Set<string>();
	const operands: string[] = [];
	const values = new Map<string, string>();
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (!options || !isFlag(arg)) {
			operands.push(arg);
			if (spec.order === "optionsFirst") options = false;
			continue;
		}
		if (arg === "--") {
			options = false;
			continue;
		}
		flags.push(arg);
		const clustered = isShortCluster(arg) ? addClusterLetters(arg, spec.valueLetters, letters) : 0;
		const name = optionName(arg);
		if (arg !== name) {
			values.set(name, arg.slice(name.length + 1));
			continue;
		}
		const count = Math.max(spec.arity(arg), clustered);
		const value = args[i + 1];
		if (count > 0 && value !== undefined) values.set(name, value);
		i += count;
	}
	return { flags, letters, operands, values };
}

export const parseArguments = (args: readonly string[], arity: ValueArity): ParsedArguments =>
	parseOptions(args, { arity, valueLetters: "", order: "interleaved" });

export const hasShortLetter = (flags: readonly string[], letter: string): boolean =>
	flags.some((flag) => isShortCluster(flag) && flag.slice(1).includes(letter));

export const hasOption = (flags: readonly string[], ...names: readonly string[]): boolean =>
	flags.some((flag) => names.includes(optionName(flag)));

export const hasAny = (parsed: ParsedArguments, letters: string, longs: readonly string[] = []): boolean =>
	[...letters].some((letter) => parsed.letters.has(letter)) || hasOption(parsed.flags, ...longs);

const SET_OPTION_WITH_NAME = /^[-+][A-Za-z]*[oO]$/;

export function shellStringOperand(args: readonly string[]): number | null {
	let runsString = false;
	let index = 0;
	while (index < args.length) {
		const arg = args[index] ?? "";
		if (!isFlag(arg) && !arg.startsWith("+")) break;
		if (arg === "--") {
			index++;
			break;
		}
		const name = optionName(arg);
		if (name === "--command") runsString = true;
		else if (name === "--rcfile" || name === "--init-file") index++;
		else if (isShortCluster(arg) && arg.includes("c")) runsString = true;
		if (SET_OPTION_WITH_NAME.test(arg)) index++;
		index++;
	}
	return runsString ? index : null;
}

const SUDO_OPTIONS = grammar(
	"ugCDhpRrtTU",
	[
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
	"optionsFirst",
);
const DOAS_OPTIONS = grammar("uC", [], "optionsFirst");
const RUN0_OPTIONS = grammar(
	"uDgM",
	["--user", "--group", "--chdir", "--machine", "--unit", "--property", "--description", "--slice"],
	"optionsFirst",
);

export type Elevation = { readonly prompts: boolean; readonly command: readonly string[] };

export function elevation(program: string, args: readonly string[]): Elevation | null {
	switch (program) {
		case "sudo": {
			const parsed = parseOptions(args, SUDO_OPTIONS);
			return { prompts: !hasAny(parsed, "nS", ["--non-interactive", "--stdin"]), command: parsed.operands };
		}
		case "doas": {
			const parsed = parseOptions(args, DOAS_OPTIONS);
			return { prompts: !hasAny(parsed, "n"), command: parsed.operands };
		}
		case "run0":
			return { prompts: !args.includes("--no-ask-password"), command: parseOptions(args, RUN0_OPTIONS).operands };
		default:
			return null;
	}
}

export const fileOperands = (operands: readonly string[]): string[] => operands.filter((operand) => operand !== "-" && operand.length > 0);

export const literalTokens = (words: readonly string[]): CommandToken[] => words.map((text) => ({ kind: "word", text, dynamic: false }));

const EXEMPT_PROGRAMS: Readonly<Record<string, true>> = { sudo: true, doas: true, su: true, ssh: true };

const RESERVED_WORDS: ReadonlySet<string> = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"]);

const CONDITION_WORDS: ReadonlySet<string> = new Set(["!", "if", "elif", "while", "until"]);

type WrapperSkip = { readonly kind: "skip"; readonly count: number } | { readonly kind: "stop" };

type WrapperSpec = {
	readonly arity: ValueArity;
	readonly stops: (flag: string) => boolean;
	readonly positional: number;
};

const never = (_flag: string): boolean => false;

const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
	command: { arity: noValues, stops: (flag) => isShortCluster(flag) && /[vV]/.test(flag), positional: 0 },
	builtin: { arity: noValues, stops: never, positional: 0 },
	exec: { arity: valueOptions({ "-a": 1 }), stops: never, positional: 0 },
	env: {
		arity: valueOptions({ "-u": 1, "--unset": 1, "-C": 1, "--chdir": 1 }),
		stops: (flag) => optionName(flag) === "--split-string" || (isShortCluster(flag) && flag.includes("S")),
		positional: 0,
	},
	nohup: { arity: noValues, stops: never, positional: 0 },
	nice: { arity: valueOptions({ "-n": 1, "--adjustment": 1 }), stops: never, positional: 0 },
	stdbuf: { arity: valueOptions({ "-i": 1, "-o": 1, "-e": 1, "--input": 1, "--output": 1, "--error": 1 }), stops: never, positional: 0 },
	timeout: { arity: valueOptions({ "-s": 1, "--signal": 1, "-k": 1, "--kill-after": 1 }), stops: never, positional: 1 },
	time: { arity: valueOptions({ "-f": 1, "--format": 1, "-o": 1, "--output": 1 }), stops: never, positional: 0 },
	xargs: {
		arity: valueOptions({
			"-I": 1,
			"-L": 1,
			"-n": 1,
			"-P": 1,
			"-s": 1,
			"-d": 1,
			"-E": 1,
			"-a": 1,
			"--arg-file": 1,
			"--delimiter": 1,
			"--max-args": 1,
			"--max-lines": 1,
			"--max-procs": 1,
			"--max-chars": 1,
			"--eof": 1,
			"--process-slot-var": 1,
		}),
		stops: never,
		positional: 0,
	},
};

function skipWrapper(spec: WrapperSpec, rest: readonly string[]): WrapperSkip {
	let index = 0;
	while (index < rest.length) {
		const word = rest[index];
		if (word === undefined) break;
		if (word === "--") {
			index++;
			break;
		}
		if (word !== "-" && !isFlag(word)) break;
		if (spec.stops(word)) return { kind: "stop" };
		index += 1 + spec.arity(word);
	}
	return { kind: "skip", count: index + spec.positional };
}

type Redirections = {
	readonly words: readonly ShellWord[];
	readonly readInputs: readonly string[];
	readonly hereInput: boolean;
	readonly outputs: readonly OutputRedirect[];
};

function splitRedirections(tokens: readonly CommandToken[]): Redirections {
	const words: ShellWord[] = [];
	const readInputs: string[] = [];
	const outputs: OutputRedirect[] = [];
	let hereInput = false;
	for (let j = 0; j < tokens.length; j++) {
		const token = tokens[j];
		if (token === undefined) continue;
		if (token.kind === "word") {
			words.push({ text: token.text, dynamic: token.dynamic });
			continue;
		}
		if (token.kind === "otherRedirect" && token.fd === 0 && (token.operator === "hereDoc" || token.operator === "hereString")) {
			hereInput = true;
		}
		const target = tokens[j + 1];
		if (target?.kind !== "word") continue;
		j++;
		if (token.kind === "readFrom") {
			if (token.fd === 0) readInputs.push(target.text);
			continue;
		}
		const writesFile =
			token.operator === "write" ||
			token.operator === "append" ||
			(token.operator === "other" && !/^\d+$/.test(target.text) && target.text !== "-");
		if (token.fd === 1 && writesFile && !isDeviceTarget(target.text)) {
			outputs.push({ operator: token.operator === "append" ? "append" : "write", target: target.text });
		}
	}
	return { words, readInputs, hereInput, outputs };
}

export function resolveCommand(tokens: readonly CommandToken[], piped: boolean, exemption: Exemption): Invocation | null {
	const { words, readInputs, hereInput, outputs } = splitRedirections(tokens);
	let index = 0;
	let atStart = true;
	let condition = false;
	let feed: ArgumentFeed = { kind: "argv" };
	const wrappers: string[] = [];
	while (index < words.length) {
		const word = words[index];
		if (word === undefined) return null;
		if (isEnvAssignment(word.text)) {
			index++;
			continue;
		}
		if (atStart && RESERVED_WORDS.has(word.text)) {
			condition = CONDITION_WORDS.has(word.text);
			index++;
			continue;
		}
		const program = basename(word.text);
		if (exemption === "elevatedAndRemote" && EXEMPT_PROGRAMS[program] === true) return null;
		const wrapper = WRAPPERS[program];
		if (wrapper === undefined) {
			const rest = words.slice(index + 1);
			return {
				program,
				programDynamic: word.dynamic,
				wrappers,
				words: rest,
				args: rest.map((each) => each.text),
				readInputs,
				hereInput,
				outputs,
				piped: feed.kind === "argv" && piped,
				condition,
				feed,
			};
		}
		wrappers.push(program);
		atStart = false;
		const rest = words.slice(index + 1).map((each) => each.text);
		const skip = skipWrapper(wrapper, rest);
		if (skip.kind === "stop") return null;
		if (program === "xargs") {
			const replace = rest
				.slice(0, skip.count)
				.some((option) => option.startsWith("-I") || option.startsWith("-i") || optionName(option) === "--replace");
			feed = { kind: "xargs", replace };
		}
		index += 1 + skip.count;
	}
	return null;
}
