// ============================================================================
// watchdog-agent — a per-target reviewer ("watchdog") driven by `WATCHDOG-*.md`
// files, complementing OMP's native advisor.
// Registers /watchdog plus session lifecycle (start, switch, branch, tree,
// compaction, shutdown), tool_result, input, before_agent_start, message_end
// and agent_end hooks; no tools.
// Reads specs and session branch entries; global toggles/removal
// update spec files; cursors, overrides and user-note index records append
// session entries. Main and sub.
//
// WHY THIS EXISTS. OMP's native advisor already attaches per subagent
// (`task.agentAdvisor` / agent frontmatter `advisor:`) and discovers
// `WATCHDOG.md` / `WATCHDOG.yml`. What it does NOT do is route the *guidance
// content itself* to a specific target: every advised session receives the
// whole discovered roster. This extension adds exactly that — a `WATCHDOG-*.md`
// file declares WHICH sessions it watches (`target`, optional `cwd` globs) and
// optionally which producing models count (`watchModel` / `watchProvider`).
// Discovery alone does not activate it.
// Chat reviewers may choose a model; option-based judgments follow `openJudge`
// (purpose `watchdog-agent`). Its body only reaches that target. There is no ExtensionAPI hook into
// the native advisor, so this is a small self-contained reviewer.
//
// FILE FORMAT. `WATCHDOG-<label>.md`, discovered at:
//   - user level:  <agent dir>/extensions/watchdog-agent/WATCHDOG-*.md
//   - repo level:  <dir>/WATCHDOG-*.md and <dir>/.omp/WATCHDOG-*.md, walking
//                  from the live session cwd up to the git root (including a
//                  linked worktree's .git file). A /move takes effect on the next
//                  prompt or /watchdog command, without reloading the extension.
// Frontmatter (Claude rule.md style, between `---` fences):
//   target: main            # main | <subagent-name or id> | * | subagents | CSV list (any matches)
//   cwd: ~/code/app{,/**}, /**/worktrees/*       # optional CSV of globs (any matches); omitted = unrestricted
//   watchModel: ^gpt-     # optional regex on each assistant message's model id
//   watchProvider: ^openai-codex$                 # optional regex on its provider
//   inject: system                                # system (default) | user
//   model:  anthropic/claude-sonnet-4-5:medium   # optional chat reviewer model
//   tools:  [read, grep, glob]                   # optional; chat reviewer's tools
//   instructions: Judge only the latest work.    # optional native question text
//   option.<label>: <criteria>                   # selects the JUDGE backend (>= 2)
//   option.<label>.prompt: <text>                # injected when JUDGE picks <label>; omit = silent
//   option.<label>.delivery: steer               # optional per-option delivery override
//   name:   Architecture                          # optional label; `/watchdog` addresses it by name
//   enabled: true                                 # optional, default true; `/watchdog on|off <name> global` rewrites it
//   delivery: aside                               # aside|steer|nextTurn|followUp
//   maxPerContext: 6                              # optional per-watchdog cap; default unlimited
//   every:  30                                    # run after this many watched actions (default 30)
//   scope:  full                                  # full (whole branch, default) | window (since own last run)
// `target`, `cwd`, `watchModel` and `watchProvider` follow `_shared/session-filter.ts`:
// items inside a key are alternatives, keys AND (also with `target: *`). A `cwd`
// pattern is a Bun glob, absolute or `~/`-prefixed, matched against the
// normalized live session cwd (`/a/repo` that directory only, `/a/repo/**` its
// subdirectories only); a relative pattern makes the file invalid, and a copied
// rule can be discovered in a linked worktree without matching it. The two
// regexes (unanchored, one per key) test each assistant message's own `model`
// and `provider`; only actions of matching messages count. An empty or invalid
// regex, or an `inject` other than system/user, makes the file invalid.
// Body = review priorities for chat; judgment criterion for JUDGE.
// Chat reviewers with no `model` try `@advisor`, then `advisor`, then `@slow`,
// then the session model. An explicit `model` that does not resolve skips reviews
// rather than falling back.
// Option-based watchdogs use `openJudge` (`_shared/judge.ts`, purpose
// `watchdog-agent`): the `@watchdog-agent` role's chat models when assigned,
// otherwise OMP's JUDGE role chain, then the `judge` section's fallback role as
// a prompted judge; they stay inactive only when no path resolves a model.
// JUDGE has no tools, free-form
// explanation, or fallback to the chat reviewer. Labels are lowercased
// (the frontmatter parser lowercases keys); each value is a single line.
//
// RUNTIME. Every discovered watchdog matching the session identity and cwd
// runs independently with its own counter, cursor and cap. The counter
// accumulates the watched agent's actions: each tool call and each text reply
// of an assistant message whose producer passes the model filters counts as
// one, both live and when restored. When a watchdog's counter reaches
// `every`, it runs immediately (mid-run), and its finding is injected as soon as
// the review finishes, whatever state the agent is in. When the run reaches
// a terminal `agent_end`, or an `agent_end` that hands control back to wait
// on background work (`awaitingAsyncWork`), with a nonzero counter below
// `every`, the watchdog runs once for the remainder. `scope: full` reviews the
// whole branch; `scope: window` reviews only messages after the cursor, which
// advances only when a review reaches a verdict and is persisted as a session
// entry. The transcript is never truncated. Chat reviewers use a
// tool-capable `createAgentSession`; JUDGE uses `Judge.judge` and only
// selects one configured option whose prewritten prompt (if any) is injected.
//
// INJECT. `system`: the finding, tagged `<watchdog name=… severity=…>`, is a
// `watchdog` custom message (`details.filePaths`), OMP's harness-notice channel:
// the LLM receives it as `developer` where the provider has that role, as a
// mid-conversation system message on Anthropic models that support one, and
// otherwise as a tagged user-role message. `user`: the finding is an
// agent-attributed user message without a tag; a chat reviewer is told to write
// it as the human user talking to the agent (colloquial, emotional to fit the
// severity) in the same call, while JUDGE sends the option's prompt verbatim.
// Before a user-form note is sent, a `mouriya.omp.watchdog-agent.user-note`
// entry records its text and files; it is an index, not the delivery: a note
// counts only once an agent-attributed user message with that text is on the
// branch. `aside`, `steer` and `followUp` send at once (a system note starts a
// turn when the session is idle; OMP wraps a user-form steer in its "User
// interjection" notice); `nextTurn` waits for the user's next prompt (a
// subagent's next turn) and joins that turn's first model call: system notes as
// the `before_agent_start` custom message, user notes as a steer queued during
// prompt preparation. Notes are bounded per watchdog per context when
// `maxPerContext` is set. Each compaction starts a new context: the cap count
// resets, nothing else does. On session load or branch move the cursor is
// restored from its entries, the cap count from the file's notes on the branch
// since the last compaction (system custom messages and indexed user messages),
// and the counter from the watched actions after the cursor. Reviews never read
// the watchdog's own notes: custom messages are not transcript messages, and
// indexed user messages are skipped.
// Shutdown and switch end the session the reviews belong to: every in-flight
// review (chat and JUDGE) is aborted and its verdict dropped, and a closed
// session starts nothing new. Branch and tree moves keep in-flight reviews
// running and only drop their late verdicts.
//
// COMMANDS. `/watchdog [list]` lists every discovered file with its global
// (`enabled`), session state, filters and inject form.
// `/watchdog on|off <name> [session|global]`
// switches one watchdog: `session` (default) records a session custom entry that
// shadows the file for this session only and follows the session branch;
// `global` rewrites the file's `enabled` line and drops this session's override.
// `/watchdog add <requirement>` and `/watchdog edit <name> [change]` send the
// model a prompt (attribution `agent`) carrying the request, every setting's
// default, the project and global paths and the other names in use (`edit`
// also the current file): the model drafts a complete file plus the expected
// behaviour (for `edit`, what changes against now), revises it in chat as the
// user names changes (no `ask`), and writes only after explicit confirmation.
// `/watchdog rm <name>` deletes the file after a UI confirmation and drops
// this session's override of it. Any successful filesystem `write`/`edit` touching
// a `WATCHDOG-*.md` re-reads the roster at once and appends the file's status
// (recognised and active, NOT recognised with the reason, valid but not
// searched, or removed) to that tool result. Resource URI writes are excluded.
// Subcommands, names and scopes are offered as argument completions.
//
// FAILURE POLICY. Every failure path (no match, unresolved model, judge
// unavailable, reviewer error/timeout, malformed file) degrades to "no note"
// and leaves the cursor where it was. Option-based judgment never falls back
// to the chat reviewer. The extension never blocks, mutates, or corrupts
// a primary turn.
//
// SCOPE HONESTY. On a subagent the note is best-effort: it lands if the turn
// re-opens before the executor collects the slice result. On the main session a
// note delivered at idle starts a fresh turn (that is what an advisor does).
// ============================================================================
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerWatchdog } from "./runtime.ts";

export default function watchdogAgent(pi: ExtensionAPI): void {
	registerWatchdog(pi);
}
