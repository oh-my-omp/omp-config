// ============================================================================
// watchdog-agent — a per-target reviewer ("watchdog") driven by `WATCHDOG-*.md`
// files, complementing OMP's native advisor.
// Registers /watchdog plus session/branch/tree/compaction, tool_result, input,
// before_agent_start, message_end and agent_end hooks; no tools.
// Reads specs and session branch entries; global toggles/removal
// update spec files and cursors/overrides append session entries. Main and sub.
//
// WHY THIS EXISTS. OMP's native advisor already attaches per subagent
// (`task.agentAdvisor` / agent frontmatter `advisor:`) and discovers
// `WATCHDOG.md` / `WATCHDOG.yml`. What it does NOT do is route the *guidance
// content itself* to a specific target: every advised session receives the
// whole discovered roster. This extension adds exactly that — a `WATCHDOG-*.md`
// file declares WHICH agent it watches (`target: main` or a subagent name).
// Chat reviewers may choose a model; option-based judgments follow OMP's JUDGE
// role. Its body only reaches that target. There is no ExtensionAPI hook into
// the native advisor, so this is a small self-contained reviewer.
//
// FILE FORMAT. `WATCHDOG-<label>.md`, discovered at:
//   - user level:  <agent dir>/extensions/watchdog-agent/WATCHDOG-*.md
//   - repo level:  <dir>/WATCHDOG-*.md and <dir>/.omp/WATCHDOG-*.md, walking
//                  from cwd up to the git root.
// Frontmatter (Claude rule.md style, between `---` fences):
//   target: main            # main | <subagent-name> | * | subagents | CSV list
//   model:  anthropic/claude-sonnet-4-5:medium   # chat reviewer; else @advisor role
//   tools:  [read, grep, glob]                   # optional; chat reviewer's tools
//   instructions: Judge only the latest work.    # optional native question text
//   option.<label>: <criteria>                   # selects native JUDGE backend (>= 2)
//   option.<label>.prompt: <text>                # injected when JUDGE picks <label>; omit = silent
//   option.<label>.delivery: steer               # optional per-option delivery override
//   name:   Architecture                          # optional label; `/watchdog` addresses it by name
//   enabled: true                                 # optional, default true; `/watchdog on|off <name> global` rewrites it
//   delivery: aside                               # aside|steer|nextTurn|followUp
//   maxPerContext: 6                              # optional per-watchdog cap; default unlimited
//   every:  30                                    # run after this many watched actions (default 30)
//   scope:  full                                  # full (whole branch, default) | window (since own last run)
// Body = review priorities for chat; judgment criterion for JUDGE.
// Option-based watchdogs use OMP's JUDGE role chain (`_shared/judge.ts`), then
// the `judge` section's fallback role as a prompted judge; they stay inactive
// only when neither resolves a model. JUDGE has no tools, free-form
// explanation, or fallback to the chat reviewer. Labels are lowercased
// (the frontmatter parser lowercases keys); each value is a single line.
//
// RUNTIME. Every discovered watchdog matching the session identity runs
// independently with its own counter, cursor and cap. The counter
// accumulates the watched agent's actions: each assistant tool call and each
// assistant text reply counts as one. When a watchdog's counter reaches
// `every`, it runs immediately (mid-run), and its finding is injected as soon as
// the review finishes, whatever state the agent is in. When the agent's run
// settles (`agent_end`, non-continuation) with a nonzero counter below
// `every`, the watchdog runs once for the remainder. `scope: full` reviews the
// whole branch; `scope: window` reviews only messages after the cursor, which
// advances only when a review reaches a verdict and is persisted as a session
// entry. The transcript is never truncated. Chat reviewers use a
// tool-capable `createAgentSession`; native JUDGE uses `Judge.judge` and only
// selects one configured option whose prewritten prompt (if any) is injected.
// Findings go through `sendUserMessage`, bounded per watchdog per context when
// `maxPerContext` is set; `nextTurn` findings wait for the user's next prompt
// (a subagent's next turn) and arrive as a custom message. Each compaction
// starts a new context: the cap count resets, nothing else does. On session
// load or branch move the cursor is restored from its entries, the cap count
// from the findings already injected on the branch since the last compaction,
// and the counter from the actions after the cursor.
//
// COMMANDS. `/watchdog [list]` lists every discovered file with its global
// (`enabled`) and session state. `/watchdog on|off <name> [session|global]`
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
// this session's override of it. Any successful `write`/`edit` touching a
// `WATCHDOG-*.md` re-reads the roster at once and appends the file's status
// (recognised and active, NOT recognised with the reason, valid but not
// searched, or removed) to that tool result.
// Subcommands, names and scopes are offered as argument completions.
//
// FAILURE POLICY. Every failure path (no match, unresolved model, judge
// unavailable, reviewer error/timeout, malformed file) degrades to "no note"
// and leaves the cursor where it was. Explicit native judge selection never
// falls back to a chat model. The extension never blocks, mutates, or corrupts
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
