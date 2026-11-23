import {
	fileOperands,
	hasOption,
	hasShortLetter,
	type Invocation,
	isDeviceTarget,
	isEnvAssignment,
	isFlag,
	noValues,
	optionName,
	type ParsedArguments,
	parseArguments,
	type ShellWord,
	shellStringOperand,
	type ValueArity,
	valueOptions,
} from "./shell-command.ts";

export type ViolationCategory = "list" | "read" | "search" | "edit" | "write" | "eval";
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type Finding = { readonly category: ViolationCategory; readonly target: string };

export type StreamRole = "filter" | "counter" | "paths" | "authored" | "other";

export type Analysis = {
	readonly findings: readonly Finding[];
	readonly nested: readonly ShellViolation[];
	readonly role: StreamRole;
};

export type AnalysisContext = {
	readonly provenance: StreamRole | null;
	readonly shell: (command: string) => readonly ShellViolation[];
	readonly command: (words: readonly ShellWord[]) => readonly ShellViolation[];
};

type Analyzer = (invocation: Invocation, context: AnalysisContext) => Analysis;

const analysis = (role: StreamRole, findings: readonly Finding[] = [], nested: readonly ShellViolation[] = []): Analysis => ({
	findings,
	nested,
	role,
});

const stdinRole = (invocation: Invocation): StreamRole => (invocation.piped ? "filter" : "other");

const lastOf = (items: readonly string[]): string | undefined => items[items.length - 1];

const LS_VALUES = valueOptions({
	"-I": 1,
	"-w": 1,
	"-T": 1,
	"--ignore": 1,
	"--hide": 1,
	"--width": 1,
	"--tabsize": 1,
	"--format": 1,
	"--sort": 1,
	"--time": 1,
	"--time-style": 1,
	"--quoting-style": 1,
	"--indicator-style": 1,
	"--block-size": 1,
});

const analyzeLs: Analyzer = (invocation) => {
	const { operands } = parseArguments(invocation.args, LS_VALUES);
	return analysis("paths", [{ category: "list", target: fileOperands(operands)[0] ?? "." }]);
};

const TREE_VALUES = valueOptions({
	"-L": 1,
	"-P": 1,
	"-I": 1,
	"-o": 1,
	"-H": 1,
	"--charset": 1,
	"--filelimit": 1,
	"--timefmt": 1,
	"--sort": 1,
});

const treeShowsMetadata = (parsed: ParsedArguments): boolean =>
	["J", "X", "s", "h", "D", "p", "u", "g", "o"].some((letter) => hasShortLetter(parsed.flags, letter)) ||
	hasOption(parsed.flags, "--du", "--fromfile", "--inodes", "--device");

const analyzeTree: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, TREE_VALUES);
	if (treeShowsMetadata(parsed)) return analysis("other");
	return analysis("other", [{ category: "list", target: fileOperands(parsed.operands)[0] ?? "." }]);
};

const FIND_VALUES: Readonly<Record<string, number>> = {
	"-maxdepth": 1,
	"-mindepth": 1,
	"-name": 1,
	"-iname": 1,
	"-path": 1,
	"-ipath": 1,
	"-wholename": 1,
	"-iwholename": 1,
	"-regex": 1,
	"-iregex": 1,
	"-regextype": 1,
	"-type": 1,
	"-xtype": 1,
	"-user": 1,
	"-group": 1,
	"-uid": 1,
	"-gid": 1,
	"-perm": 1,
	"-size": 1,
	"-newer": 1,
	"-anewer": 1,
	"-cnewer": 1,
	"-samefile": 1,
	"-mtime": 1,
	"-mmin": 1,
	"-atime": 1,
	"-amin": 1,
	"-ctime": 1,
	"-cmin": 1,
	"-used": 1,
	"-inum": 1,
	"-links": 1,
	"-fstype": 1,
	"-context": 1,
	"-printf": 1,
	"-fprint": 1,
	"-fprint0": 1,
	"-fls": 1,
	"-fprintf": 2,
	"-files0-from": 1,
};

const findArity = (word: string): number => FIND_VALUES[word] ?? (/^-newer[amcBt]{2}$/.test(word) ? 1 : 0);

const FIND_SELECTION: ReadonlySet<string> = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-regextype",
	"-type",
	"-xtype",
	"-maxdepth",
	"-mindepth",
	"-not",
	"!",
	"-a",
	"-and",
	"-o",
	"-or",
	"(",
	")",
	",",
	"-print",
	"-print0",
	"-prune",
	"-depth",
	"-follow",
	"-xdev",
	"-mount",
	"-nowarn",
	"-warn",
]);

const FIND_ACTIONS: ReadonlySet<string> = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
]);

const FIND_LEADING_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

type FindExpression = {
	readonly paths: readonly string[];
	readonly actions: readonly string[];
	readonly simpleSelection: boolean;
	readonly execBodies: readonly (readonly ShellWord[])[];
};

function parseFindExpression(words: readonly ShellWord[]): FindExpression {
	let index = 0;
	while (index < words.length) {
		const text = words[index]?.text ?? "";
		if (FIND_LEADING_OPTIONS.has(text) || text.startsWith("-O")) index++;
		else if (text === "-D") index += 2;
		else break;
	}
	const paths: string[] = [];
	for (let text = words[index]?.text; text !== undefined; text = words[index]?.text) {
		if (text.startsWith("-") || text === "(" || text === ")" || text === "!" || text === ",") break;
		paths.push(text);
		index++;
	}
	const actions: string[] = [];
	const execBodies: ShellWord[][] = [];
	let simpleSelection = true;
	while (index < words.length) {
		const text = words[index]?.text ?? "";
		if (text === "-exec" || text === "-execdir" || text === "-ok" || text === "-okdir") {
			actions.push(text);
			let end = index + 1;
			while (end < words.length && words[end]?.text !== ";" && words[end]?.text !== "+") end++;
			if (text === "-exec" || text === "-execdir") execBodies.push(words.slice(index + 1, end));
			index = end + 1;
			continue;
		}
		if (FIND_ACTIONS.has(text)) actions.push(text);
		else if (!FIND_SELECTION.has(text) && (text.startsWith("-") || findArity(text) > 0)) simpleSelection = false;
		index += 1 + findArity(text);
	}
	return { paths, actions, simpleSelection, execBodies };
}

const analyzeFind: Analyzer = (invocation, context) => {
	const expression = parseFindExpression(invocation.words);
	if (expression.actions.length === 0) {
		return analysis("paths", [{ category: "list", target: expression.paths[0] ?? "." }]);
	}
	const onlyExec = expression.actions.every((action) => action === "-exec" || action === "-execdir");
	if (!onlyExec || !expression.simpleSelection) return analysis("other");
	return analysis(
		"other",
		[],
		expression.execBodies.flatMap((body) => context.command(body)),
	);
};

const FD_VALUES = valueOptions({
	"-e": 1,
	"--extension": 1,
	"-t": 1,
	"--type": 1,
	"-E": 1,
	"--exclude": 1,
	"-d": 1,
	"--max-depth": 1,
	"--min-depth": 1,
	"--exact-depth": 1,
	"-S": 1,
	"--size": 1,
	"--changed-within": 1,
	"--changed-before": 1,
	"--change-newer-than": 1,
	"--change-older-than": 1,
	"-o": 1,
	"--owner": 1,
	"-j": 1,
	"--threads": 1,
	"--base-directory": 1,
	"--search-path": 1,
	"--ignore-file": 1,
	"-c": 1,
	"--color": 1,
	"--max-results": 1,
	"--path-separator": 1,
	"--format": 1,
	"--batch-size": 1,
});

const FD_EXEC: ReadonlySet<string> = new Set(["-x", "--exec", "-X", "--exec-batch"]);

const analyzeFd: Analyzer = (invocation) => {
	if (invocation.args.some((arg) => FD_EXEC.has(optionName(arg)))) return analysis("other");
	const parsed = parseArguments(invocation.args, FD_VALUES);
	const target = parsed.operands[1] ?? parsed.values.get("--search-path") ?? ".";
	return analysis("paths", [{ category: "list", target }]);
};

const HEAD_VALUES = valueOptions({ "-n": 1, "-c": 1, "--lines": 1, "--bytes": 1 });
const TAIL_VALUES = valueOptions({
	"-n": 1,
	"-c": 1,
	"--lines": 1,
	"--bytes": 1,
	"-s": 1,
	"--sleep-interval": 1,
	"--pid": 1,
	"--max-unchanged-stats": 1,
});
const NL_VALUES = valueOptions({
	"-b": 1,
	"-d": 1,
	"-f": 1,
	"-h": 1,
	"-i": 1,
	"-l": 1,
	"-n": 1,
	"-s": 1,
	"-v": 1,
	"-w": 1,
	"--body-numbering": 1,
	"--section-delimiter": 1,
	"--footer-numbering": 1,
	"--header-numbering": 1,
	"--line-increment": 1,
	"--join-blank-lines": 1,
	"--number-format": 1,
	"--number-separator": 1,
	"--starting-line-number": 1,
	"--number-width": 1,
	"--separator": 1,
	"--width": 1,
});
const BAT_VALUES = valueOptions({
	"-l": 1,
	"--language": 1,
	"-r": 1,
	"--line-range": 1,
	"-H": 1,
	"--highlight-line": 1,
	"-m": 1,
	"--map-syntax": 1,
	"--style": 1,
	"--theme": 1,
	"--tabs": 1,
	"--wrap": 1,
	"--terminal-width": 1,
	"--color": 1,
	"--decorations": 1,
	"--paging": 1,
	"--italic-text": 1,
	"--file-name": 1,
});

const tailFollows = (flags: readonly string[]): boolean =>
	hasOption(flags, "--follow") || hasShortLetter(flags, "f") || hasShortLetter(flags, "F");

const readsFiles =
	(arity: ValueArity): Analyzer =>
	(invocation) => {
		const parsed = parseArguments(invocation.args, arity);
		if (invocation.program === "tail" && tailFollows(parsed.flags)) return analysis("other");
		const target = fileOperands(parsed.operands)[0] ?? invocation.readInputs[0];
		if (target === undefined) return analysis(stdinRole(invocation));
		return analysis("other", [{ category: "read", target }]);
	};

const analyzeCat: Analyzer = (invocation) => {
	const files = fileOperands(parseArguments(invocation.args, noValues).operands);
	const findings: Finding[] = [];
	const source = files[0] ?? invocation.readInputs[0];
	if (source !== undefined) findings.push({ category: "read", target: source });
	const redirect = invocation.outputs[0];
	if (redirect !== undefined) findings.push({ category: "write", target: redirect.target });
	if (source !== undefined) return analysis("other", findings);
	return analysis(invocation.hereInput ? "authored" : stdinRole(invocation), findings);
};

const SED_SCRIPT_OPTIONS = ["-e", "-f", "--expression", "--file"] as const;
const SED_VALUES = valueOptions({ "-e": 1, "-f": 1, "--expression": 1, "--file": 1 });

const analyzeSed: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, SED_VALUES);
	const inPlace = hasOption(parsed.flags, "--in-place") || parsed.flags.some((flag) => /^-[^-]*i/.test(flag));
	const files = fileOperands(hasOption(parsed.flags, ...SED_SCRIPT_OPTIONS) ? parsed.operands : parsed.operands.slice(1));
	if (inPlace) {
		const target = lastOf(files) ?? invocation.readInputs[0];
		return analysis("other", target === undefined ? [] : [{ category: "edit", target }]);
	}
	const source = files[0] ?? invocation.readInputs[0];
	if (source === undefined) return analysis(stdinRole(invocation));
	const quiet = hasOption(parsed.flags, "--quiet", "--silent") || hasShortLetter(parsed.flags, "n");
	return analysis("other", quiet ? [{ category: "read", target: source }] : []);
};

const JQ_VALUES = valueOptions({
	"--arg": 2,
	"--argjson": 2,
	"--slurpfile": 2,
	"--rawfile": 2,
	"--argfile": 2,
	"--indent": 1,
	"-L": 1,
	"-f": 1,
	"--from-file": 1,
});

const JSON_FILE = /\.(?:json|jsonl|ndjson)$/i;

const analyzeJq: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, JQ_VALUES);
	const fromFile = hasOption(parsed.flags, "-f", "--from-file");
	const files = fileOperands(fromFile ? parsed.operands : parsed.operands.slice(1));
	if (files.length === 0 && invocation.readInputs.length === 0) return analysis(stdinRole(invocation));
	const excluded =
		["n", "e", "s"].some((letter) => hasShortLetter(parsed.flags, letter)) ||
		hasOption(
			parsed.flags,
			"--null-input",
			"--exit-status",
			"--slurp",
			"--slurpfile",
			"--rawfile",
			"--argfile",
			"--args",
			"--jsonargs",
			"--seq",
		);
	const source =
		files.length === 1 ? files[0] : files.length === 0 && invocation.readInputs.length === 1 ? invocation.readInputs[0] : undefined;
	if (excluded || source === undefined || !JSON_FILE.test(source)) return analysis("other");
	return analysis("other", [{ category: "read", target: source }]);
};

const SQLITE_VALUES = valueOptions({
	"-cmd": 1,
	"-separator": 1,
	"-newline": 1,
	"-nullvalue": 1,
	"-init": 1,
	"-vfs": 1,
	"-maxsize": 1,
	"-mmap": 1,
	"-lookaside": 2,
	"-pagecache": 2,
});

function isReadOnlySqlite(sql: string): boolean {
	const text = sql
		.trim()
		.replace(/;+\s*$/, "")
		.trim();
	if (/^\.(?:tables|indexes|schema)(?:[ \t]+\S+)?$/i.test(text)) return true;
	if (text.includes(";") || /\n\s*\./.test(text)) return false;
	if (!/^(?:select\b|pragma\s+table_info\s*\()/i.test(text)) return false;
	return !/\b(?:load_extension|writefile|readfile|edit|fts3_tokenizer)\s*\(/i.test(text);
}

export const sqliteArguments = (args: readonly string[]): ParsedArguments =>
	parseArguments(
		args.map((arg) => (arg.startsWith("--") && arg.length > 2 ? arg.slice(1) : arg)),
		SQLITE_VALUES,
	);

const analyzeSqlite: Analyzer = (invocation) => {
	const parsed = sqliteArguments(invocation.args);
	const [database, sql, ...extra] = parsed.operands;
	if (database === undefined || sql === undefined || extra.length > 0 || invocation.readInputs.length > 0) return analysis("other");
	if (database === ":memory:" || hasOption(parsed.flags, "-cmd", "-init")) return analysis("other");
	return analysis("other", isReadOnlySqlite(sql) ? [{ category: "read", target: database }] : []);
};

type TarMode = { list: boolean; extract: boolean; toStdout: boolean; archive: string | undefined };

function applyTarLetters(mode: TarMode, letters: string, next: string | undefined): number {
	for (let index = 0; index < letters.length; index++) {
		const letter = letters[index];
		if (letter === "t") mode.list = true;
		else if (letter === "x") mode.extract = true;
		else if (letter === "O") mode.toStdout = true;
		else if (letter === "f") {
			const attached = letters.slice(index + 1);
			mode.archive = attached.length > 0 ? attached : next;
			return attached.length > 0 ? 0 : 1;
		}
	}
	return 0;
}

const analyzeTar: Analyzer = (invocation) => {
	const args = invocation.args;
	const mode: TarMode = { list: false, extract: false, toStdout: false, archive: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const next = args[index + 1];
		if (index === 0 && /^[A-Za-z]+$/.test(arg)) {
			index += applyTarLetters(mode, arg, next);
		} else if (arg.startsWith("--")) {
			const name = optionName(arg);
			if (name === "--list") mode.list = true;
			else if (name === "--extract" || name === "--get") mode.extract = true;
			else if (name === "--to-stdout") mode.toStdout = true;
			else if (name === "--file") {
				mode.archive = arg === name ? next : arg.slice(name.length + 1);
				if (arg === name) index++;
			}
		} else if (isFlag(arg)) {
			index += applyTarLetters(mode, arg.slice(1), next);
		}
	}
	const reads = mode.list || (mode.extract && mode.toStdout);
	if (!reads || mode.archive === undefined || mode.archive === "-") return analysis("other");
	return analysis("other", [{ category: "read", target: mode.archive }]);
};

const UNZIP_VALUES = valueOptions({ "-d": 1, "-P": 1 });

const analyzeUnzip: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, UNZIP_VALUES);
	const archive = parsed.operands[0];
	const reads = ["l", "p", "Z"].some((letter) => hasShortLetter(parsed.flags, letter));
	if (!reads || archive === undefined || hasOption(parsed.flags, "-P")) return analysis("other");
	return analysis("other", [{ category: "read", target: archive }]);
};

type SearchFamily = {
	readonly arity: ValueArity;
	readonly patternOptions: readonly string[];
	readonly searchesCwd: boolean;
	readonly recursiveFlags: boolean;
	readonly listOptions: readonly string[];
};

const GREP_FAMILY: SearchFamily = {
	arity: valueOptions({
		"-e": 1,
		"-f": 1,
		"-A": 1,
		"-B": 1,
		"-C": 1,
		"-m": 1,
		"-d": 1,
		"-D": 1,
		"--regexp": 1,
		"--file": 1,
		"--include": 1,
		"--exclude": 1,
		"--exclude-dir": 1,
		"--exclude-from": 1,
		"--after-context": 1,
		"--before-context": 1,
		"--context": 1,
		"--max-count": 1,
		"--directories": 1,
		"--devices": 1,
		"--label": 1,
		"--binary-files": 1,
	}),
	patternOptions: ["-e", "-f", "--regexp", "--file"],
	searchesCwd: false,
	recursiveFlags: true,
	listOptions: [],
};

const RG_FAMILY: SearchFamily = {
	arity: valueOptions({
		"-e": 1,
		"-f": 1,
		"-A": 1,
		"-B": 1,
		"-C": 1,
		"-m": 1,
		"-g": 1,
		"-t": 1,
		"-T": 1,
		"-j": 1,
		"-M": 1,
		"-r": 1,
		"-E": 1,
		"-d": 1,
		"--regexp": 1,
		"--file": 1,
		"--glob": 1,
		"--iglob": 1,
		"--type": 1,
		"--type-not": 1,
		"--type-add": 1,
		"--type-clear": 1,
		"--threads": 1,
		"--max-columns": 1,
		"--replace": 1,
		"--encoding": 1,
		"--max-depth": 1,
		"--max-count": 1,
		"--max-filesize": 1,
		"--after-context": 1,
		"--before-context": 1,
		"--context": 1,
		"--sort": 1,
		"--sortr": 1,
		"--pre": 1,
		"--pre-glob": 1,
		"--ignore-file": 1,
		"--colors": 1,
		"--color": 1,
		"--path-separator": 1,
		"--context-separator": 1,
		"--field-match-separator": 1,
		"--field-context-separator": 1,
		"--engine": 1,
		"--dfa-size-limit": 1,
		"--regex-size-limit": 1,
	}),
	patternOptions: ["-e", "-f", "--regexp", "--file"],
	searchesCwd: true,
	recursiveFlags: false,
	listOptions: ["--files"],
};

const AG_FAMILY: SearchFamily = {
	arity: valueOptions({
		"-A": 1,
		"-B": 1,
		"-C": 1,
		"-m": 1,
		"-G": 1,
		"-g": 1,
		"-p": 1,
		"-W": 1,
		"--depth": 1,
		"--ignore": 1,
		"--ignore-dir": 1,
		"--file-search-regex": 1,
		"--path-to-ignore": 1,
		"--after": 1,
		"--before": 1,
		"--context": 1,
		"--max-count": 1,
		"--pager": 1,
		"--width": 1,
	}),
	patternOptions: [],
	searchesCwd: true,
	recursiveFlags: false,
	listOptions: ["-g"],
};

const ACK_FAMILY: SearchFamily = {
	arity: valueOptions({
		"-A": 1,
		"-B": 1,
		"-C": 1,
		"-m": 1,
		"-g": 1,
		"--match": 1,
		"--output": 1,
		"--ignore-dir": 1,
		"--ignore-file": 1,
		"--type-add": 1,
		"--type-set": 1,
	}),
	patternOptions: ["--match"],
	searchesCwd: true,
	recursiveFlags: false,
	listOptions: ["-f", "-g"],
};

const listsMatchingFiles = (flags: readonly string[]): boolean =>
	hasShortLetter(flags, "l") || hasOption(flags, "--files-with-matches", "--files-without-match", "--name-only");

const searchesRecursively = (parsed: ParsedArguments): boolean =>
	hasShortLetter(parsed.flags, "r") ||
	hasShortLetter(parsed.flags, "R") ||
	hasOption(parsed.flags, "--recursive", "--dereference-recursive") ||
	parsed.values.get("-d") === "recurse" ||
	parsed.values.get("--directories") === "recurse";

const searches =
	(family: SearchFamily): Analyzer =>
	(invocation) => {
		const parsed = parseArguments(invocation.args, family.arity);
		if (hasOption(parsed.flags, ...family.listOptions)) {
			return analysis("paths", [{ category: "list", target: fileOperands(parsed.operands)[0] ?? "." }]);
		}
		const patternInOption = hasOption(parsed.flags, ...family.patternOptions);
		if (!patternInOption && parsed.operands.length === 0) return analysis("other");
		const quiet = hasShortLetter(parsed.flags, "q") || hasOption(parsed.flags, "--quiet", "--silent");
		if (quiet && invocation.condition) return analysis("other");
		const files = fileOperands(parsed.operands.slice(patternInOption ? 0 : 1));
		const implicitCwd = family.searchesCwd
			? !invocation.piped && invocation.readInputs.length === 0
			: family.recursiveFlags && searchesRecursively(parsed);
		const target = files[0] ?? invocation.readInputs[0] ?? (implicitCwd ? "." : undefined);
		if (target === undefined) {
			const counts = hasShortLetter(parsed.flags, "c") || hasOption(parsed.flags, "--count");
			return analysis(invocation.piped ? (counts ? "counter" : "filter") : "other");
		}
		return analysis(listsMatchingFiles(parsed.flags) ? "paths" : "other", [{ category: "search", target }]);
	};

const AWK_VALUES = valueOptions({
	"-f": 1,
	"-v": 1,
	"-F": 1,
	"-i": 1,
	"-l": 1,
	"-e": 1,
	"-E": 1,
	"--file": 1,
	"--assign": 1,
	"--field-separator": 1,
	"--include": 1,
	"--load": 1,
	"--source": 1,
	"--exec": 1,
});

const AWK_REGEX = String.raw`\/(?:[^/\\\n]|\\.)+\/`;
const AWK_PRINT_ALL = String.raw`\{\s*print(?:\s+\$0)?\s*;?\s*\}`;
const AWK_SEARCH = new RegExp(String.raw`^!?${AWK_REGEX}(?:\s*${AWK_PRINT_ALL})?$`);
const AWK_LINE_RANGE = String.raw`NR\s*(?:==|>=?|<=?)\s*\d+(?:\s*&&\s*NR\s*(?:==|>=?|<=?)\s*\d+)?`;
const AWK_SECTION = String.raw`${AWK_REGEX}\s*,\s*${AWK_REGEX}`;
const AWK_PRINT_ACTION = String.raw`\{\s*printf?\b[^{};]*;?\s*\}`;
const AWK_READ = new RegExp(String.raw`^(?:(?:${AWK_LINE_RANGE}|${AWK_SECTION})(?:\s*${AWK_PRINT_ACTION})?|1|${AWK_PRINT_ALL})$`);

const analyzeAwk: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, AWK_VALUES);
	const inPlace = parsed.values.get("-i") === "inplace" || parsed.values.get("--include") === "inplace";
	const programInOption = hasOption(parsed.flags, "-f", "--file", "-e", "--source", "-E", "--exec");
	const operands = parsed.operands.filter((operand) => !isEnvAssignment(operand));
	const program = programInOption ? undefined : operands[0];
	const files = fileOperands(programInOption ? operands : operands.slice(1));
	if (inPlace) {
		const target = lastOf(files) ?? invocation.readInputs[0];
		return analysis("other", target === undefined ? [] : [{ category: "edit", target }]);
	}
	const source = files[0] ?? invocation.readInputs[0];
	if (source === undefined) return analysis(stdinRole(invocation));
	const text = program?.trim() ?? "";
	if (AWK_SEARCH.test(text)) return analysis("other", [{ category: "search", target: source }]);
	if (AWK_READ.test(text)) return analysis("other", [{ category: "read", target: source }]);
	return analysis("other");
};

const GIT_GLOBAL_VALUES = valueOptions({
	"-C": 1,
	"-c": 1,
	"--git-dir": 1,
	"--work-tree": 1,
	"--namespace": 1,
	"--config-env": 1,
	"--super-prefix": 1,
});

const GIT_GREP_VALUES = valueOptions({
	"-e": 1,
	"-f": 1,
	"-A": 1,
	"-B": 1,
	"-C": 1,
	"-m": 1,
	"--max-count": 1,
	"--max-depth": 1,
	"--threads": 1,
	"--after-context": 1,
	"--before-context": 1,
	"--context": 1,
});

function analyzeGitGrep(args: readonly string[]): Analysis {
	const separator = args.indexOf("--");
	const before = separator === -1 ? args : args.slice(0, separator);
	const pathspecs = separator === -1 ? [] : args.slice(separator + 1);
	const parsed = parseArguments(before, GIT_GREP_VALUES);
	if (
		hasOption(parsed.flags, "--cached", "--no-index", "-O", "--open-files-in-pager") ||
		parsed.flags.some((flag) => flag.startsWith("-O"))
	) {
		return analysis("other");
	}
	const patterns = hasOption(parsed.flags, "-e", "-f") ? 0 : 1;
	if (parsed.operands.length !== patterns) return analysis("other");
	const role = listsMatchingFiles(parsed.flags) ? "paths" : "other";
	const target = fileOperands(pathspecs).find((pathspec) => !pathspec.startsWith(":")) ?? ".";
	return analysis(role, [{ category: "search", target }]);
}

const analyzeGit: Analyzer = (invocation) => {
	const args = invocation.args;
	let index = 0;
	while (index < args.length && isFlag(args[index] ?? "")) index += 1 + GIT_GLOBAL_VALUES(args[index] ?? "");
	switch (args[index]) {
		case "grep":
			return analyzeGitGrep(args.slice(index + 1));
		case "ls-files":
			return analysis("paths");
		default:
			return analysis("other");
	}
};

const PERL_VALUES = valueOptions({ "-e": 1, "-E": 1, "-f": 1, "--eval": 1, "--file": 1 });

const analyzePerl: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, PERL_VALUES);
	const inPlace = hasOption(parsed.flags, "--in-place") || parsed.flags.some((flag) => /^-[^-]*i/.test(flag));
	const files = fileOperands(parsed.operands);
	if (!inPlace) return analysis(files.length === 0 && invocation.readInputs.length === 0 ? stdinRole(invocation) : "other");
	const target = lastOf(files) ?? invocation.readInputs[0];
	return analysis("other", target === undefined ? [] : [{ category: "edit", target }]);
};

function moveTarget(args: readonly string[], operands: readonly string[]): string | undefined {
	let targetDirectory: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "-t" || arg === "--target-directory") {
			targetDirectory = args[index + 1];
			index++;
		} else if (arg.startsWith("--target-directory=")) {
			targetDirectory = arg.slice("--target-directory=".length);
		} else if (arg.startsWith("-t") && arg.length > 2) {
			targetDirectory = arg.slice(2);
		}
	}
	if (targetDirectory !== undefined && operands.length > 0) return targetDirectory;
	return operands.length < 2 ? undefined : lastOf(fileOperands(operands));
}

const analyzeMv: Analyzer = (invocation) => {
	const parsed = parseArguments(invocation.args, valueOptions({ "-t": 1, "--target-directory": 1, "-S": 1, "--suffix": 1 }));
	const target = moveTarget(invocation.args, parsed.operands);
	return analysis("other", target === undefined ? [] : [{ category: "edit", target }]);
};

const analyzeEcho: Analyzer = (invocation) => {
	const redirect = invocation.outputs[0];
	return analysis("authored", redirect === undefined ? [] : [{ category: "write", target: redirect.target }]);
};

const analyzeTee: Analyzer = (invocation, context) => {
	const target = fileOperands(parseArguments(invocation.args, noValues).operands).find((operand) => !isDeviceTarget(operand));
	const authored = invocation.hereInput || context.provenance === "authored";
	return analysis("filter", authored && target !== undefined ? [{ category: "write", target }] : []);
};

function firstScriptOperand(args: readonly string[]): string | undefined {
	let options = true;
	for (const arg of args) {
		if (options && arg === "--") {
			options = false;
			continue;
		}
		if (options && isFlag(arg)) continue;
		return arg;
	}
	return undefined;
}

const INTERPRETER_VALUES = valueOptions({
	"-W": 1,
	"-X": 1,
	"-r": 1,
	"--require": 1,
	"--import": 1,
	"--loader": 1,
	"--conditions": 1,
	"--preload": 1,
	"--cwd": 1,
	"--env-file": 1,
});

function inlineEvalTarget(invocation: Invocation): string | null {
	const args = invocation.args;
	if (invocation.program === "deno" && args[0] === "eval") return firstScriptOperand(args.slice(1)) ?? "<inline>";
	let index = 0;
	for (; index < args.length && isFlag(args[index] ?? "") && args[index] !== "--"; index++) {
		const arg = args[index] ?? "";
		if (arg === "-e" || arg === "-c" || arg === "--eval" || arg === "-p") return args[index + 1] ?? "<inline>";
		if (arg.startsWith("--eval=")) return arg.slice("--eval=".length);
		if (!arg.startsWith("--") && /^-[ecp].+/.test(arg)) return arg.slice(2);
		index += INTERPRETER_VALUES(arg);
	}
	const script = args[index] === "--" ? args[index + 1] : args[index];
	return script === "-" ? "<stdin>" : null;
}

const analyzeInterpreter: Analyzer = (invocation) => {
	const target = inlineEvalTarget(invocation);
	return analysis("other", target === null ? [] : [{ category: "eval", target }]);
};

const analyzeShellString: Analyzer = (invocation, context) => {
	const index = shellStringOperand(invocation.args);
	const script = index === null ? undefined : invocation.words[index];
	if (script === undefined || script.dynamic) return analysis("other");
	return analysis("other", [], context.shell(script.text));
};

const analyzeEvalBuiltin: Analyzer = (invocation, context) => {
	if (invocation.words.length === 0 || invocation.words.some((word) => word.dynamic)) return analysis("other");
	return analysis("other", [], context.shell(invocation.args.join(" ")));
};

const WC_VALUES = valueOptions({ "--files0-from": 1 });
const SORT_VALUES = valueOptions({
	"-k": 1,
	"--key": 1,
	"-t": 1,
	"--field-separator": 1,
	"-S": 1,
	"--buffer-size": 1,
	"-T": 1,
	"--temporary-directory": 1,
	"--compress-program": 1,
	"--batch-size": 1,
	"--parallel": 1,
	"--files0-from": 1,
	"-o": 1,
	"--output": 1,
});
const UNIQ_VALUES = valueOptions({
	"-f": 1,
	"--skip-fields": 1,
	"-s": 1,
	"--skip-chars": 1,
	"-w": 1,
	"--check-chars": 1,
});
const CUT_VALUES = valueOptions({
	"-b": 1,
	"-c": 1,
	"-d": 1,
	"-f": 1,
	"--bytes": 1,
	"--characters": 1,
	"--delimiter": 1,
	"--fields": 1,
	"--output-delimiter": 1,
});
const COLUMN_VALUES = valueOptions({ "-s": 1, "-c": 1, "-o": 1, "-N": 1, "-R": 1, "-W": 1, "-H": 1, "-O": 1, "-E": 1, "-d": 1 });

const reshapes =
	(arity: ValueArity, counts: (parsed: ParsedArguments) => boolean): Analyzer =>
	(invocation) => {
		const parsed = parseArguments(invocation.args, arity);
		const readsStdin = fileOperands(parsed.operands).length === 0 && invocation.readInputs.length === 0 && invocation.feed.kind === "argv";
		if (!readsStdin || !invocation.piped) return analysis("other");
		return analysis(counts(parsed) ? "counter" : "filter");
	};

const noCount = (_parsed: ParsedArguments): boolean => false;

const ANALYZERS = {
	ls: analyzeLs,
	tree: analyzeTree,
	find: analyzeFind,
	fd: analyzeFd,
	cat: analyzeCat,
	bat: readsFiles(BAT_VALUES),
	nl: readsFiles(NL_VALUES),
	head: readsFiles(HEAD_VALUES),
	tail: readsFiles(TAIL_VALUES),
	less: readsFiles(noValues),
	more: readsFiles(noValues),
	zcat: readsFiles(noValues),
	sed: analyzeSed,
	jq: analyzeJq,
	sqlite3: analyzeSqlite,
	tar: analyzeTar,
	unzip: analyzeUnzip,
	grep: searches(GREP_FAMILY),
	egrep: searches(GREP_FAMILY),
	fgrep: searches(GREP_FAMILY),
	rg: searches(RG_FAMILY),
	ripgrep: searches(RG_FAMILY),
	ag: searches(AG_FAMILY),
	ack: searches(ACK_FAMILY),
	awk: analyzeAwk,
	gawk: analyzeAwk,
	git: analyzeGit,
	perl: analyzePerl,
	mv: analyzeMv,
	echo: analyzeEcho,
	printf: analyzeEcho,
	tee: analyzeTee,
	node: analyzeInterpreter,
	bun: analyzeInterpreter,
	deno: analyzeInterpreter,
	python: analyzeInterpreter,
	python3: analyzeInterpreter,
	ruby: analyzeInterpreter,
	bash: analyzeShellString,
	sh: analyzeShellString,
	zsh: analyzeShellString,
	dash: analyzeShellString,
	eval: analyzeEvalBuiltin,
	wc: reshapes(WC_VALUES, () => true),
	sort: reshapes(SORT_VALUES, noCount),
	uniq: reshapes(UNIQ_VALUES, (parsed) => hasShortLetter(parsed.flags, "c") || hasOption(parsed.flags, "--count")),
	tr: reshapes(noValues, noCount),
	cut: reshapes(CUT_VALUES, noCount),
	column: reshapes(COLUMN_VALUES, noCount),
} satisfies Record<string, Analyzer>;

export type ShellProgram = keyof typeof ANALYZERS;

export type ShellViolation = {
	readonly categories: NonEmptyReadonlyArray<ViolationCategory>;
	readonly program: ShellProgram;
	readonly target: string;
};

export const isShellProgram = (program: string): program is ShellProgram => Object.hasOwn(ANALYZERS, program);

export const analyzeProgram = (program: ShellProgram, invocation: Invocation, context: AnalysisContext): Analysis =>
	ANALYZERS[program](invocation, context);
