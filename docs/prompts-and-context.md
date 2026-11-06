# Prompts and Context

[Home](../README.md) · English | [简体中文](prompts-and-context.zh-CN.md)

## Prompt Files

Any non-minimal harness ships predefined text across its base template, built-in tool descriptions, and subagent wrappers that easily duplicates or conflicts with local rules, and models ignore instructions that contradict each other. Using Pi/OMP's full customization across every stage of prompt assembly, the system prompt is split across the following files and hooks so that each instruction appears once without internal contradiction, while isolating main-session register/advisor rules and model-specific deltas to their respective scopes:

| File / Extension | Scope | What it provides |
|---|---|---|
| `agent/SYSTEM_TEMPLATE.md` | Main + Subagents | Handlebars base template derived from OMP's `packages/coding-agent/src/prompts/system/system-prompt.md` (plain-text `SYSTEM.md` does not evaluate Handlebars expressions). Renders workflow rules, live tools, skills, and rule files; switches Step 4 between parent `Verify` and subagent `Hand-off` with `{{#if subagent}}`. Does not duplicate per-tool call instructions. Its one tool-routing block, `# Code by Syntax Shape`, renders each line only when the session has that tool (`{{#has tools "ast_grep"}}`, `{{#has tools "ast_edit"}}`): searching for calls with their arguments, declarations, imports or multi-line constructs goes to `ast_grep` instead of `grep` regex, and the same structural change at several sites goes to `ast_edit` instead of repeated `edit` calls. It sits here because the choice is made before the model reads any device description. |
| `agent/PERSONALITY.md` | Main session only (subagents run with `personality: none`) | Fills `{{personality}}` under `# Personality`. Starts with OMP's `personality: default` text (`Evidence-first terse engineer`), followed by `# Writing` rules for research and analysis prose: open with the finding, number, or mechanism; state time, actor, action, scale, and source in one sentence; group multiple items or metrics into one table without restating rows in prose; omit process narration, repeated explanations, stacked disclaimers, and summary recaps. |
| `agent/APPEND_SYSTEM.md` (`APPEND_SYSTEM_LIGHT.md` in light mode, empty) | Main session only | Adds defaults for the main agent: explicit user instructions override default rules; the final reply must use complete sentences with explicit subjects, identify objects on first mention, attach `path:line` or observed output to conclusions, and avoid analogies; do not skip reads or truncate outputs to save tokens (read design docs and related files in full before editing). |
| [repo-rules](#repo-rules) | Main + Subagents | Loads rules from `.claude/rules`, `.agents/rules`, `.pi/rules`, and `~/.claude/rules`, and handles `paths` frontmatter across all rule sources. |
| [tool-topics](extensions.md#tool-topics) | Main + Subagents (full and light) | Adds surfaces and `Topics` indexes only to OMP's own tool instances; a tool registered by a plugin or extension, including a replacement under the same name such as `omp-ask-more`'s `ask`, keeps its own description and topics. Detailed call instructions for OMP tools are read on demand as `tool://<tool>/<topic>`, and `SYSTEM_TEMPLATE.md` requires reading the matching topic before such a call. |
| [system-prompt-replace](#system-prompt-replace) | Per rule (default every session; full and light mode) | Runs last among path-loaded extensions and makes wording-level edits to the rendered system prompt from `REPLACE-SYSTEM-*.yml` rule files; each rule can be global or limited to sessions, cwd, models, providers, the current model's delegation bias or modes, and `exclude.*` says when not to apply it. |
| [append-system-model](#append-system-model) | Per fragment (default main session) | Appends `APPEND-SYSTEM-*.md` fragments whose frontmatter conditions (session, cwd, model, provider, the current model's delegation bias, full/light mode, and `exclude.*` for when not to inject) match. The repo ships `APPEND-SYSTEM-decision-support.md`: in the full-mode main session, consult `discuss:steady` and `discuss:divergent` on consequential decisions and `mentor:default` before and after long investigations, except while the main model is `claude-opus-5-5`. |
| [argon-long-output](extensions.md#argon-long-output) | Main + Subagents (each matched on its own model) | Appends the repo's `ARGON_PROMPT.md` when the model is `gemini-4-argon` on `google-gemini-cli`: each `write`/`edit` payload and final reply stays within 8,000 characters by writing a skeleton first and filling it one section per `edit`. |
| [tool-topic-injection](extensions.md#tool-topic-injection) | Main + Subagents | Loads a topic only after a configured tool argument matches, once per rule in the actual uncompacted context; it adds developer context rather than growing the static tool description. |

### system-prompt-replace

Source: `agent/extensions-last/system-prompt-replace/`. Listed as the final entry of `extensions` in `agent/config.yml` and in `agent/config-light.yml`. Its header comment is the reference for keys and matching.

`before_agent_start` handlers run in load order: native discovery (`~/.omp/agent/extensions/` and `settings.json` modules) → hooks → plugins → `-e` paths → `config.yml` `extensions` → OMP inline extensions. Keeping this extension in `extensions-last/` outside `extensions/` and at the end of the `extensions` list makes it run after every other path-loaded extension in both modes (see [`agent/extensions-last/README.md`](../agent/extensions-last/README.md)).

On every `before_agent_start` (main session and each subagent, each matched against itself), the extension reads every `REPLACE-SYSTEM-<label>.yml` beside it (repo-shipped and machine-local files share that directory) and in each directory from the session cwd up to the git root, plus that directory's `.omp/`. `config.yml` sets `inlineToolDescriptors: "on"` so tool descriptions are rendered into the system prompt before replacement. A file is one YAML sequence of rules:

```yaml
- literal: "exact original text"
  replace: "replacement text"
- regex: "JavaScript regex source"
  replace: "replacement text, $1 and $& supported"
  target: subagents          # optional conditions, string values
  model: "^claude-opus"
  exclude.target: "mentor:default"
```

A rule without condition keys applies to every session. The condition keys are those of [append-system-model](#append-system-model) (`target`, `cwd`, `model`, `provider`, `mode`, `delegation` and the same keys under `exclude.`). The default target here is every session rather than `main`. In `REPLACE-SYSTEM-*.yml`, `model` and `provider` strings are the regex source exactly as YAML decodes them, including any quote characters within the decoded string; no additional quote-stripping applies. Files apply in discovery order and rules in file order, each to the output of the previous one. An unknown key or bad value skips that file with one warning per reason; the other files still apply.

Active rules in the shipped `REPLACE-SYSTEM-default.yml`, each limited to `mode: full` (file lookup and edits are restricted to `read` + hashline `edit` and prohibited in `eval` so the model reads surrounding context before modifying target lines, avoiding blind edits in scripts, configs, and CLI operations that lack compiler or test coverage):

| Target | Change |
|---|---|
| Subagent Todo instruction (`target: subagents`) | Removes `"No TODO tracking, no progress updates."` from the native child prompt so it does not conflict with worker Todo or `fork_task` verification. The task-side sentences (choosing agents by their definition text, explicit `agent`, concurrent writers, the removed "skip build/lint/tests" line) now live in [tool-topics](extensions.md#tool-topics)' `SURFACE-task.md`. |
| User-reported errors | Clarifies that not rerunning checks to doubt a user report still leaves reproducing to find the cause and verifying the fix in place. |
| Compiled-code rule | Fixes the missing verb (`NEVER add avoidable allocation...`). |
| `eval` tool description | Prohibits reading, listing, or searching local files through `eval` (`read`, `glob`, and `grep` handle file inspection). |
| `eval` description: batch routing | Replaces "For 2+ independent items, use a named `workpool()`" with a split by situation: code that needs each item's model judgment, extraction or rewrite uses `judgeBatch`, or `completion`/`agent` with a schema per item, and points to `tool://eval/workflow`; subagent work whose results are only read stays on `workpool()`. Limited to `delegation: eager`, because OMP renders the original sentence only when the current model's delegation bias is `eager`. The `agent`/`workpool` namespace line also names per-item schema results. |
| `xd://` device header | States that `xd://<tool>` devices are called only by writing JSON to `xd://<tool>`, not as `xd__<tool>` or `<tool>` functions. |

[tool-topics](extensions.md#tool-topics) handles whole descriptions for OMP's own tools (`read`, `bash`, `task`) by tool name rather than wording, so they survive upstream rewording.

When a rule that applies to the main session finds no target (for example after an OMP upgrade changes built-in wording), the extension logs and shows one warning per rule per process without blocking the prompt. Subagent prompts are not checked for missing targets because they omit tools such as `task`; a rule whose conditions do not match the session is skipped without a check.

The updater converts a machine's `system-prompt-replace` section in `omomp.yml` into `REPLACE-SYSTEM-default.yml` and removes the migrated section. App-managed source files are never imported or deleted (see [File Ownership and Sync Rules](operations.md#file-ownership-and-sync-rules)).

### append-system-model

Source: `agent/extensions/append-system-model/`. Its header comment is the reference for keys and matching.

On every `before_agent_start` (main session and each subagent, each matched against itself), the extension reads every `APPEND-SYSTEM-<label>.md` beside it (repo-shipped and machine-local files share that directory) and in each directory from the session cwd up to the git root, plus that directory's `.omp/`. Every fragment that applies is appended; there is no override by name. Matching bodies are joined in discovery order into one extra block after the rest of the system prompt. Files are re-read per prompt, so a new or edited fragment and a `/model` switch take effect on the next prompt without restart; a subagent turn woken by IRC does not run the hook.

A fragment is `---`-fenced frontmatter followed by its prompt body:

```markdown
---
target: main
mode: full
exclude.model: ^claude-opus-5-5$
---
# Mandatory decision support
…
```

Inclusion keys `target` (default `main`; `subagents`, `*` or agent names), `cwd`, `model` and `provider` use the grammar of `turn-judge` and `watchdog-agent`; `mode` lists `full` and/or `light`; `delegation` lists `eager`, `restrained` and/or `gated`. Items in one key are alternatives, keys combine with AND. `exclude.target`, `exclude.cwd`, `exclude.model`, `exclude.provider`, `exclude.mode` and `exclude.delegation` describe when not to inject: the fragment is skipped when every `exclude.*` key it sets matches, and a missing `exclude.target` covers every session. `model` and `provider` are regexes against the session's current model id and provider; `delegation` is tested against the delegation bias OMP resolves for that model, the value that decides which delegation wording OMP renders into the prompt. Without a current model, `model`, `provider` and `delegation` match on neither side. `omp-light` starts omp with `OMOMP_MODE=light`; otherwise the mode is `full`. `enabled: false` turns a file off. An unknown key, empty body or bad value skips that file with one warning per reason; the other files still apply.

For the frontmatter in `APPEND-SYSTEM-*.md`, `WATCHDOG-*.md` and `TURN-JUDGE-*.md`, model/provider regex fields have a surrounding pair of quotes stripped before compilation. This differs from the already-decoded YAML strings in `REPLACE-SYSTEM-*.yml`.

The old single-file format `APPEND_SYSTEM_MODEL.md` is split by the updater into one `APPEND-SYSTEM-model-NN.md` per block with `target: *`, keeping its main-and-subagent scope (see [File Ownership and Sync Rules](operations.md#file-ownership-and-sync-rules)).

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

### fork-task

Source: `agent/extensions/fork-task/`. Registers `fork_task` (`context` + `tasks[]` without `solutionSpace`; requires `async.enabled: true`). Its prerequisites, unsupported fields and source errors are the topic `xd://fork_task/limits`, and templated batch forks from an eval cell are `xd://fork_task/batch`; both are served by the tool's own `docTopics()` (`topics.ts`) and listed at the end of its description.

`fork_task` preserves native Agent Hub, result delivery, `agent://`/`history://`, follow-ups and isolated merge-back. Every child replicates its source's latest model request — the caller's, or that of the live agent named by `from` — so forks of one source share the provider's cached prefix; no item rewrites the system prompt. `agent` decides only the model and a role:

| Item | Model | Assignment message | Default workspace | Purpose |
|---|---|---|---|---|
| `agent` omitted | The source's model, thinking level and request controls | `context` + `task` | Shared (`isolated: false`) | Run another branch of the source while reusing its cached prefix |
| Explicit `agent` | That agent's `task.agentModelOverrides` binding, else its definition `model` | `<role agent="…">` with the definition prompt + `context` + `task` | Isolated (`isolated: true`) | Continue the source's work under another role, often on a cheaper model |

- **Prefix replication**: `replica.ts` captures the actual `Context` at `Agent.streamFn` in every session, after SDK reminder/image/context transformations but before any vendor serializes it. A child reuses that system/tool definition prefix and the source's messages through the fork point; on the source's model it also reuses thinking/service-tier/temperature/max-token controls and the prompt-cache key, while another model keeps its own controls. The shared `context`, role and assignment follow the inherited history as the child's user message. Every child is dispatched as internal `fork:self`; child-local tools execute the calls, and an available `yield` follows the source's tools. A named agent's tool restrictions, spawn policy, per-agent service-tier, compaction and account-pool overrides, and hooks scoped by agent name (such as [`task-completion-judge`](extensions.md#task-completion-judge)) do not apply, since the child runs the source's tool surface as `fork:self`. This uses one provider-neutral path, not an Anthropic/OpenAI payload adapter. The child's conversation/transport identity stays independent. Native `ask` keeps its normal headless restriction.
- **Cache and lifecycle boundary**: identical model and compatible request parameters are necessary; provider cache policy, routing and TTL still decide hits. An `effort` change keeps the replicated prefix. An appended `yield` can invalidate a cache on a provider without append-only tool support. Captured request snapshots live in the main thread of the originating OMP process and support idle/park/revive there; `agent/config.yml` sets `task.workerThreads: 0` so every subagent runs on that thread, because a child OMP places in a subagent worker thread loads its own copy of the extension, finds no snapshot and fails. A session's own snapshot ends when the session is disposed (teardown or idle park), and a fork child's replicated request lives until its parent shuts down. Both hold plain request data (messages, tool schemas), plus at most the `ask` tool a headless child borrows, so a parked session does not stay in memory through them. A child whose snapshot was lost after process restart or parent shutdown fails before provider dispatch; create a fresh fork instead. When compaction changes the child's context, the wrapper stops substituting inherited messages; an ambiguous/missing boundary without compaction is an error, never a guessed splice.
- **Workspace override**: `isolated` overrides the default. Concurrent writers must explicitly choose `isolated: true`; plan mode forces shared read-only children. Isolated children cannot be resumed after completion.
- **Shake is opt-in**: `shake` defaults to false, and no item checks inherited token count or source cost. Explicit `shake: true` runs `session.shake("elide")` on the copy, keeps the newest ~4,000 tokens plus `skill://` and `local://PLAN.md` reads, and replaces older text tool results, fenced code blocks of $\ge 400$ tokens, and top-level lowercase XML blocks with recovery references in the shared artifact store. Forks using shake deliberately do not replay the original message prefix.
- **Rejected items**: `tools` is not a fork field, since the child exposes exactly the source's tools. An unknown agent, one listed in `task.disabledAgents`, or `fork:self` itself fails before dispatch.
- **Execution failures**: the execute boundary catches failures, logs a warning and returns an `isError` tool result after staging cleanup. Only user aborts (`signal.aborted`) are rethrown for host cancellation handling.
- `from: "<agent-id>"` replicates a running or idle agent instead of the caller: its latest request is captured, then its transcript is flushed and copied. A parked agent has no live request to replicate and fails before dispatch; wake it with `write agent://<id>` first. The child's working directory still derives from the caller's checkout, not an isolated worktree of the `from` agent.
- Appends `<system-notice cause="fork_task">` to the copied transcript, marking the inherited conversation as background and requiring the forked worker to run relevant build/lint/test checks and runtime verification before yielding.
- Staging steps: copies the source session into `$TMPDIR/omp-fork-task/<uuid>/` (zeros inherited cost, pairs unfinished tool calls with aborted results, clears the source Todo list, and appends the fork notice), strips `session_init`, `model_change`, `thinking_level_change`, `service_tier_change`, and shake's `session_exit` while re-parenting their child entries, sets the caller's `cwd` for shared runs or blanks `cwd` for isolated runs, and moves the staged file to `<parent session without .jsonl>/<child id>.jsonl` inside `before_subagent_spawn`.

### model-compaction

Source: `agent/extensions/model-compaction/`.

OMP's `compaction.modelThresholds` only matches exact `provider/id` keys or `*` prefixes. On every main-session `before_agent_start`, this extension reads the `model-compaction` section of `omomp.*` from the project (`<cwd>/.omp/`, following the session's current directory) and then from the agent directory (machine-local); the first valid copy is used whole and never merged with the other:

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

Because a native `f<N>` threshold can switch a model between its standard and extended context window, any rule whose `thresholdTokens` would change a model's current context-window tier is skipped for that model with a warning. A project copy replaces the machine rules for that project, so it repeats every machine rule it still wants, and `rules: []` there turns the machine rules off. An unreadable, ambiguous or invalid copy is skipped with a warning and the next location is used: an invalid project copy falls back to the machine copy, and with no valid copy no rules apply. Existing runtime entries from other sources are preserved and restored when no rules match or at `session_shutdown`; if another writer modifies the runtime map during the session, the extension warns once and stops updating it.

### ctx

The [omp-todo-more](plugins-and-modes.md#todo-more) plugin owns `ctx` and `todo`; `agent/config.yml` disables native `todo`. The updater preflights ownership of the local Todo/ctx files it retires before installing plugins, removes the listed Todo files only after OMP confirms plugin readiness, and removes the listed ctx files only when that ready plugin carries `src/ctx`.

Tool documentation: `xd://ctx` and `xd://todo`.
