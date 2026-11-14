# Prompts and Context

[Home](../README.md) · English | [简体中文](prompts-and-context.zh-CN.md)

## Prompt Files

Any non-minimal harness ships predefined text across its base template, built-in tool descriptions, and subagent wrappers that easily duplicates or conflicts with local rules, and models ignore instructions that contradict each other. Prompt text is split across the following files and extensions so that each instruction appears once without internal contradiction, while isolating main-session register/advisor rules and model-specific deltas to their respective scopes. The files shape the base prompt OMP builds; the extensions leave that prompt as OMP built it and add their customization as delta messages:

| File / Extension | Scope | What it provides |
|---|---|---|
| `agent/SYSTEM_TEMPLATE.md` | Main + Subagents | Handlebars base template derived from OMP's `packages/coding-agent/src/prompts/system/system-prompt.md` (plain-text `SYSTEM.md` does not evaluate Handlebars expressions). Renders workflow rules, live tools, skills, and rule files; switches Step 4 between parent `Verify` and subagent `Hand-off` with `{{#if subagent}}`. Does not duplicate per-tool call instructions. Its one tool-routing block, `# Code by Syntax Shape`, renders each line only when the session has that tool (`{{#has tools "ast_grep"}}`, `{{#has tools "ast_edit"}}`): searching for calls with their arguments, declarations, imports or multi-line constructs goes to `ast_grep` instead of `grep` regex, and the same structural change at several sites goes to `ast_edit` instead of repeated `edit` calls. It sits here because the choice is made before the model reads any device description. |
| `agent/PERSONALITY.md` | Main session only (subagents run with `personality: none`) | Fills `{{personality}}` under `# Personality`. Starts with OMP's `personality: default` text (`Evidence-first terse engineer`), followed by `# Writing` rules for research and analysis prose: open with the finding, number, or mechanism; state time, actor, action, scale, and source in one sentence; group multiple items or metrics into one table without restating rows in prose; omit process narration, repeated explanations, stacked disclaimers, and summary recaps. |
| `agent/APPEND_SYSTEM.md` (`APPEND_SYSTEM_LIGHT.md` in light mode, empty) | Main session only | Adds defaults for the main agent: explicit user instructions override default rules; the final reply must use complete sentences with explicit subjects, identify objects on first mention, attach `path:line` or observed output to conclusions, and avoid analogies; do not skip reads or truncate outputs to save tokens (read design docs and related files in full before editing). |
| [repo-rules](#repo-rules) | Main + Subagents (subagents without AGENTS.md) | Delivers the working directory's `AGENTS.md` / `CLAUDE.md` under repository-relative paths in place of OMP's native context-file injection, loads rules from `.claude/rules`, `.agents/rules`, `.pi/rules`, and `~/.claude/rules`, all as one delta message, and handles `paths` frontmatter across all rule sources. |
| [tool-topics](extensions.md#tool-topics) | Main + Subagents (full and light) | Adds surfaces and `Topics` indexes only to OMP's own tool instances; a tool registered by a plugin or extension, including a replacement under the same name such as `omp-ask-more`'s `ask`, keeps its own description and topics. Detailed call instructions for OMP tools are read on demand as `tool://<tool>/<topic>`, and `SYSTEM_TEMPLATE.md` requires reading the matching topic before such a call. |
| [system-prompt-replace](#system-prompt-replace) | Per rule (default every session; full and light mode) | Delivers wording-level edits of the rendered system prompt from `REPLACE-SYSTEM-*.yml` rule files as one delta message that quotes each matched passage and its replacement; each rule can be global or limited to sessions, cwd, models, providers, the current model's delegation bias or modes, and `exclude.*` says when not to apply it. |
| [append-system-model](#append-system-model) | Per fragment (default main session) | Delivers `APPEND-SYSTEM-*.md` fragments whose frontmatter conditions (session, cwd, model, provider, the current model's delegation bias, full/light mode, and `exclude.*` for when not to inject) match, as one delta message. The repo ships `APPEND-SYSTEM-decision-support.md`: in the full-mode main session, consult `discuss:steady` and `discuss:divergent` on consequential decisions and `mentor:default` before and after long investigations, except while the main model is `claude-opus-5-5`. |
| [argon-long-output](extensions.md#argon-long-output) | Main + Subagents (each matched on its own model) | Delivers the repo's `ARGON_PROMPT.md` as one delta message when the model is `gemini-4-argon` on `google-gemini-cli`: each `write`/`edit` payload and final reply stays within 8,000 characters by writing a skeleton first and filling it one section per `edit`. |
| [tool-topics](extensions.md#tool-topics) | Main + Subagents | `TOPIC` frontmatter `inject:` rules deliver a topic once per actual context after a matching read-only tool call, adding developer context rather than growing the static tool description. |

No extension rewrites the system prompt or tool definitions OMP sends. Each extension's customization is one delta stream of `_shared/context-delta.ts`: a hidden `<system-reminder source="omp-config/<extension>">` message with `attribution: "agent"`, delivered as the `before_agent_start` result `message` when a prompt starts or as the `tool_result` `additionalContext` after a tool batch. Before each delivery the active-leaf context decides (the delta stream reads the same projection `buildSessionContext` defines, walking the leaf's parent chain with the projection's boundaries rather than materializing it): nothing is sent while the source's latest delta there carries the same text; changed text is appended as a new delta stating that it supersedes the earlier ones; a customization that stopped applying is answered by a delta stating that the earlier ones no longer apply. Delivered messages are never edited, and one that compaction removes is sent again at the next delivery point. The system prompt and the earlier conversation therefore stay byte-identical from one request to the next, and a request between an input change and the next delivery point keeps the previous delta. A hook's system-prompt rewrite cannot give that: OMP drops it after every prompt, and agent-initiated turns (IRC wakes, async results, `triggerTurn` messages) skip `before_agent_start`, so consecutive requests alternate with and without the customization and rewrite the prompt cache.

### system-prompt-replace

Source: `agent/extensions-last/system-prompt-replace/`. Listed as the final entry of `extensions` in `agent/config.yml` and in `agent/config-light.yml`. Its header comment is the reference for keys and matching.

`before_agent_start` handlers run in load order: native discovery (`~/.omp/agent/extensions/` and `settings.json` modules) → hooks → plugins → `-e` paths → `config.yml` `extensions` → OMP inline extensions. Keeping this extension in `extensions-last/` outside `extensions/` and at the end of the `extensions` list makes it run after every other path-loaded extension in both modes, so its delta follows theirs among a prompt's messages (see [`agent/extensions-last/README.md`](../agent/extensions-last/README.md)).

At every prompt and after every tool call (main session and each subagent, each matched against itself), the extension reads every `REPLACE-SYSTEM-<label>.yml` beside it (repo-shipped and machine-local files share that directory) and in each directory from the session cwd up to the git root or the home directory, whichever comes first (only `cwd` when neither bounds the walk), plus that directory's `.omp/`. `config.yml` sets `inlineToolDescriptors: "on"` so tool descriptions are rendered into the system prompt, where rules can match them. A file is one YAML sequence of rules:

```yaml
- literal: "exact original text"
  replace: "replacement text"
- regex: "JavaScript regex source"
  replace: "replacement text, $1 and $& supported"
  target: subagents          # optional conditions, string values
  model: "^claude-opus"
  exclude.target: "mentor:default"
```

A rule without condition keys applies to every session. The condition keys are those of [append-system-model](#append-system-model) (`target`, `cwd`, `model`, `provider`, `mode`, `delegation` and the same keys under `exclude.`). The default target here is every session rather than `main`. In `REPLACE-SYSTEM-*.yml`, `model` and `provider` strings are the regex source exactly as YAML decodes them, including any quote characters within the decoded string; no additional quote-stripping applies. Files apply in discovery order and rules in file order, each matched against the text the previous one left. An unknown key or bad value skips that file with one warning per reason; the other files still apply.

The system prompt is never changed. Rules match the prompt the extension is handed (`event.systemPrompt` at a prompt, `ctx.getSystemPrompt()` after a tool call), and each distinct passage a rule matches becomes one entry of the `<system-reminder source="omp-config/system-prompt-replace">` delta described under [Prompt Files](#prompt-files): the original passage and the text it reads as instead, or, when `replace` is empty, a statement that the passage does not apply in this session. Entries follow rule order; a rule that matches nothing adds none. Edits to rule files and `/model` switches take effect from the next prompt or tool call.

Active rules in the shipped `REPLACE-SYSTEM-default.yml`, each limited to `mode: full` (file lookup and edits are restricted to `read` + hashline `edit` and prohibited in `eval` so the model reads surrounding context before modifying target lines, avoiding blind edits in scripts, configs, and CLI operations that lack compiler or test coverage):

| Target | Change |
|---|---|
| Subagent Todo instruction (`target: subagents`) | States that `"No TODO tracking, no progress updates."` in the native child prompt does not apply, so it does not conflict with the verification rules workers follow. The task-side sentences (choosing agents by their definition text, explicit `agent`, concurrent writers, the removed "skip build/lint/tests" line) now live in [tool-topics](extensions.md#tool-topics)' `SURFACE-task.md`. |
| User-reported errors | Clarifies that not rerunning checks to doubt a user report still leaves reproducing to find the cause and verifying the fix in place. |
| Compiled-code rule | Fixes the missing verb (`NEVER add avoidable allocation...`). |
| `eval` tool description | Prohibits reading, listing, or searching local files through `eval` (`read`, `glob`, and `grep` handle file inspection). |
| `eval` description: batch routing | Replaces "For 2+ independent items, use a named `workpool()`" with a split by situation: code that needs each item's model judgment, extraction or rewrite uses `judgeBatch`, or `completion`/`agent` with a schema per item, and points to `tool://eval/workflow`; subagent work whose results are only read stays on `workpool()`. Limited to `delegation: eager`, because OMP renders the original sentence only when the current model's delegation bias is `eager`. The `agent`/`workpool` namespace line also names per-item schema results. |
| `xd://` device header | States that `xd://<tool>` devices are called only by writing JSON to `xd://<tool>`, not as `xd__<tool>` or `<tool>` functions. |

[tool-topics](extensions.md#tool-topics) handles whole descriptions for OMP's own tools (`read`, `bash`, `task`) by tool name rather than wording, so they survive upstream rewording.

When a rule that applies to the main session finds no target (for example after an OMP upgrade changes built-in wording), the delta has no entry for it, and the extension logs and shows one warning per rule per process without blocking the prompt. Subagent prompts are not checked for missing targets because they omit tools such as `task`; a rule whose conditions do not match the session is skipped without a check.

The updater converts a machine's `system-prompt-replace` section in `omomp.yml` into `REPLACE-SYSTEM-default.yml` and removes the migrated section. App-managed source files are never imported or deleted (see [File Ownership and Sync Rules](operations.md#file-ownership-and-sync-rules)).

### append-system-model

Source: `agent/extensions/append-system-model/`. Its header comment is the reference for keys and matching.

At every prompt and after every tool call (main session and each subagent, each matched against itself), the extension reads every `APPEND-SYSTEM-<label>.md` beside it (repo-shipped and machine-local files share that directory) and in each directory from the session cwd up to the git root or the home directory, whichever comes first (only `cwd` when neither bounds the walk), plus that directory's `.omp/`. Every fragment that applies is used; there is no override by name. Matching bodies are joined in discovery order into one [delta message](#prompt-files) with source `omp-config/append-system-model`; the system prompt is left unchanged. Files are re-read each time, so a new or edited fragment and a `/model` switch take effect at the next prompt or tool batch without restart, as a delta superseding the earlier one; a subagent turn woken by IRC keeps the delta already in its conversation.

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

Inclusion keys `target` (default `main`; `subagents`, `*` or agent names), `cwd`, `model` and `provider` use the grammar of `turn-judge` and `watchdog-agent`; `mode` lists `full` and/or `light`; `delegation` lists `eager`, `balanced`, `restrained` and/or `gated`. Items in one key are alternatives, keys combine with AND. `exclude.target`, `exclude.cwd`, `exclude.model`, `exclude.provider`, `exclude.mode` and `exclude.delegation` describe when not to inject: the fragment is skipped when every `exclude.*` key it sets matches, and a missing `exclude.target` covers every session. `model` and `provider` are regexes against the session's current model id and provider; `delegation` is tested against the delegation bias OMP resolves for that model (`resolveDelegationBias`), the value from which OMP renders the delegation wording of tool descriptions such as `eval`, `glob`, `grep` and `ast_grep`. OMP passes the system-prompt template a separate `delegationTier` for its delegation section, which differs from the bias when `task.eager` is on: in the main session, with `task.eager` other than `default` and a bias other than `gated`, the tier is `eager`; otherwise it equals the bias. With this repo's `task.eager: preferred`, a `delegation: eager` fragment is therefore not injected into a main session whose model resolves to `balanced` or `restrained`, although its system prompt carries eager-tier wording. Without a current model, `model`, `provider` and `delegation` match on neither side. `omp-light` starts omp with `OMOMP_MODE=light`; otherwise the mode is `full`. `enabled: false` turns a file off. An unknown key, empty body or bad value skips that file with one warning per reason; the other files still apply.

For the frontmatter in `APPEND-SYSTEM-*.md`, `WATCHDOG-*.md` and `TURN-JUDGE-*.md`, model/provider regex fields have a surrounding pair of quotes stripped before compilation. This differs from the already-decoded YAML strings in `REPLACE-SYSTEM-*.yml`.

The old single-file format `APPEND_SYSTEM_MODEL.md` is split by the updater into one `APPEND-SYSTEM-model-NN.md` per block with `target: *`, keeping its main-and-subagent scope (see [File Ownership and Sync Rules](operations.md#file-ownership-and-sync-rules)).

### repo-rules

Source: `agent/extensions/repo-rules/`.

OMP's `agents-md` and `claude-md` providers render the standalone `AGENTS.md` / `CLAUDE.md` files into the system prompt's `<repo-rules>` block under their absolute paths, so moving the session into a worktree of the same repository changed the system prompt and invalidated the prompt cache from that block on. OMP scans `.omp/rules`, `.agent(s)/rules`, `.cursor/rules`, `.windsurf/rules`, `.clinerules`, and `.github/instructions`, but does not scan `.claude/rules` or `.pi/rules`, drops rule files that have neither `alwaysApply` nor `description`, and ignores Claude Code's `paths` frontmatter.

- **Context files**: `agent/config.yml` lists `agents-md` and `claude-md` in `disabledProviders`; the extension delivers the same files in the `<system-reminder source="omp-config/repo-rules">` delta. It walks from `cwd` to the git root (past it up to, but not including, the home directory when the repository lies under home), takes one file per directory (`AGENTS.md` before `CLAUDE.md`), skips a directory whose slot a context file OMP still loads takes (`.omp/AGENTS.md`, `.claude/CLAUDE.md`, `.agents/AGENTS.md`, …), expands `@path` imports, and orders them farthest from `cwd` first. Each file is labelled with its path relative to the git root, `~/…` for files under the home directory and the absolute path otherwise, so the main checkout and its worktrees produce byte-identical deltas and the system prompt no longer depends on the checkout path. Subagents skip `AGENTS.md` like OMP's task subagents, so a directory holding both gives them `CLAUDE.md`. Files are re-read at every delivery point, so an edit reaches the next delta.
- **Unscoped rules**: scans non-hidden `.md` and `.mdc` files under `.claude/rules`, `.agents/rules`, and `.pi/rules` from `cwd` up to the git root (only `cwd` outside a git repository; closer to `cwd` wins, and within a directory level `.claude` → `.agents` → `.pi`), plus `~/.claude/rules`. Rules with no frontmatter, unparseable frontmatter, or `alwaysApply: true` contribute their full body to the `<system-reminder source="omp-config/repo-rules">` delta described under [Prompt Files](#prompt-files); other frontmatter rules are listed there by name, `description`, and path. Files OMP already placed (alwaysApply, rulebook entry, or TTSR), bodies already present in OMP's system prompt after whitespace normalization, and listings whose `rule://<filename>` is already present are skipped.
- **Path-scoped rules (`paths` frontmatter)**: rules with `paths` (YAML list or comma-separated globs, supporting `{…}` and `[…]`) load only after a matching file is read, written, edited, or read with a single-file `cat`/`head`/`tail` in `bash` (pipes, command chains, and multi-file commands do not trigger it). Applies to the scanned directories above and to rules OMP discovers itself (project/user `.omp` and `.agents`, cursor/windsurf/cline/GitHub rules, and plugin/extension `rules/`). Relative globs resolve against `cwd` for user rules, the parent of the dot directory for project rules, and the plugin/extension root for `rules/`. Native rules with `paths` stay where OMP puts them in `<generic-rules>` or `<domain-rules>`; the delta quotes each one found there with its `paths` and says it applies only while working with matching files. They still respect `ttsr.disabledRules` and `agents` scope. TTSR rules (`condition`, `astCondition`, `question`) and bundled OMP rules stay with OMP. Matched rules are delivered once per context via `tool_result` `additionalContext` (`<path-scoped-rule path="…">`), after the delta when both are due; if compaction, resume, or branch switching removes the marker from the active context, touching a matching file injects it again.
- **Absolute `paths` patterns**: patterns starting with `~/`, and absolute patterns (`/…`; on Windows also `C:/…` or `C:\…`), match the touched file's absolute path (`~` = home directory), allowing a user-level rule in `~/.claude/rules` to match a directory name anywhere on disk (for example `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**`). On Windows a pattern starting with `/` has no drive letter and matches no file; write `C:/**/…` there.

`repo-rules` and conditional topic injection share `_shared/context-delivery.ts`: persisted developer markers in the active-leaf model context decide whether content is already present; a temporary turn-local set only covers the host's pre-persistence batch window.

---

## Context and Compaction

- **Subagent dispatch (`task` vs `fork_task`)**: `task` starts a fresh subagent session with only the text passed in `context` and `task`, keeping intermediate file reads and tool output out of the main session. `fork_task` is provided by the [omp-subagent-more](https://github.com/oh-my-omp/omp-subagent-more#readme) plugin.
- **Compaction order and timing**: `agent/config.yml` sets `compaction.methodOrder` to `[remote, soft, snapcompact, handoff, shake]` and `compaction.asyncEnabled: false`. With `asyncEnabled` on, OMP requests a background summary up to 32k tokens before the threshold, holds that summary until the trigger without regenerating it on Anthropic, and still sends the full uncompacted history on every request in between; turning it off runs compaction at the threshold.

### fork-task

`fork_task` is provided by the `fork-task` extension entry of the [omp-subagent-more](https://github.com/oh-my-omp/omp-subagent-more#readme) plugin.

### model-compaction

Source: `agent/extensions/model-compaction/`.

OMP's `compaction.modelThresholds` only matches exact `provider/id` keys or `*` prefixes. On every main-session `before_agent_start`, this extension re-discovers and re-reads `COMPACTION-<label>.md` files from the extension's own directory (machine rules) plus every directory between the session's cwd and the git root or the home directory, whichever comes first (only `cwd` when neither bounds the walk), and each one's `.omp/` (project rules). One file is one rule, `---`-fenced frontmatter with `provider` and/or `model` as JavaScript regexes (unanchored; `"model": ".*"` matches every model) and `thresholdTokens` as a positive integer:

```markdown
---
provider: ^anthropic$
model: opus
thresholdTokens: 150000
---
```

For each model in `ctx.models.list()`, the first matching valid rule — every project rule before every machine rule of the extension's directory, whatever the file names, and inside each layer the discovery order (cwd upward, filename order in each directory) — writes `"<provider>/<id>": "f<thresholdTokens>"` into the main session's runtime settings layer (`config.yml` on disk is not modified; `/model` switches, retry fallbacks, and subagents reading the main session's settings pick up their model's threshold). The repository ships no rule files.

Because a native `f<N>` threshold can switch a model between its standard and extended context window, a rule whose `thresholdTokens` would change a model's current context-window tier is refused for that model with a warning. Unknown keys and a non-empty body are errors, so a misspelled key cannot widen a rule; an unreadable or invalid file is skipped with a warning and the other files still apply, and with no valid file no rules apply. Existing runtime entries from other sources are preserved and restored when no rules match or at `session_shutdown`; if another writer modifies the runtime map during the session, the extension warns once and stops updating it.

### ctx

The [omp-todo-more](plugins-and-modes.md#todo-more) plugin owns `ctx` and `todo`; `agent/config.yml` disables native `todo`. The updater preflights ownership of the local Todo/ctx files it retires before installing plugins, removes the listed Todo files only after OMP confirms plugin readiness, and removes the listed ctx files only when that ready plugin carries `src/ctx`.

Tool documentation: `xd://ctx` and `xd://todo`.
