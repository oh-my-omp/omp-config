import { describeFilter } from "../_shared/session-filter.ts";
import { WATCHDOG_FILTER_KEYS, type WatchdogSpec } from "./spec.ts";

export type DraftContext = {
	readonly projectDir: string;
	readonly globalDir: string;
	readonly existing: readonly WatchdogSpec[];
	readonly defaultModel: string | null;
};

const WATCHDOG_INTRO =
	"A watchdog is a reviewer that runs alongside a watched agent: every few actions it reads that agent's transcript, judges only the latest work against the file's guidance, and injects a short note into the watched session when the work falls short; otherwise it stays silent. An observer watchdog (`inject: none`) never injects anything: it carries out a background task, such as recording decisions with a CLI, and its reply only goes to the log. Each watchdog is one file `WATCHDOG-<Label>.md`: a frontmatter block between `---` fences (one `key: value` per line, keys case-insensitive, every value on a single line) followed by a markdown body.";

const EXPECTED_BEHAVIOUR =
	"Expected behaviour, concretely: which sessions or agents are watched, whether cwd patterns restrict them and whether only actions of certain models count; when a review runs (after how many actions, plus once at the end of each run); what transcript it reads; what it flags and what it deliberately lets pass; one or two example notes it would inject, written exactly as the watched agent would receive them in the chosen inject form; how and when a note reaches the watched agent; how many notes per context; which model does the reviewing and that every review costs a model call; and what it cannot see or do.";

const NO_ASK =
	"Do not use the `ask` tool: every setting has a value or a default, so every draft is complete and the user only names what to change.";

const WRITE_STATUS =
	"The `write`/`edit` result then carries this watchdog's status line from the watchdog extension; if it says the file is not recognised or not searched, fix that and write again.";

function settingsReference(draft: DraftContext, exclude: string | null): string {
	const others = draft.existing.filter((spec) => spec.filePath !== exclude);
	const existing =
		others.length === 0
			? "(none)"
			: others.map((spec) => `- ${spec.name} — ${describeFilter(spec.filter, WATCHDOG_FILTER_KEYS, "any")} — ${spec.filePath}`).join("\n");
	const defaultModel = draft.defaultModel ?? "nothing resolves now, so reviews would be skipped until a model is pinned";
	return `Settings (frontmatter keys in backticks):
- Location — default project: \`${draft.projectDir}/WATCHDOG-<Label>.md\`, discovered from sessions anywhere inside this project. Global: \`${draft.globalDir}/WATCHDOG-<Label>.md\`, discovered in every project. Discovery does not bypass the \`target\`, \`cwd\`, \`watchModel\` or \`watchProvider\` restrictions.
- Label and \`name\` — default: a short PascalCase label derived from the requirement; \`name\` defaults to the label, so omit the \`name\` line. \`/watchdog on|off|edit|rm\` address it by name, so it must not clash with another watchdog.
- \`target\` (required) — default \`main\`, the user's top-level session. Also: an agent name such as \`task:mid\` or \`mentor:default\`; \`subagents\` for every subagent; \`*\` for every session; or a comma-separated list of these (any item matches).
- \`cwd\` — default: omit, no directory restriction. When set, a comma-separated list of glob patterns (any one matches), each absolute or starting with \`~/\`, matched against the live session cwd: \`/a/repo\` matches that directory only, \`/a/repo/**\` only its subdirectories, \`/a/repo{,/**}\` both, \`/**/worktrees/*\` any direct child of a \`worktrees\` directory. A relative pattern makes the file invalid. It must match AND \`target\` must match, even for \`target: *\`. To watch only a leader checkout, combine \`target: main\` with \`cwd: /absolute/path/to/leader-checkout\`; a copy discovered in a linked worktree stays inactive there.
- \`watchModel\`, \`watchProvider\` — default: omit, every model. One JavaScript regex each (alternatives with \`|\`, unanchored), tested against the model id and provider of each assistant message of the watched session: only actions of matching messages count toward \`every\`. Empty or invalid regexes make the file invalid. (\`model\` is the reviewer's own model, not this filter.)
- \`inject\` — default \`system\`: the note is an extension message on OMP's harness-notice channel, shown as \`<watchdog name=… severity=…>note</watchdog>\`; the model receives it in the developer role where the provider has one (OpenAI Responses), as a mid-conversation system message on Anthropic models that support it, and otherwise as a tagged user message. \`user\`: the note is sent as a user message with no tag; a chat reviewer then writes it as the human user talking to the agent (first person, colloquial, emotional to fit the severity), while JUDGE sends the option's prewritten text unchanged. With \`delivery: steer\`, OMP wraps a user-form note in its "User interjection" notice. \`none\`: observer — nothing ever reaches the watched session; the body is a task the observer carries out with its \`tools\` on each review, its reply is only logged and ends with a \`STATUS: done|nothing|failed\` line, a run that failed, timed out or was canceled leaves that work for the next run, and each run may take up to 300 s. \`delivery\`, \`maxPerContext\`, \`note\`, \`instructions\` and \`option.*\` are invalid with it. Pick \`none\` whenever the requirement records, syncs or collects something instead of correcting the watched agent.
- Backend — default chat reviewer: an extension-free model session with tools reads the transcript and answers PASS or a severity (\`nit\`, \`concern\`, \`blocker\`) with one note of at most ~80 words citing files, symbols or lines. Alternative JUDGE (see below): no tools, picks one of the options the file declares and injects that option's prewritten text.
- \`model\` (chat and observer) — default: omit the line, and the reviewer uses the \`@advisor\` role, then \`advisor\`, then \`@slow\`, then the session model; right now that is ${defaultModel}. Pin with \`provider/model\` or \`provider/model:effort\`; a pinned model that does not resolve skips every review rather than falling back.
- \`tools\` (chat and observer) — default \`read, grep, glob\`. Allowed: read, grep, glob, ast_grep, web_search, edit, write, bash, eval; edit, write, bash and eval let the reviewer change the workspace, so grant them only on request.
- \`env\` (observer only) — default: omit. \`[NAME=value, …]\` (values without commas): variables exported before every bash command the observer runs, so a CLI that reads the caller's identity from the environment (e.g. \`INTENT_ACTOR=watchdog\`) gets it even when the observer's command leaves it out. Requires \`bash\` in \`tools\` and no \`eval\`.
- \`delivery\` — default \`aside\`: while the watched agent runs, the note lands at its next step boundary without interrupting; when it is idle, the note starts a new turn. \`steer\` interrupts the current run; \`followUp\` queues the note after the current run; \`nextTurn\` holds it until the user's next real prompt (a subagent's next turn) and is lost if the session restarts first.
- \`every\` — default 30: watched actions between reviews, counting each tool call and each non-empty text reply; a run that ends with fewer leftover actions is reviewed once more at its end.
- \`scope\` — default \`full\`: every review reads the whole branch. \`window\`: only messages since the previous review reached a verdict, which keeps long sessions cheap but loses older context.
- \`maxPerContext\` — default: omit, unlimited. A number caps notes per context; once capped, no reviews run until the next compaction resets the count.
- \`enabled\` — default: omit, on.
- Body (chat) — the review priorities: what to flag and what to let pass, concrete enough that PASS is the common answer.
- Body (observer, required) — the task to carry out on the latest work and the commands to use; no reply format is needed.

JUDGE, only when the user picks option-based judgments: declare \`option.*\` entries instead of \`model\` and \`tools\`. Do not write a \`judge\` model setting in the watchdog file: the model source is resolved on every review, outside the file. When the OMP model role \`@watchdog-agent\` is assigned, its chat models answer; otherwise OMP's JUDGE role chain does. Each source walks only its own models, in order, when one fails: an assigned \`@watchdog-agent\` never falls through to the JUDGE chain, and no other role answers after them. Chat models answer as prompted judges whose picks carry no calibrated probabilities. The backend is inactive only when nothing resolves a model. The body is required and is the judgment criterion. Optional \`instructions\` line. Declare at least two options as \`option.<label>: <criteria>\` (labels: lowercase letters, digits, \`_\`, \`-\`; an empty criteria means the label says it all). \`option.<label>.prompt: <text>\` is injected verbatim when JUDGE picks that label, and at least one option needs it; options without a prompt are silent passes. \`option.<label>.delivery\` overrides \`delivery\` for one prompted option. The severity shown is the picked label.

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
