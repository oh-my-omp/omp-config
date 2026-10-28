# Prompts and Context

[Home](../README.md) · English | [简体中文](prompts-and-context.zh-CN.md)

## Prompt Files

Any non-minimal harness ships predefined text across its base template, built-in tool descriptions, and subagent wrappers that easily duplicates or conflicts with local rules, and models ignore instructions that contradict each other. Using Pi/OMP's full customization across every stage of prompt assembly, the system prompt is split across the following files and hooks so that each instruction appears once without internal contradiction, while isolating main-session register/advisor rules and model-specific deltas to their respective scopes:

| File / Extension | Scope | What it provides |
|---|---|---|
| `agent/SYSTEM_TEMPLATE.md` | Main + Subagents | Handlebars base template derived from OMP's `packages/coding-agent/src/prompts/system/system-prompt.md` (plain-text `SYSTEM.md` does not evaluate Handlebars expressions). Renders workflow rules, live tools, skills, and rule files; switches Step 4 between parent `Verify` and subagent `Hand-off` with `{{#if subagent}}`. Does not duplicate per-tool instructions. |
| `agent/PERSONALITY.md` | Main session only (subagents run with `personality: none`) | Fills `{{personality}}` under `# Personality`. Starts with OMP's `personality: default` text (`Evidence-first terse engineer`), followed by `# Writing` rules for research and analysis prose: open with the finding, number, or mechanism; state time, actor, action, scale, and source in one sentence; group multiple items or metrics into one table without restating rows in prose; omit process narration, repeated explanations, stacked disclaimers, and summary recaps. |
| `agent/APPEND_SYSTEM.md` (`APPEND_SYSTEM_LIGHT.md` in light mode, empty) | Main session only | Adds four defaults for the main agent: explicit user instructions override default rules; the final reply must use complete sentences with explicit subjects, identify objects on first mention, attach `path:line` or observed output to conclusions, and avoid analogies; do not skip reads or truncate outputs to save tokens (read design docs and related files in full before editing); consult `discuss:steady` and `discuss:divergent` on consequential decisions, and use `mentor:default` before and after long investigations. |
| [repo-rules](#repo-rules) | Main + Subagents | Loads rules from `.claude/rules`, `.agents/rules`, `.pi/rules`, and `~/.claude/rules`, and handles `paths` frontmatter across all rule sources. |
| [tool-topics](extensions.md#tool-topics) | Main + Subagents (full and light) | Replaces covered tool descriptions with common call instructions plus a `Topics` index; detailed call instructions are read on demand as `tool://<tool>/<topic>`, and `SYSTEM_TEMPLATE.md` requires reading the matching topic before such a call. |
| [system-prompt-replace](#system-prompt-replace) | Main + Subagents (full mode only) | Runs last among path-loaded extensions and makes wording-level edits to the rendered system prompt. |
| [append-system-model](#append-system-model) | Main + Subagents | Appends model-specific prompt blocks from `APPEND_SYSTEM_MODEL.md` when the session's `model` or `provider` matches. |
| [tool-topic-injection](extensions.md#tool-topic-injection) | Main + Subagents | Loads a topic only after a configured tool argument matches, once per rule in the actual uncompacted context; it adds developer context rather than growing the static tool description. |

### system-prompt-replace

Source: `agent/extensions-last/system-prompt-replace/`. Listed as the final entry of `extensions` in `agent/config.yml`.

`before_agent_start` handlers run in load order: native discovery (`~/.omp/agent/extensions/` and `settings.json` modules) → hooks → plugins → `-e` paths → `config.yml` `extensions` → OMP inline extensions. Keeping this extension in `extensions-last/` outside `extensions/` and at the end of `config.yml` `extensions` makes it run after every other path-loaded extension (see [`agent/extensions-last/README.md`](../agent/extensions-last/README.md)).

On every `before_agent_start`, the extension reads the `system-prompt-replace` section of the agent directory's `omomp.*` (project `.omp/` copies are ignored). `config.yml` sets `inlineToolDescriptors: "on"` so tool descriptions are rendered into the system prompt before replacement:

```yaml
system-prompt-replace:
  replacements:
    - literal: "exact original text"
      replace: "replacement text"
    - regex: "JavaScript regex source"
      replace: "replacement text, $1 and $& supported"
      scope: sub   # optional: subagent sessions only
```

Active rules in `agent/omomp.yml` (file lookup and edits are restricted to `read` + hashline `edit` and prohibited in `eval` so the model reads surrounding context before modifying target lines, avoiding blind edits in scripts, configs, and CLI operations that lack compiler or test coverage):

| Target | Change |
|---|---|
| Subagent Todo instruction (`scope: sub`) | Removes `"No TODO tracking, no progress updates."` from the native child prompt so it does not conflict with worker Todo or `fork_task` verification. The task-side sentences (tier choice, explicit `agent`, concurrent writers, the removed "skip build/lint/tests" line) now live in [tool-topics](extensions.md#tool-topics)' `SURFACE-task.md`. |
| User-reported errors | Clarifies that not rerunning checks to doubt a user report still leaves reproducing to find the cause and verifying the fix in place. |
| Compiled-code rule | Fixes the missing verb (`NEVER add avoidable allocation...`). |
| `eval` tool description | Prohibits reading, listing, or searching local files through `eval` (`read`, `glob`, and `grep` handle file inspection). |
| `xd://` device header | States that `xd://<tool>` devices are called only by writing JSON to `xd://<tool>`, not as `xd__<tool>` or `<tool>` functions. |

Whole tool descriptions (`read`, `bash`, `task`) are no longer replaced here: [tool-topics](extensions.md#tool-topics) locates them by tool name rather than by wording, so they survive upstream rewording, and it runs in light mode too.

When a rule's target is missing from the main session's system prompt (for example after an OMP upgrade changes built-in wording), the extension logs and shows one warning per rule per process without blocking the prompt. Subagent prompts are not checked for missing targets because they omit tools such as `task`; `scope: sub` rules are skipped in the main session.

### append-system-model

Source: `agent/extensions/append-system-model/`.

On every `before_agent_start`, reads `~/.omp/agent/extensions/append-system-model/APPEND_SYSTEM_MODEL.md` and matches the current session's model (main and subagents each match their own model). The file is machine-local and not shipped in the repository; edits and `/model` changes apply on the next prompt without restart.

File format: `---`-fenced YAML headers with `model` (matched against model id, e.g. `claude-opus-5-5`) and/or `provider` (matched against provider id, e.g. `^anthropic$`) JavaScript regexes, each followed by its prompt body up to the next `---` line (use `***` for horizontal rules inside a body). Matching blocks are joined in file order and appended to the system prompt. Missing files are ignored; malformed headers log a line-numbered warning once without blocking.

### repo-rules

Source: `agent/extensions/repo-rules/`.

OMP scans `.omp/rules`, `.agent(s)/rules`, `.cursor/rules`, `.windsurf/rules`, `.clinerules`, and `.github/instructions`, but does not scan `.claude/rules` or `.pi/rules`, drops rule files that have neither `alwaysApply` nor `description`, and ignores Claude Code's `paths` frontmatter.

- **Unscoped rules**: scans non-hidden `.md` and `.mdc` files under `.claude/rules`, `.agents/rules`, and `.pi/rules` from `cwd` up to the git root (only `cwd` outside a git repository; closer to `cwd` wins, and within a directory level `.claude` → `.agents` → `.pi`), plus `~/.claude/rules`. On every `before_agent_start`, appends a `<repo-level-rules>` block: rules with no frontmatter, unparseable frontmatter, or `alwaysApply: true` include their full body; other frontmatter rules list name, `description`, and path. Files OMP already placed (alwaysApply, rulebook entry, or TTSR), bodies already present in the incoming system prompt after whitespace normalization, and listings whose `rule://<filename>` is already present are skipped.
- **Path-scoped rules (`paths` frontmatter)**: rules with `paths` (YAML list or comma-separated globs, supporting `{…}` and `[…]`) load only after a matching file is read, written, edited, or read with a single-file `cat`/`head`/`tail` in `bash` (pipes, command chains, and multi-file commands do not trigger it). Applies to the scanned directories above and to rules OMP discovers itself (project/user `.omp` and `.agents`, cursor/windsurf/cline/GitHub rules, and plugin/extension `rules/`). Relative globs resolve against `cwd` for user rules, the parent of the dot directory for project rules, and the plugin/extension root for `rules/`. Native rules with `paths` are removed from `<generic-rules>` and `<domain-rules>` so they only load on file match, while still respecting `ttsr.disabledRules` and `agents` scope. TTSR rules (`condition`, `astCondition`, `question`) and bundled OMP rules stay with OMP. Matched rules are delivered once per context via `tool_result` `additionalContext` (`<path-scoped-rule path="…">`); if compaction, resume, or branch switching removes the marker from the active context, touching a matching file injects it again.
- **Absolute `paths` patterns**: patterns starting with `/` or `~/` match the touched file's absolute path (`~` = home directory), allowing a user-level rule in `~/.claude/rules` to match a directory name anywhere on disk (for example `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**`).

`repo-rules` and conditional topic injection share `_shared/context-delivery.ts`: persisted developer markers in the active-leaf model context decide whether content is already present; a temporary turn-local set only covers the host's pre-persistence batch window.

---

## Context and Compaction

- **Subagent dispatch (`task` vs `fork_task`)**: `task` starts a fresh subagent session with only the text passed in `context` and `task`, keeping intermediate file reads and tool output out of the main session. `fork_task` copies the caller's (or another agent's) conversation transcript as the child's starting history when background context in the current session is too large to restate in `context`.
- **Compaction order and timing**: `agent/config.yml` sets `compaction.methodOrder` to `[remote, soft, snapcompact, handoff, shake]` and `compaction.asyncEnabled: false`. With `asyncEnabled` on, OMP requests a background summary up to 32k tokens before the threshold, holds that summary until the trigger without regenerating it on Anthropic, and still sends the full uncompacted history on every request in between; turning it off runs compaction at the threshold.
- **Post-compaction context recovery**: the `omp-todo-more` plugin records state-changing `todo` calls to `task-log/<agent-id>.md` and injects `ctx list` plus the main session's `ctx show` after main-session compaction.

### fork-task

Source: `agent/extensions/fork-task/`. Registers `fork_task` (`context` + `tasks[]` without `solutionSpace`; requires `async.enabled: true`).

`fork_task` spawns native `task` subagents that use their own agent definition, model, tools, Agent Hub entry, `agent://`/`history://` URLs, and worktree merge-back, seeded with a copy of the caller's conversation (or the agent named in `from`):

- `isolated` defaults to `true` (set `isolated: false` for read-only research agents you want to message later; plan mode forces shared directories; isolated agents cannot be resumed after completion).
- `shake: true` runs `session.shake("elide")` on the copied transcript before the child starts: keeps the newest ~4,000 tokens plus `skill://` and `local://PLAN.md` reads, and replaces older text tool results, fenced code blocks of $\ge 400$ tokens, and top-level lowercase XML blocks with `[shaken ~N tokens — recover: artifact://<id> (region K)]` in the shared artifact store.
- `from: "<agent-id>"` copies the persisted transcript of a running, idle, or parked agent instead of the caller's. Items with `from` must set `agent` explicitly; the child's working directory still derives from the caller's checkout, not an isolated worktree of the `from` agent.
- Appends `<system-notice cause="fork_task">` to the copied transcript, marking the inherited conversation as background and requiring the forked worker to run relevant build/lint/test checks and runtime verification before yielding.
- Staging steps: copies the source session into `$TMPDIR/omp-fork-task/<uuid>/` (zeros inherited cost, pairs unfinished tool calls with aborted results, clears the source Todo list, and appends the fork notice), strips `session_init`, `model_change`, `thinking_level_change`, `service_tier_change`, and shake's `session_exit` while re-parenting their child entries, sets the caller's `cwd` for shared runs or blanks `cwd` for isolated runs, and moves the staged file to `<parent session without .jsonl>/<child id>.jsonl` inside `before_subagent_spawn`.

### model-compaction

Source: `agent/extensions/model-compaction/`.

OMP's `compaction.modelThresholds` only matches exact `provider/id` keys or `*` prefixes. On every main-session `before_agent_start`, this extension reads the machine-local `model-compaction` section of `omomp.*` in the agent directory (project `.omp/` copies are ignored):

```yaml
model-compaction:
  rules:
    - provider: "^anthropic$"
      model: "opus"
      thresholdTokens: 150000
    - model: "[gG][pP][tT]"
      thresholdTokens: 650000
```

Each rule sets `model`, `provider`, or both as JavaScript regexes (use `"model": ".*"` to match all models). For each model in `ctx.models.list()`, the first matching rule writes `"<provider>/<id>": "f<thresholdTokens>"` into the main session's runtime settings layer (`config.yml` on disk is not modified; `/model` switches, retry fallbacks, and subagents reading the main session's settings pick up their model's threshold).

Because a native `f<N>` threshold can switch a model between its standard and extended context window, any rule whose `thresholdTokens` would change a model's current context-window tier is skipped for that model with a warning. Existing runtime entries from other sources are preserved and restored when no rules match or at `session_shutdown`; if another writer modifies the runtime map during the session, the extension warns once and stops updating it.

### ctx

Registered by the [omp-todo-more](plugins-and-modes.md#todo-more) plugin (`src/ctx/inventory.ts`). Reads the current session, subagent registry, transcripts, compaction summaries, `.md`/`.json` sidecars, and task logs without modifying sessions or files:

- **`ctx list [<id>] [all=true]`**: prints a depth-first tree with status, one-line summary, and `done/total` task counts (plus `blocked` when a block reason is set). By default shows the main session and `task` / `task:*` subagents, hiding `mentor`, `discuss`, and `trace` while promoting their visible descendants one level up with a hidden count, and collapses non-root subtrees with more than 8 descendants (`ctx list <id>` expands a subtree; `all=true` includes internal contexts except the advisor).
- **`ctx show <id>`**: prints the handoff summary (latest compaction summary for the current session; adjacent `.md` sidecar or 120-char `.json` sidecar summary for other contexts), the latest `## Goal` recorded in the task log, and a `## Tasks` timeline (`Completed` and `Open`, ordered by the local timestamp of each named task's last accepted operation).
- **Task-log limits**: counts and timelines are replayed from the append-only task log rather than `TodoTracker`'s in-memory state. `init` and `append` log item counts rather than titles, so tasks never touched by name after creation count toward `ctx list` totals without appearing in `ctx show`; once a task title is completed or removed, later `start`/`block`/`unblock` entries do not reopen it; a task literally titled `all tasks` is parsed as a batch selector.

### Task log

Implemented in `omp-todo-more` (`src/ctx/tasklog.ts`). After every state-changing `todo` or `goal` tool call succeeds, appends the local time, tool name, operation, and target to `<local root>/task-log/<agent-id>.md` (a `todo` call that sets a goal also writes `todo-more set: <goal JSON>`). Read-only calls (`todo view`, `goal get`) and failed calls are not logged.

### After-compact injection

Implemented in `omp-todo-more` (`src/ctx/post-compact-hint.ts`). Listens to main-session `session_compact` and non-aborted `auto_compaction_end` events (debounced to once per 5 seconds; subagents are ignored) and steers a `<post-compact-ctx>` message containing `## List` (`ctx list`) and `## Current session` (`ctx show` for the main session).
