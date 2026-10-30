type RedirectOperator = "write" | "append" | "hereDoc" | "hereString" | "other";
export type CommandToken =
	/** `dynamic`: the word's text holds an unexpanded `$…` or a command substitution, so its runtime value is unknown. */
	| { readonly kind: "word"; readonly text: string; readonly dynamic: boolean }
	/** `<` — the following word is a file the command reads. */
	| { readonly kind: "readFrom"; readonly fd: number }
	/** `>`, `>>`, `2>`, `<<`, `<<<` — the following word is not a file being read. */
	| {
			readonly kind: "otherRedirect";
			readonly operator: RedirectOperator;
			readonly fd: number;
	  };

const isOperatorChar = (ch: string): boolean =>
	ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`";

type HereDocument = { readonly delimiter: string; readonly stripTabs: boolean };

const skipHereDocument = (command: string, start: number, document: HereDocument): number => {
	let cursor = start;
	while (cursor < command.length) {
		const lineEnd = command.indexOf("\n", cursor);
		const end = lineEnd === -1 ? command.length : lineEnd;
		const line = command.slice(cursor, end);
		const comparable = document.stripTabs ? line.replace(/^\t+/, "") : line;
		if (comparable === document.delimiter) return lineEnd === -1 ? command.length : lineEnd + 1;
		if (lineEnd === -1) return command.length;
		cursor = lineEnd + 1;
	}
	return command.length;
};

function skipHereDocuments(command: string, start: number, documents: readonly HereDocument[]): number {
	let cursor = start;
	for (const document of documents) cursor = skipHereDocument(command, cursor, document);
	return cursor;
}

type RedirectParse = {
	readonly token: CommandToken;
	readonly consumed: number;
	readonly document: HereDocument | null;
};

function parseRedirect(command: string, index: number, ch: "<" | ">", fdPrefix: number | null): RedirectParse {
	let operator: RedirectOperator;
	let consumed = 0;
	let document: HereDocument | null = null;
	if (ch === ">") {
		if (command[index + 1] === ">") {
			operator = "append";
			consumed = 1;
		} else if (command[index + 1] === "&") {
			operator = "other";
			consumed = 1;
		} else if (command[index + 1] === "|") {
			// `>|` clobbers like `>`; the `|` is not a pipe.
			operator = "write";
			consumed = 1;
		} else {
			operator = "write";
		}
	} else if (command[index + 1] === "<" && command[index + 2] === "<") {
		operator = "hereString";
		consumed = 2;
	} else if (command[index + 1] === "<") {
		operator = "hereDoc";
		const stripTabs = command[index + 2] === "-";
		consumed = stripTabs ? 2 : 1;
		document = { delimiter: "", stripTabs };
	} else if (command[index + 1] === "&") {
		operator = "other";
		consumed = 1;
	} else {
		return { token: { kind: "readFrom", fd: fdPrefix ?? 0 }, consumed, document };
	}
	return { token: { kind: "otherRedirect", operator, fd: fdPrefix ?? (ch === ">" ? 1 : 0) }, consumed, document };
}

/**
 * Splits a shell line into simple commands, keeping only what the detector needs:
 * command-position words, and whether a word is a redirection target. Quotes are
 * consumed (their content stays a single word), `$(`/backtick substitutions and
 * control operators end the current command, so `echo $(cat f)` still exposes
 * `cat f` as its own simple command. Here-document bodies are opaque.
 * `piped`: the command is a later stage of a `|`/`|&` pipeline, so its stdin is
 * the previous stage's stdout. `captured`: the command runs inside a `$(…)` or
 * backtick substitution, so its stdout becomes words of the enclosing command.
 * `background`: its pipeline ends in a lone `&` (not `&&`), so the shell does
 * not wait for it. `loopBody`: it runs between a `while`/`until`/`for` loop's
 * `do` and `done` (the `do` command included), so it repeats; the loop's
 * condition or header is not body.
 */
export type SimpleCommand = {
	readonly tokens: CommandToken[];
	readonly pipelineId: number;
	readonly piped: boolean;
	readonly captured: boolean;
	readonly background: boolean;
	readonly loopBody: boolean;
};

type ParsedCommand = Omit<SimpleCommand, "background" | "loopBody">;

const LOOP_OPENERS: ReadonlySet<string> = new Set(["while", "until", "for"]);

/**
 * Marks loop bodies from each command's first word: `while`/`until`/`for`
 * opens a loop, `do` starts its body, `done` closes it. Only a command's first
 * word counts, so `echo done` changes nothing.
 */
function markLoops(commands: readonly ParsedCommand[], background: ReadonlySet<number>): SimpleCommand[] {
	const loops: boolean[] = [];
	return commands.map((command) => {
		const first = command.tokens[0];
		const head = first?.kind === "word" && !first.dynamic ? first.text : "";
		if (LOOP_OPENERS.has(head)) loops.push(false);
		else if (head === "do" && loops.length > 0) loops[loops.length - 1] = true;
		else if (head === "done") loops.pop();
		return { ...command, background: background.has(command.pipelineId), loopBody: head !== "done" && loops.includes(true) };
	});
}

/** `unterminated`: a quote or `$(`/backtick substitution never closes, so the shell would refuse the line. */
export type ShellParse = { readonly kind: "complete"; readonly commands: SimpleCommand[] } | { readonly kind: "unterminated" };

/** The simple commands of a line, best effort: an unterminated line yields what was read. */
export function splitSimpleCommands(command: string): SimpleCommand[] {
	return scanCommands(command).commands;
}

/** The simple commands of a line, or `unterminated` when the line cannot run as written. */
export function parseShellCommands(command: string): ShellParse {
	const scanned = scanCommands(command);
	return scanned.complete ? { kind: "complete", commands: scanned.commands } : { kind: "unterminated" };
}

function scanCommands(command: string): { readonly commands: SimpleCommand[]; readonly complete: boolean } {
	const commands: ParsedCommand[] = [];
	const background = new Set<number>();
	let current: CommandToken[] = [];
	let pipelineId = 0;
	let nextPipelineId = 1;
	let word = "";
	let wordStart: number | null = null;
	let wordCanBeFd = true;
	let wordDynamic = false;
	let piped = false;
	let quote: '"' | "'" | null = null;
	const substitutions: Array<{ readonly delimiter: "$(" | "`"; readonly resumeQuote: '"' | null }> = [];
	const suspendedCommands: Array<{ readonly current: CommandToken[]; readonly pipelineId: number; readonly piped: boolean }> = [];
	const hereDocuments: HereDocument[] = [];
	let expectingHereDocumentDelimiter: HereDocument | null = null;
	const flushWord = (): void => {
		if (word.length === 0) {
			wordStart = null;
			wordCanBeFd = true;
			wordDynamic = false;
			return;
		}
		current.push({ kind: "word", text: word, dynamic: wordDynamic });
		if (expectingHereDocumentDelimiter !== null) {
			hereDocuments.push({ delimiter: word, stripTabs: expectingHereDocumentDelimiter.stripTabs });
			expectingHereDocumentDelimiter = null;
		}
		word = "";
		wordStart = null;
		wordCanBeFd = true;
		wordDynamic = false;
	};
	const flushCommand = (): void => {
		flushWord();
		if (current.length === 0) return;
		commands.push({ tokens: current, pipelineId, piped, captured: substitutions.length > 0 });
		current = [];
		piped = false;
	};
	const flushPipeline = (): void => {
		flushCommand();
		piped = false;
		pipelineId = nextPipelineId++;
	};
	const beginSubstitution = (delimiter: "$(" | "`", resumeQuote: '"' | null): void => {
		// The word fragment before the substitution and any fragment glued after it are dynamic.
		wordDynamic = true;
		flushWord();
		suspendedCommands.push({ current, pipelineId, piped });
		current = [];
		piped = false;
		pipelineId = nextPipelineId++;
		substitutions.push({ delimiter, resumeQuote });
	};
	const finishSubstitution = (): void => {
		flushCommand();
		const suspended = suspendedCommands.pop();
		current = suspended?.current ?? [];
		pipelineId = suspended?.pipelineId ?? 0;
		piped = suspended?.piped ?? false;
		const substitution = substitutions.pop();
		quote = substitution?.resumeQuote ?? null;
		wordDynamic = true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command.charAt(i);
		if (quote !== null) {
			if (ch === quote) {
				quote = null;
			} else if (quote === '"' && ch === "\\" && i + 1 < command.length) {
				word += command.charAt(i + 1);
				i++;
			} else if (quote === '"' && ch === "$" && command[i + 1] === "(") {
				// A substitution inside double quotes still runs a command. Restore
				// the surrounding quote after its matching closing delimiter.
				beginSubstitution("$(", '"');
				quote = null;
				i++;
			} else if (quote === '"' && ch === "`") {
				beginSubstitution("`", '"');
				quote = null;
			} else {
				if (quote === '"' && ch === "$") wordDynamic = true;
				word += ch;
			}
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			if (wordStart === null) wordStart = i;
			wordCanBeFd = false;
			word += command.charAt(i + 1);
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (wordStart === null) wordStart = i;
			wordCanBeFd = false;
			quote = ch;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			beginSubstitution("$(", null);
			i++;
			continue;
		}
		if (ch === "`") {
			const substitution = substitutions[substitutions.length - 1];
			if (substitution?.delimiter === "`") finishSubstitution();
			else beginSubstitution("`", null);
			continue;
		}
		if (ch === ")" && substitutions[substitutions.length - 1]?.delimiter === "$(") {
			finishSubstitution();
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			flushWord();
			continue;
		}
		if (ch === "\n") {
			flushPipeline();
			if (hereDocuments.length > 0) {
				i = skipHereDocuments(command, i + 1, hereDocuments) - 1;
				hereDocuments.length = 0;
			}
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|") {
				flushPipeline();
				i++;
			} else {
				flushCommand();
				piped = true;
				if (command[i + 1] === "&") i++;
			}
			continue;
		}
		if (ch === "&" && command[i + 1] === ">") {
			// `&>` / `&>>` send stdout (and stderr) to the following word.
			flushWord();
			const redirect = parseRedirect(command, i + 1, ">", 1);
			current.push(redirect.token);
			i += 1 + redirect.consumed;
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			flushPipeline();
			i++;
			continue;
		}
		if (ch === "&") background.add(pipelineId);
		if (isOperatorChar(ch)) {
			flushPipeline();
			continue;
		}
		if (ch === "<" || ch === ">") {
			let fdPrefix: number | null = null;
			if (wordCanBeFd && wordStart !== null && wordStart + word.length === i && /^\d+$/.test(word)) {
				fdPrefix = Number(word);
				word = "";
				wordStart = null;
				wordCanBeFd = true;
			} else {
				flushWord();
			}

			const redirect = parseRedirect(command, i, ch, fdPrefix);
			current.push(redirect.token);
			if (redirect.document !== null) expectingHereDocumentDelimiter = redirect.document;
			i += redirect.consumed;
			continue;
		}
		if (wordStart === null) wordStart = i;
		if (ch === "$") wordDynamic = true;
		word += ch;
	}
	const complete = quote === null && substitutions.length === 0;
	flushPipeline();
	return { commands: markLoops(commands, background), complete };
}
