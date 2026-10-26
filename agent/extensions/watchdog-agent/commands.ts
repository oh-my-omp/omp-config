import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { tr } from "../_shared/i18n.ts";
import { WATCHDOG_FILE_PATTERN, type WatchdogSpec } from "./spec.ts";

type Toggle = "on" | "off";
export type ToggleScope = "session" | "global";

/** `/watchdog` arguments after parsing. */
export type WatchdogCommand =
	| { readonly kind: "list" }
	| { readonly kind: "toggle"; readonly toggle: Toggle; readonly name: string; readonly scope: ToggleScope }
	| { readonly kind: "add"; readonly requirement: string }
	| { readonly kind: "rm"; readonly name: string }
	/** `rest` is `<name> [change]`; the name may contain spaces, so it is split against the roster. */
	| { readonly kind: "edit"; readonly rest: string }
	| { readonly kind: "invalid"; readonly reason: string };

function watchdogUsage(): string {
	return tr(
		"usage: /watchdog [list] | on|off <name> [session|global] | add <requirement> | edit <name> [change] | rm <name>",
		"用法：/watchdog [list] | on|off <name> [session|global] | add <requirement> | edit <name> [change] | rm <name>",
	);
}

export function parseWatchdogCommand(args: string): WatchdogCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = (tokens[0] ?? "list").toLowerCase();
	const rest = args.trim().slice(sub.length).trim();
	switch (sub) {
		case "list":
			return tokens.length <= 1 ? { kind: "list" } : { kind: "invalid", reason: watchdogUsage() };
		case "add":
			return rest === ""
				? {
						kind: "invalid",
						reason: tr(
							"usage: /watchdog add <requirement> — describe what the watchdog should catch",
							"用法：/watchdog add <requirement> — 描述 watchdog 应捕获的内容",
						),
					}
				: { kind: "add", requirement: rest };
		case "rm":
			return rest === ""
				? { kind: "invalid", reason: tr("usage: /watchdog rm <name>", "用法：/watchdog rm <name>") }
				: { kind: "rm", name: rest };
		case "edit":
			return rest === ""
				? { kind: "invalid", reason: tr("usage: /watchdog edit <name> [change]", "用法：/watchdog edit <name> [change]") }
				: { kind: "edit", rest };
		case "on":
		case "off": {
			const words = tokens.slice(1);
			const last = words.at(-1)?.toLowerCase();
			const scope: ToggleScope = last === "global" ? "global" : "session";
			const nameTokens = last === "global" || last === "session" ? words.slice(0, -1) : words;
			if (nameTokens.length === 0) return { kind: "invalid", reason: watchdogUsage() };
			return { kind: "toggle", toggle: sub, name: nameTokens.join(" "), scope };
		}
		default:
			return { kind: "invalid", reason: watchdogUsage() };
	}
}

/** Project root for new project-level watchdogs: the nearest git root above cwd (not past home), else cwd. */
export function projectRoot(cwd: string): string {
	const home = homedir();
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === home) return resolve(cwd);
		dir = parent;
	}
}

/** Hashline `edit` file headers (`[path#TAG]`) and `MV` destinations; other edit modes carry `path`. */
const EDIT_PATH_PATTERN = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]|^MV\s+"?([^"\n]+?)"?\s*$/gm;

/** Absolute `WATCHDOG-*.md` paths a successful `write` or `edit` call touched. */
export function touchedWatchdogFiles(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const raw: string[] = [];
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") raw.push(input.path);
	if (toolName === "edit" && typeof input.input === "string") {
		for (const m of input.input.matchAll(EDIT_PATH_PATTERN)) {
			const path = m[1] ?? m[2];
			if (path !== undefined) raw.push(path);
		}
	}
	const files = new Set<string>();
	for (const path of raw) {
		const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
		const absolute = resolve(cwd, expanded);
		if (WATCHDOG_FILE_PATTERN.test(basename(absolute))) files.add(absolute);
	}
	return [...files];
}

/** Facts every `/watchdog add|edit` draft depends on. */
export type DraftContext = {
	readonly projectDir: string;
	readonly globalDir: string;
	/** Every discovered watchdog; names in use. */
	readonly existing: readonly WatchdogSpec[];
	/** `provider/id` the chat reviewer resolves to without `model`, or null when nothing resolves. */
	readonly defaultModel: string | null;
};

const WATCHDOG_INTRO =
	"A watchdog is a reviewer that runs alongside a watched agent: every few actions it reads that agent's transcript, judges only the latest work against the file's guidance, and injects a short `<watchdog name=… severity=…>` note into the watched session when the work falls short; otherwise it stays silent. Each watchdog is one file `WATCHDOG-<Label>.md`: a frontmatter block between `---` fences (one `key: value` per line, keys case-insensitive, every value on a single line) followed by a markdown body.";

const EXPECTED_BEHAVIOUR =
	"Expected behaviour, concretely: which session or agent is watched; when a review runs (after how many actions, plus once at the end of each run); what transcript it reads; what it flags and what it deliberately lets pass; one or two example notes it would inject, written as it would write them; how and when a note reaches the watched agent; how many notes per context; which model does the reviewing and that every review costs a model call; and what it cannot see or do.";

const NO_ASK =
	"Do not use the `ask` tool: every setting has a value or a default, so every draft is complete and the user only names what to change.";

const WRITE_STATUS =
	"The `write`/`edit` result then carries this watchdog's status line from the watchdog extension; if it says the file is not recognised or not searched, fix that and write again.";

/** Settings, defaults, native JUDGE rules and names in use, shared by add and edit. */
function settingsReference(draft: DraftContext, exclude: string | null): string {
	const others = draft.existing.filter((spec) => spec.filePath !== exclude);
	const existing =
		others.length === 0
			? "(none)"
			: others.map((spec) => `- ${spec.name} — target ${spec.targets.join(",")} — ${spec.filePath}`).join("\n");
	const defaultModel = draft.defaultModel ?? "nothing resolves now, so reviews would be skipped until a model is pinned";
	return `Settings (frontmatter keys in backticks):
- Location — default project: \`${draft.projectDir}/WATCHDOG-<Label>.md\`, active in sessions started anywhere inside this project. Global: \`${draft.globalDir}/WATCHDOG-<Label>.md\`, active in every project.
- Label and \`name\` — default: a short PascalCase label derived from the requirement; \`name\` defaults to the label, so omit the \`name\` line. \`/watchdog on|off|edit|rm\` address it by name, so it must not clash with another watchdog.
- \`target\` (required) — default \`main\`, the user's top-level session. Also: an agent name such as \`task:mid\` or \`mentor:default\`; \`subagents\` for every subagent; \`*\` for every session; or a comma-separated list.
- Backend — default chat reviewer: an extension-free model session with tools reads the transcript and answers PASS or a severity (\`nit\`, \`concern\`, \`blocker\`) with one note of at most ~80 words citing files, symbols or lines. Alternative native JUDGE (see below): no tools, picks one of the options the file declares and injects that option's prewritten text.
- \`model\` (chat only) — default: omit the line, and the reviewer uses the \`@advisor\` role, then \`advisor\`, then \`@slow\`, then the session model; right now that is ${defaultModel}. Pin with \`provider/model\` or \`provider/model:effort\`; a pinned model that does not resolve skips every review rather than falling back.
- \`tools\` (chat only) — default \`read, grep, glob\`. Allowed: read, grep, glob, ast_grep, web_search, edit, write, bash, eval; edit, write, bash and eval let the reviewer change the workspace, so grant them only on request.
- \`delivery\` — default \`aside\`: while the watched agent runs, the note lands at its next step boundary without interrupting; when it is idle, the note starts a new turn. \`steer\` interrupts the current run; \`followUp\` queues the note after the current run; \`nextTurn\` holds it until the user's next real prompt (a subagent's next turn) and is lost if the session restarts first.
- \`every\` — default 30: watched actions between reviews, counting each tool call and each non-empty text reply; a run that ends with fewer leftover actions is reviewed once more at its end.
- \`scope\` — default \`full\`: every review reads the whole branch. \`window\`: only messages since the previous review reached a verdict, which keeps long sessions cheap but loses older context.
- \`maxPerContext\` — default: omit, unlimited. A number caps notes per context; once capped, no reviews run until the next compaction resets the count.
- \`enabled\` — default: omit, on.
- Body (chat) — the review priorities: what to flag and what to let pass, concrete enough that PASS is the common answer.

JUDGE, only when the user picks option-based judgments: declare \`option.*\` entries instead of \`model\` and \`tools\`. Do not write a \`judge\` model setting in the watchdog file: OMP's JUDGE role chain is the model source, resolved on every review. When that chain fails, the role named by \`fallbackRole\` in the \`judge\` section of omomp.yml answers as a prompted judge whose picks carry no calibrated probabilities. The backend is inactive only when neither resolves a model. The body is required and is the judgment criterion. Optional \`instructions\` line. Declare at least two options as \`option.<label>: <criteria>\` (labels: lowercase letters, digits, \`_\`, \`-\`; an empty criteria means the label says it all). \`option.<label>.prompt: <text>\` is injected verbatim when JUDGE picks that label, and at least one option needs it; options without a prompt are silent passes. \`option.<label>.delivery\` overrides \`delivery\` for one prompted option. The severity shown is the picked label.

Write only \`target\` and the lines whose values differ from their defaults; omitted lines take the defaults above.

Other watchdogs (names in use):
${existing}`;
}

export function buildAddPrompt(requirement: string, draft: DraftContext): string {
	return `<watchdog-add>
The user ran \`/watchdog add\` to add a watchdog. Their requirement, verbatim:
"""
${requirement}
"""

${WATCHDOG_INTRO}

Settle the file with the user in chat rounds. ${NO_ASK}

1. Draft. Fill every setting below: take a value from the requirement when it states or clearly implies one, otherwise keep the default. Reply with, in this order:
   - ${EXPECTED_BEHAVIOUR}
   - A settings table with every setting: value, source (\`requirement\` or \`default\`), and a one-line effect, so the user can change any setting by name.
   - The full file content and its absolute path.
   - One closing line asking which settings to change, or for confirmation to write it.
   Write nothing to disk in this round.
2. Revise. When the user names changes, apply them and reply again in the shape of step 1, marking the changed values. A reply that only changes settings is not a confirmation.
3. Write. Only after the user explicitly confirms the latest draft, create the file with \`write\`. Never overwrite an existing file; if the path exists, choose another label and say so. ${WRITE_STATUS} End with one short paragraph on what happens from now on and how to switch it off (\`/watchdog off <name>\` for this session, \`/watchdog off <name> global\` for good).

${settingsReference(draft, null)}
</watchdog-add>`;
}

export function buildEditPrompt(spec: WatchdogSpec, current: string, requirement: string | null, draft: DraftContext): string {
	const request = requirement === null ? "They named no change yet." : `The change they want, verbatim:\n"""\n${requirement}\n"""`;
	return `<watchdog-edit>
The user ran \`/watchdog edit\` to change the watchdog \`${spec.name}\` at \`${spec.filePath}\`. ${request}

Current file content, verbatim:
"""
${current}
"""

${WATCHDOG_INTRO}

Settle the change with the user in chat rounds. ${NO_ASK}

1. Draft. Start from the current file and apply the requested change; every setting the request does not touch keeps its current value, and a line the file omits keeps its default. With no change named, the draft is the current file as it is. Reply with, in this order:
   - What changes compared with the current behaviour, then the full expected behaviour after the change. ${EXPECTED_BEHAVIOUR}
   - A settings table with every setting: current value, new value, source (\`current\`, \`requirement\`, or \`default\` for a line the file omits), and a one-line effect, so the user can change any setting by name.
   - The full new file content and its absolute path.
   - One closing line asking which settings to change, or for confirmation to write it.
   Write nothing to disk in this round.
2. Revise. When the user names changes, apply them and reply again in the shape of step 1, marking the changed values. A reply that only changes settings is not a confirmation.
3. Write. Only after the user explicitly confirms the latest draft, rewrite the file at its current path. A location or label change writes the new file, then removes the old one, and the new path must not already exist. ${WRITE_STATUS} End with one short paragraph on what happens from now on.

${settingsReference(draft, spec.filePath)}
</watchdog-edit>`;
}
