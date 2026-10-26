# Four-Layer Prompt Architecture and Context Economics

[Home](../README.md) · English | [简体中文](prompts-and-context.zh-CN.md)

## Four-Layer Prompt Separation

To prevent prompt bloat and conflicting instructions, the system prompt is split into four orthogonal layers:

| Layer | Carrier file / extension | Scope | Responsibility and boundary |
|---|---|---|---|
| **1. Base workflow layer** | `agent/SYSTEM_TEMPLATE.md` | Main + Subagents | Vendored Handlebars template derived from OMP's `packages/coding-agent/src/prompts/system/system-prompt.md` (plain-text `SYSTEM.md` cannot compile expressions). Owns general engineering discipline, renders live tools/skills/rules, and switches Step 4 between parent `Verify` and subagent `Hand-off` via `{{#if subagent}}`. Never reprints individual tool instructions. |
| **2. Speaking & writing register layer** | `agent/PERSONALITY.md` | Main session only (subagents run with `personality: none`) | Fills the template's `{{personality}}` slot. The first half copies OMP's `personality: default` (`Evidence-first terse engineer`) verbatim; the second half defines the `# Writing` high-density register for research and analysis prose: open with the finding, number or mechanism; carry time, actor, action, scale and source in one sentence; put multiple objects or metrics in one table without row-by-row prose restatement; cut process narration, repeated explanations, stacked disclaimers and summary recaps (delete any paragraph whose removal leaves the reader's grasp of facts, numbers, mechanism, conditions and conclusions unchanged). |
| **3. Main-session local policy layer** | `agent/APPEND_SYSTEM.md` (empty `APPEND_SYSTEM_LIGHT.md` in light mode) + [repo-rules](#repo-rules) | `APPEND_SYSTEM.md`: Main only; `repo-rules`: Main + Sub | `APPEND_SYSTEM.md` adds four local rules: ① explicit user instructions override all defaults; ② the final reply is the sole deliverable (complete sentences with explicit subjects, identify objects on first mention, put `path:line` or observed output beside every conclusion, no analogies); ③ never trade quality for token savings (read design documents and related docs in full before editing); ④ consult both `discuss:steady` and `discuss:divergent` on consequential decisions, and pair long investigations with `mentor:default`. |
| **4. Dynamic tool surgery & model deltas** | [system-prompt-replace](#system-prompt-replace) + [append-system-model](#append-system-model) | Main + Subagents | `system-prompt-replace` runs last among path-loaded extensions to rewrite rendered built-in/plugin tool descriptions in place; `append-system-model` appends model-specific blocks matched by `model`/`provider` regex so corrections for one model family never pollute others. |

### system-prompt-replace

Located at `agent/extensions-last/system-prompt-replace/` and registered as the final entry of `agent/config.yml`'s `extensions` list. Because `before_agent_start` handlers run serially in extension load order (native discovery `~/.omp/agent/extensions/` and `settings.json` modules → hooks → plugin extensions → `-e` arguments → `config.yml` `extensions` list → OMP's built-in inline factories), placing it in `extensions-last/` outside `extensions/` as the last `config.yml` entry guarantees it sees the prompt after every other path-loaded extension (placing it inside `extensions/` would load it early in step 1 and drop the `config.yml` entry as a duplicate path).

Re-reads the `system-prompt-replace` section of the agent directory's `omomp.*` on every `before_agent_start` (project `.omp/` copies are not read; requires `inlineToolDescriptors: "on"` in `config.yml` so full tool descriptions are rendered into the system prompt):

```yaml
system-prompt-replace:
  replacements:
    - literal: "exact original text"
      replace: "replacement text"
    - regex: "JavaScript regex source"
      replace: "replacement text, $1 and $& supported"
```

- **The repository's 10 active replacement rules**: ① expands `read` into OMP's unified `<source><:selector>` / `<source>?<query>` retrieval and hashline snapshot protocol, including how a single-stream `.gz` exposes its one member (linking `omp://tools/read.md`); ② replaces `task`'s `"Use most specific agent."` with cost-and-trust tier selection (`task:mid` default, `task:low` for cost/validation of `task:free`); ③ removes the native child wrapper's `"Every task MUST skip build/lint/tests..."` and `"No TODO tracking, no progress updates."` sentences so they cannot conflict with mandatory worker Todo or `fork_task` verification; ④ requires `isolated: true` for concurrent writers while keeping research-only agents shared and reachable; ⑤ requires explicit `agent` selection and forbids unrequested `effort` overrides; ⑥ clarifies not rerunning checks to doubt user-reported errors while still reproducing to locate causes and confirm fixes; ⑦ adds the missing `add` to the compiled-code allocation rule; ⑧ forbids reading, listing or searching local files through `eval`; ⑨ states that `xd://<tool>` devices are invoked only by writing JSON to `xd://<tool>`, never by inventing `xd__<tool>` function names; ⑩ replaces the whole native `bash` description (exact literal, so any upstream wording change triggers the drift warning) with one matching `omp://tools/bash.md` and the three-entry division shared with `agent/extensions/tool-policy-nag/INTENT-policy.md`: `bash` is the synchronous default shell (embedded brush, no shell switching inside a call, isolated shells for overlapping calls, ordinary pipes/`$(…)`/redirection of program output, `timeout` sized to the command, auto-backgrounded results delivered once without polling); `xd://exec_command` takes programs that run long, wait on an outside condition, need a terminal or need another shell, with waiting done as one silent loop plus a condition-less `xd://monitor` that wakes once when it ends; `eval` takes language computation.
- **Drift warning**: when a rule's target is absent from the main session's system prompt (for example after an OMP upgrade alters built-in tool wording), warns once per rule per process via UI notification (stderr in headless mode) and log without blocking the prompt; subagents are not checked because their prompts legitimately omit tools such as `task`.

### append-system-model

Re-reads `~/.omp/agent/extensions/append-system-model/APPEND_SYSTEM_MODEL.md` (machine-owned; repository ships none; edits and `/model` switches apply on the next prompt without restart) on every `before_agent_start`, matching the main session and each subagent against its own current model. The file consists of `---`-fenced YAML headers declaring `model` (matched against model id, e.g. `claude-opus-5-5`) and/or `provider` (matched against provider id, e.g. `^anthropic$`) JavaScript regexes followed by a body running to the next `---` line (use `***` rather than `---` for dividers inside a body). All matching blocks are joined in file order and appended as one extra system-prompt block; a missing file is silently ignored, and format errors log a line-numbered warning once without blocking the prompt.

### repo-rules

OMP scans `.omp/rules`, `.agent(s)/rules`, `.cursor/rules`, `.windsurf/rules`, `.clinerules` and `.github/instructions` by default, but ignores `.claude/rules` and `.pi/rules`, drops a rule file that has neither `alwaysApply` nor `description`, and does not read Claude Code's `paths` frontmatter.

- **Unscoped rules:** this extension scans non-hidden `.md` / `.mdc` files under `.claude/rules`, `.agents/rules` and `.pi/rules` from `cwd` up to the git root (only `cwd` outside a repository; nearer `cwd` wins; within a level, `.claude` → `.agents` → `.pi`), plus the user-level `~/.claude/rules` in every session, and appends a `<repo-level-rules>` block on every `before_agent_start`. A rule without frontmatter, with frontmatter that does not parse, or with `alwaysApply: true` injects its full body; other frontmatter rules list only name, `description` and path. A file OMP already places itself (alwaysApply, rulebook entry or TTSR) is skipped, as is a body already in the incoming system prompt after whitespace normalization and a listing whose `rule://<filename>` is already there.
- **Path-scoped rules (Claude Code `paths`):** a rule whose frontmatter has `paths` (a YAML list or a comma-separated string of globs; braces and `[…]` classes supported) is loaded only when a matching file is touched: a successful `read`, `write` or `edit`, or a `bash` command that is a plain `cat`/`head`/`tail` of one file (pipes, chains and multi-file commands do not count). Sources are the scanned files above and every rule OMP discovers (project and user `.omp`/`.agents` rules, cursor/windsurf/cline/GitHub rules, plugin and extension-root `rules/` such as `~/.claude/rules` via the `~/.claude` extension entry). Patterns are relative to `cwd` for user-level rules, to the directory holding the rule's dot directory for project rules, and to the plugin or extension root for its `rules/`. A native rule with `paths` is taken over wherever OMP would put it: its `alwaysApply` body is removed from `<generic-rules>`, its rulebook line from `<domain-rules>`, and it still obeys `ttsr.disabledRules` and its `agents` scope. TTSR rules (`condition`, `astCondition`, `question`) and OMP's bundled rules keep OMP's own triggering. A matching rule arrives as `tool_result` `additionalContext` (a developer message after the tool batch) once per context: it is not repeated while its `<path-scoped-rule path="…">` marker is in the context OMP would send (so compaction that drops the marker, resume and branch moves are honoured).
- **Absolute patterns (beyond Claude Code):** a `paths` pattern starting with `/` or `~/` is matched against the touched file's absolute path (`~` = home directory) instead of a path relative to the base, so a user-level rule can follow a directory name wherever the session runs, e.g. `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**` for every omp repository. Claude Code itself treats such a pattern as relative and never matches it.

---

## Context Economics

Context management balances **preserving aligned task intent against shedding high-noise execution traces**:

1. **Ordinary `task` (discard execution trace) vs `fork_task` (clone full aligned background)**:
   - When background is short or an independent view is desired, use `task`: the worker's file searches, dead ends and tool outputs stay in its disposable branch, and only the final `yield` payload returns to the main session.
   - When the main session has loaded 1.5M+ characters of design material or completed multi-turn alignment with the human that cannot be summarized losslessly into a short `context` string, use `fork_task` so the worker starts with the full conversation memory while focusing on one local slice.
2. **Deferring lossy compaction (`compaction.methodOrder` + `model-compaction`)**:
   - `agent/config.yml` orders compaction methods from least to most lossy (`remote → soft → snapcompact → handoff → shake`), while `model-compaction` sets high fixed token triggers per model family.
   - `compaction.asyncEnabled: false` makes compaction summarize at the trigger. With it on, OMP requests the summary in the background up to 32k tokens earlier, then holds the finished result until the trigger and never regenerates an Anthropic one, so every request in between still carries the full history.
3. **Deterministic post-compaction state recovery (`omp-todo-more`'s `todo` + `Task log` + `ctx`)**:
   - When the main session eventually compacts, the model's self-summary cannot be trusted alone. `omp-todo-more` logs every successful `todo` mutation to an append-only `Task log` on disk and automatically injects the subagent context tree (`ctx list`) and replayed task timeline (`ctx show`) into the freshly compacted session.

### fork-task

Registers the `fork_task` tool (top-level `context` plus `tasks[]` without `solutionSpace`; requires `async.enabled: true`). It spawns native `task` subagents (with their own agent definition, model, tools, Agent Hub row, `agent://`/`history://` and isolation merge-back), except that each child's starting transcript is a copy of the caller's current conversation, or of the registered agent named by an item's `from: "<agent-id>"`:

- **Key behavioral differences**:
  - `isolated` defaults to `true` (pass `isolated: false` explicitly for research-only; plan mode forces shared directories; isolated subagents cannot be continued after completion).
  - Optional `shake: true` runs `session.shake("elide")` on the cloned transcript — protecting the newest ~4,000 tokens plus `skill://` and `local://PLAN.md` reads while replacing older text tool results, $\ge 400$-token fenced code blocks and top-level lowercase XML elements with `[shaken ~N tokens — recover: artifact://<id> (region K)]` in the shared artifact store so the child can `read` originals back on demand.
  - Optional `from: "<agent-id>"` (resolved like `agent://<id>`, covering running, idle or parked agents) copies that agent's persisted transcript instead of the caller's. Items with `from` must specify `agent` explicitly (model and role are not inherited from `from`), and the child's working directory still comes from the caller's checkout rather than the `from` agent's isolated worktree.
  - **Mandatory runtime verification notice**: appends `<system-notice cause="fork_task">` marking inherited history as background only and **requiring the forked worker to complete scoped build/lint/test checks and real runtime smoke verification before handoff**.
- **Four-step staging pipeline**: ① clones the source session into `$TMPDIR/omp-fork-task/<uuid>/` (zeroing inherited cost, pairing dangling in-flight tool calls with synthetic aborted results, clearing source Todo, and appending the fork notice); ② strips source runtime entries (`session_init`, `model_change`, `thinking_level_change`, `service_tier_change` and shake's `session_exit`) while re-parenting their children; ③ sets the caller's `cwd` for shared children or blanks `cwd` for isolated children so the executor binds them to the worktree; ④ inside `before_subagent_spawn` (after the async task tool pre-allocates the child id), moves the staged file to `<parent session file without .jsonl>/<child id>.jsonl` right before the executor opens it.

### model-compaction

Re-reads the machine-local `model-compaction` section of `omomp.*` in the agent directory on every main-session `before_agent_start` (project `.omp/` copies are not read), overcoming OMP's native `compaction.modelThresholds` limitation to exact `provider/id` or `*`-prefix keys:

```yaml
model-compaction:
  rules:
    - provider: "^anthropic$"
      model: "opus"
      thresholdTokens: 150000
    - model: "[gG][pP][tT]"
      thresholdTokens: 650000
```

- **Matching and runtime injection**: each rule specifies `model`, `provider` or both as non-empty JS regexes (no implicit catch-all; use `"model": ".*"` to match all models). For each model in `ctx.models.list()`, the first matching rule in file order writes `"<provider>/<id>": "f<thresholdTokens>"` into the main session's runtime settings layer for `compaction.modelThresholds` (never touching `config.yml`; `/model` switches, retry fallbacks and subagents reading the main session's live settings automatically use their own model's trigger).
- **Context-window tier protection**: a native `f<N>` entry can switch a model that supports an extended context window onto that tier. This extension **never changes a model's context-window tier**: any rule whose `thresholdTokens` would flip a model between its standard and extended window tier is refused for that model with a warning. Pre-existing runtime entries from other sources are preserved and restored when no rules match or on `session_shutdown`; if another writer modifies the runtime map mid-session, the extension warns once and stops managing it.

### ctx

Read-only tool registered by the [omp-todo-more](plugins-and-modes.md#todo-more) plugin (`src/ctx/inventory.ts`) that stitches the current session, subagent registry, transcripts, compaction summaries, `.md`/`.json` sidecars and the task log into one context tree without mutating any session or file:

- **`ctx list [<id>] [all=true]`**: depth-first view printing one context per line with status, one-line summary and task counts (`done/total` plus `blocked` when a block has a reason). By default shows only the main session and `task` / `task:*` subagents (hiding `mentor`, `discuss` and `trace` while promoting their visible descendants one level up with the hidden count), folding non-root nodes with more than 8 descendants into one line (expand via `ctx list <id>`); `all=true` shows all nodes except the advisor.
- **`ctx show <id>`**: outputs ① the handoff (latest compaction summary for the current session; adjacent `.md` sidecar full text or 120-char `.json` sidecar summary for other contexts), ② the last valid `## Goal` in the task log (Objective / Measure / Done when), and ③ a `## Tasks` timeline replayed from the task log (`Completed` and `Open` sections ordered by the local time of the last accepted operation).
- **Approximation boundary**: counts and timelines are rebuilt from the append-only operation log and approximate `TodoTracker`'s live state (`init`/`append` log counts rather than task names, so tasks never operated on individually after creation count toward `ctx list` totals without appearing in the timeline; once a task name is completed or removed, later `start`/`block`/`unblock` calls do not revive it; a task literally named `all tasks` is treated as a batch selector).

### Task log

After every state-changing `todo` or native `goal` tool call succeeds, `src/ctx/tasklog.ts` in `omp-todo-more` appends the local time, tool name, operation and target to `<local root>/task-log/<agent-id>.md` (a successful `todo` call carrying a goal also appends `todo-more set: <goal JSON>`; read-only `todo view` / `goal get` calls and failed calls are not logged). This binds the work record to verified tool executions rather than model claims.

### After-compact injection

Handled by `src/ctx/post-compact-hint.ts` in `omp-todo-more`. Listening to main-session `session_compact` and non-aborted `auto_compaction_end` events (debounced to at most one attempt per 5-second window; subagents are never injected), it steers a `<post-compact-ctx>` block containing `## List` (`ctx list`) and `## Current session` (`ctx show` for the main session), immediately restoring the subagent tree and replayed task timeline in the post-compaction context.
