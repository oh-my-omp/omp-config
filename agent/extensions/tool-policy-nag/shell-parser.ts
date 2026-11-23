type RedirectOperator = "write" | "append" | "hereDoc" | "hereString" | "other";
export type CommandToken =
	| { readonly kind: "word"; readonly text: string; readonly dynamic: boolean }
	| { readonly kind: "readFrom"; readonly fd: number }
	| {
			readonly kind: "otherRedirect";
			readonly operator: RedirectOperator;
			readonly fd: number;
	  };

const isOperatorChar = (ch: string): boolean =>
	ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`";

const isFunctionSubstitutionOpener = (ch: string | undefined): boolean =>
	ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "|";

type HereDocument = { readonly delimiter: string; readonly stripTabs: boolean };

const skipHereDocument = (command: string, start: number, document: HereDocument): number => {
	let cursor = start;
	while (cursor < command.length) {
		const lineEnd = command.indexOf("\n", cursor);
		const end = lineEnd === -1 ? command.length : lineEnd;
		let lineStart = cursor;
		if (document.stripTabs) while (lineStart < end && command.charAt(lineStart) === "\t") lineStart++;
		if (end - lineStart === document.delimiter.length && command.startsWith(document.delimiter, lineStart))
			return lineEnd === -1 ? command.length : lineEnd + 1;
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

export type ShellScan = {
	readonly commands: SimpleCommand[];
	readonly complete: boolean;
};

export function splitSimpleCommands(command: string): SimpleCommand[] {
	return scanShell(command).commands;
}

type Delimiter = "$(" | "`" | "${";

type Scanner = {
	readonly command: string;
	readonly commands: ParsedCommand[];
	readonly background: Set<number>;
	current: CommandToken[];
	pipelineId: number;
	nextPipelineId: number;
	word: string;
	wordStart: number | null;
	wordEnd: number;
	wordVerbatim: boolean;
	wordCanBeFd: boolean;
	wordDynamic: boolean;
	piped: boolean;
	quote: '"' | "'" | null;
	readonly substitutions: { readonly delimiter: Delimiter; readonly resumeQuote: '"' | null }[];
	readonly suspended: { readonly current: CommandToken[]; readonly pipelineId: number; readonly piped: boolean }[];
	readonly hereDocuments: HereDocument[];
	expectingDelimiter: HereDocument | null;
};

function resetWord(s: Scanner): void {
	s.word = "";
	s.wordStart = null;
	s.wordEnd = 0;
	s.wordVerbatim = true;
	s.wordCanBeFd = true;
	s.wordDynamic = false;
}

function appendWord(s: Scanner, text: string): void {
	if (s.wordVerbatim) {
		if (s.wordStart !== null && s.wordEnd > s.wordStart) s.word = s.command.slice(s.wordStart, s.wordEnd);
		s.wordVerbatim = false;
	}
	s.word += text;
}

function flushWord(s: Scanner): void {
	const text = s.wordVerbatim ? (s.wordStart === null ? "" : s.command.slice(s.wordStart, s.wordEnd)) : s.word;
	if (text.length > 0) {
		s.current.push({ kind: "word", text, dynamic: s.wordDynamic });
		if (s.expectingDelimiter !== null) {
			s.hereDocuments.push({ delimiter: text, stripTabs: s.expectingDelimiter.stripTabs });
			s.expectingDelimiter = null;
		}
	}
	resetWord(s);
}

function flushCommand(s: Scanner): void {
	flushWord(s);
	if (s.current.length === 0) return;
	s.commands.push({ tokens: s.current, pipelineId: s.pipelineId, piped: s.piped, captured: s.substitutions.length > 0 });
	s.current = [];
	s.piped = false;
}

function flushPipeline(s: Scanner): void {
	flushCommand(s);
	s.piped = false;
	s.pipelineId = s.nextPipelineId++;
}

function beginSubstitution(s: Scanner, delimiter: Delimiter, resumeQuote: '"' | null): void {
	s.wordDynamic = true;
	flushWord(s);
	s.suspended.push({ current: s.current, pipelineId: s.pipelineId, piped: s.piped });
	s.current = [];
	s.piped = false;
	s.pipelineId = s.nextPipelineId++;
	s.substitutions.push({ delimiter, resumeQuote });
}

function finishSubstitution(s: Scanner): void {
	flushCommand(s);
	const suspended = s.suspended.pop();
	s.current = suspended?.current ?? [];
	s.pipelineId = suspended?.pipelineId ?? 0;
	s.piped = suspended?.piped ?? false;
	s.quote = s.substitutions.pop()?.resumeQuote ?? null;
	s.wordDynamic = true;
}

const openSubstitution = (s: Scanner): Delimiter | undefined => s.substitutions[s.substitutions.length - 1]?.delimiter;

function beginBraceSubstitution(s: Scanner, i: number, resumeQuote: '"' | null): number {
	beginSubstitution(s, "${", resumeQuote);
	return s.command[i + 2] === "|" ? i + 2 : i + 1;
}

function scanQuoted(s: Scanner, i: number): number {
	const { command } = s;
	const ch = command.charAt(i);
	if (ch === s.quote) {
		s.quote = null;
		return i;
	}
	if (s.quote === '"') {
		if (ch === "\\" && i + 1 < command.length) {
			appendWord(s, command.charAt(i + 1));
			return i + 1;
		}
		if (ch === "$" && command[i + 1] === "(") {
			beginSubstitution(s, "$(", '"');
			s.quote = null;
			return i + 1;
		}
		if (ch === "`") {
			beginSubstitution(s, "`", '"');
			s.quote = null;
			return i;
		}
		if (ch === "$" && command[i + 1] === "{" && isFunctionSubstitutionOpener(command[i + 2])) {
			s.quote = null;
			return beginBraceSubstitution(s, i, '"');
		}
		if (ch === "$") s.wordDynamic = true;
	}
	appendWord(s, ch);
	return i;
}

function scanRedirect(s: Scanner, i: number, ch: "<" | ">"): number {
	const pending = s.wordStart !== null && s.wordVerbatim && s.wordEnd === i ? s.command.slice(s.wordStart, s.wordEnd) : "";
	const fdPrefix = s.wordCanBeFd && /^\d+$/.test(pending) ? Number(pending) : null;
	if (fdPrefix === null) flushWord(s);
	else resetWord(s);
	const redirect = parseRedirect(s.command, i, ch, fdPrefix);
	s.current.push(redirect.token);
	if (redirect.document !== null) s.expectingDelimiter = redirect.document;
	return i + redirect.consumed;
}

function scanOperator(s: Scanner, i: number, ch: string): number {
	const next = s.command[i + 1];
	if (ch === "\n") {
		flushPipeline(s);
		if (s.hereDocuments.length === 0) return i;
		const end = skipHereDocuments(s.command, i + 1, s.hereDocuments) - 1;
		s.hereDocuments.length = 0;
		return end;
	}
	if (ch === "|" && next === "|") {
		flushPipeline(s);
		return i + 1;
	}
	if (ch === "|") {
		flushCommand(s);
		s.piped = true;
		return next === "&" ? i + 1 : i;
	}
	if (ch === "&" && next === ">") {
		flushWord(s);
		const redirect = parseRedirect(s.command, i + 1, ">", 1);
		s.current.push(redirect.token);
		return i + 1 + redirect.consumed;
	}
	if (ch === "&" && next === "&") {
		flushPipeline(s);
		return i + 1;
	}
	if (ch === "&") s.background.add(s.pipelineId);
	flushPipeline(s);
	return i;
}

function scanUnquoted(s: Scanner, i: number): number {
	const { command } = s;
	const ch = command.charAt(i);
	if (ch === "\\" && i + 1 < command.length) {
		if (s.wordStart === null) s.wordStart = i;
		s.wordCanBeFd = false;
		appendWord(s, command.charAt(i + 1));
		return i + 1;
	}
	if (ch === '"' || ch === "'") {
		if (s.wordStart === null) s.wordStart = i;
		appendWord(s, "");
		s.wordCanBeFd = false;
		s.quote = ch;
		return i;
	}
	if (ch === "$" && command[i + 1] === "(") {
		beginSubstitution(s, "$(", null);
		return i + 1;
	}
	if (ch === "$" && command[i + 1] === "{" && isFunctionSubstitutionOpener(command[i + 2])) return beginBraceSubstitution(s, i, null);
	if (ch === "`") {
		if (openSubstitution(s) === "`") finishSubstitution(s);
		else beginSubstitution(s, "`", null);
		return i;
	}
	if (
		(ch === ")" && openSubstitution(s) === "$(") ||
		(ch === "}" && s.wordStart === null && s.current.length === 0 && openSubstitution(s) === "${")
	) {
		finishSubstitution(s);
		return i;
	}
	if (ch === " " || ch === "\t" || ch === "\r") {
		flushWord(s);
		return i;
	}
	if (isOperatorChar(ch)) return scanOperator(s, i, ch);
	if (ch === "<" || ch === ">") return scanRedirect(s, i, ch);
	if (ch === "#" && s.wordStart === null && !s.wordDynamic) {
		const newline = command.indexOf("\n", i + 1);
		return (newline === -1 ? command.length : newline) - 1;
	}
	if (s.wordStart === null) s.wordStart = i;
	if (ch === "$") s.wordDynamic = true;
	if (s.wordVerbatim) s.wordEnd = i + 1;
	else s.word += ch;
	return i;
}

export function scanShell(command: string): ShellScan {
	const s: Scanner = {
		command,
		commands: [],
		background: new Set(),
		current: [],
		pipelineId: 0,
		nextPipelineId: 1,
		word: "",
		wordStart: null,
		wordEnd: 0,
		wordVerbatim: true,
		wordCanBeFd: true,
		wordDynamic: false,
		piped: false,
		quote: null,
		substitutions: [],
		suspended: [],
		hereDocuments: [],
		expectingDelimiter: null,
	};
	for (let i = 0; i < command.length; i++) i = s.quote === null ? scanUnquoted(s, i) : scanQuoted(s, i);
	const complete = s.quote === null && s.substitutions.length === 0;
	flushPipeline(s);
	return { commands: markLoops(s.commands, s.background), complete };
}
