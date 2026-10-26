# Local Extensions

[Home](../README.md) · English | [简体中文](extensions.zh-CN.md)

## Local Extensions Index

| # | Extension | Section | Scope | Light mode | Config (`omomp.yml` section or sibling file) |
|---|---|---|---|---|---|
| 1 | `system-prompt-replace` | [Prompts and Context](prompts-and-context.md#system-prompt-replace) | Main + Sub | No | `omomp.yml#system-prompt-replace` (repo) |
| 2 | `append-system-model` | [Prompts and Context](prompts-and-context.md#append-system-model) | Main + Sub | Yes | `APPEND_SYSTEM_MODEL.md` (machine-local) |
| 3 | `repo-rules` | [Prompts and Context](prompts-and-context.md#repo-rules) | Main + Sub | Yes | Scans `.claude/rules`, `.agents/rules`, `.pi/rules`, `~/.claude/rules`, and native rules for `paths` |
| 4 | `fork-task` | [Prompts and Context](prompts-and-context.md#fork-task) | Main + Sub | No | None |
| 5 | `model-compaction` | [Prompts and Context](prompts-and-context.md#model-compaction) | Main writes / Sub reads | Yes | `omomp.yml#model-compaction` (machine-local) |
| 6 | `user-prompt-inject` | [Subagents](agents.md#user-prompt-inject) | Subagents | No | `PROMPT-INJECT-*.md` (`user-goal.md` in repo) |
| 7 | `isolation-nudge` | [isolation-nudge](#isolation-nudge) | Main + Sub | No | None |
| 8 | `task-split-check` | [task-split-check](#task-split-check) | Main (`split`) / Main+Sub (`report-limit`) | No | `omomp.yml#task-split-check` (repo) |
| 9 | `task-completion-judge` | [task-completion-judge](#task-completion-judge) | `task:low/mid/free` | No | `omomp.yml#task-completion-judge` (repo) |
| 10 | `tool-policy-nag` | [tool-policy-nag](#tool-policy-nag) | Main | No | `omomp.yml#tool-policy-nag` + `INTENT-policy.md` (repo) |
| 11 | `watchdog-agent` | [watchdog-agent](#watchdog-agent) | Main + Sub | No | `WATCHDOG-*.md` (machine-local) |
| 12 | `turn-judge` | [turn-judge](#turn-judge) | Main + Sub (per file `target`) | No | `TURN-JUDGE-*.md` (`gpt-talk-only` in repo; others machine-local) |
| 13 | `lang-nag` | [lang-nag](#lang-nag) | Main | No | `omomp.yml#lang-nag` (repo) |
| 14 | `child-memory-warning` | [child-memory-warning](#child-memory-warning) | Process-wide (from main) | Yes | `omomp.yml#child-memory-warning` (repo) |
| 15 | `input-polish` | [input-polish](#input-polish) | Main TUI | Yes | `omomp.yml#input-polish` (repo) |
| 16 | `doc-polish` | [doc-polish](#doc-polish) | Main + Sub | No | `omomp.yml#doc-polish` (machine-local) |
| 17 | `wt-tool` | [wt-tool](#wt-tool) | Main TUI | Yes | None |
| 18 | `harness-restart` | [harness-restart](#harness-restart) | Main TUI | Yes | None |
| 19 | `commandcode-model-spec` | [commandcode-model-spec](#commandcode-model-spec) | Main + Sub | Yes | Reads machine-local `commandcode-models.json` |
| 20 | `antigravity-wire-profiles` | [antigravity-wire-profiles](#antigravity-wire-profiles) | Root main (process-wide table) | Yes | Backend `fetchAvailableModels`; no file |
| 21 | `omp-config-autoupdate` | [Setup, Sync and Maintenance](operations.md#omp-config-autoupdate) | Root main | Yes | `omomp.yml#omp-config-autoupdate` (machine-local) |
| 22 | `omomp-lang` | [omomp-lang](#omomp-lang) | Process-wide (module load) | Yes | `omomp.yml#omomp-lang` (repo) |
| 23 | `read-topics` | [read-topics](#read-topics) | Process-wide (`tool://` scheme) | Yes | Cuts OMP's bundled `omp://tools/read.md`; no file |

---

## Task Dispatch and Yield Checks

### isolation-nudge

Source: `agent/extensions/isolation-nudge/`.

Runs at `tool_call` on `task` in main and subagent sessions (`fork_task` defaults to `isolated: true` and is not checked). When a call would leave $\ge 2$ write-capable agents (`task:*`, built-in `task`, omitted `agent`, `m1`, etc., counting both the current batch and running shared writer jobs from the same session) in the same working directory with at least one item leaving `isolated` unset, it blocks the call once per SHA-256 of the item's `task` text and asks for `isolated: true` on writers and `isolated: false` on read-only items. A second call with the same `task` text passes.

### task-split-check

Source: `agent/extensions/task-split-check/`.

Runs at `tool_call` on `task` and `fork_task`. Evaluates two yes/no checks per item concurrently under a shared 25 s timeout, blocking the whole call if any item fails:

- **Models**: queries the OMP model role `@task-split-check` (assigned in `/model`, stored in machine-local `modelRoles`), then the role named by `omomp.yml#task-split-check.fallbackRole` (shipped value `smol`), resolved per call. Uses `medium` reasoning unless the role entry has a `:level` suffix; on provider error, moves to the next model in the chain.
- **Failure handling**: missing or invalid config, no resolved model, request errors, and timeouts fail open. Every judged call logs `task-split-check verdicts`.

| Check | Scope | Question | Cache and retry behavior |
|---|---|---|---|
| `split` | Items for `task:low`, `task:mid`, or `task:free` in main-session `task` calls | Checks the item's `task` text alone (shared `context` is background): does it combine multiple unrelated topics in one worker (by topic, not file count)? | Caches all verdicts (`pass-repeats`): because topic boundaries can be a judgment call, if the caller confirms it is one topic and resends the same `task` text, the second call passes. |
| `report-limit` | Items with `agent` set to `task:*` or omitted, in `task` and `fork_task` of any session | Checks both shared `context` and item `task`: does it cap the length of the worker's report (words, lines, paragraphs, tokens, or "brief report"; length limits on files the worker writes do not count)? | Caches only passing verdicts (`skip-clear`): capping a worker's report truncates evidence the parent needs, so the cap must be removed (long reports can be written to `local://<name>.md`) and unchanged retries stay blocked. |

### task-completion-judge

Source: `agent/extensions/task-completion-judge/`.

Runs at `tool_call` on terminal structured `yield` calls inside `task:low`, `task:mid`, and `task:free` subagents (`task:high`, main sessions, error yields, and incremental yields are skipped):

- **Input (60k-token budget)**: takes the assignment from the branch's last `session_init` (ignoring inherited `fork_task` history before it), the system prompt's shared background, the worker's Todo `goal`, the `yield` payload (up to 6,000 chars), and the newest contiguous sequence of tool calls and results after `session_init` that fit the remaining budget (up to 800 chars per call argument and result, keeping 60% head + 40% tail when truncated; estimated at 1 token per ASCII char and 2 tokens per non-ASCII char).
- **Models and criteria**: queries `@task-completion-judge`, then `omomp.yml#task-completion-judge.fallbackRole` (shipped value `smol`), resolved per call, `low` effort unless `:level` is set, 25 s timeout, moving to the next model on provider error. Returns `DONE` or `NOT_DONE`. If the worker's Todo `goal` narrows the assignment, its stated measure never appears in the tool calls, or the work falls short of `doneWhen` (reporting a blocker included), the verdict is `NOT_DONE`.
- **Bounce rules**:
  1. The first `NOT_DONE` blocks `yield` with the reason so the worker finishes and verifies the work.
  2. After `DONE`, the extension queries `omp-todo-more:read` and blocks once if any `pending` or `in_progress` items remain (`blocked` items do not block), listing their explanations so the worker updates its Todo list first.
  3. Each of the two bounces happens at most once per subagent session so a blocked worker cannot get trapped in an infinite bounce loop; after passing, subsequent `yield` calls in that session are not judged. When `yield` data is an open object without a custom `outputSchema`, passing results attach `data.completion_judge = { verdict, reason, bounced }` (`bounced` reflects only the `NOT_DONE` bounce). Config, model, or plugin-read errors log a warning and fail open.

---

## `JUDGE`-Backed Extensions

`turn-judge`, the `intent` lane of `tool-policy-nag` (when `detector: jev`), the option mode of `watchdog-agent`, and `lang-nag` call `openJudge` in `agent/extensions/_shared/judge.ts`:

1. `openJudge` first builds OMP's judge-role chain (`resolveJudge`: `modelRoles.judge`, then `retry.fallbackChains.judge`, or OMP's built-in judge defaults). Candidates without credentials are skipped; a provider error moves to the next candidate (401/402/403 cools that candidate down for 5 minutes); abort or timeout stops immediately. From the first native judgment API model onward, OMP keeps only native candidates, and `openJudge` never appends the session model.
2. When that chain fails for any reason other than abort or timeout, or resolves no model, `openJudge` falls back to the chat models of `omomp.yml#judge.fallbackRole` (shipped value `tiny`, i.e. `@tiny`: `modelRoles.tiny`, then `retry.fallbackChains.tiny`, skipping on-device `local` models) using prompted judgment (`TextJudge`). Prompted answers are one-hot (the chosen option has probability 1). Without a `judge` section, there is no fallback.
3. Both stages record usage in the session ledger, and identical native requests use OMP's judgment cache. Role settings and `omomp.yml#judge` are re-read on every call.

### tool-policy-nag

Source: `agent/extensions/tool-policy-nag/`. Main session only.

Inspects `bash`, `bash_bg`, `exec_command` (including writes to `xd://bash`, `xd://bash_bg`, `xd://exec_command`), and `eval` at `tool_call`. It only sends reminders and never blocks a tool call. By design, it uses tool-routing violations as an observable signal that the model has drifted from the static system prompt (frontier models, Claude Opus included, frequently ignore static system prompts in long sessions): `form.prompt` is injected not as a system notice, but as a user-role steer phrased as a direct user observation, which receives higher instruction priority across opaque provider schemas and pulls the model back to the system prompt. The heuristic detector intentionally does not minimize false positives: line-by-line inspection of post-trigger thinking blocks shows that false triggers cost only a small number of self-reflection tokens without other adverse effects.

Reads `omomp.yml#tool-policy-nag` on every watched call (project `.omp/omomp.*` before agent-dir `omomp.*`; without a valid section, nothing runs):

```yaml
tool-policy-nag:
  detector: heuristic
  form:
    prompt: 你为什么不遵守system prompt，反思自己以后继续。
    afterHits: 3
    maxNags: 3
  intent:
    threshold: 0.5
  risk:
    minCommands: 4
    minChars: 600
    minPrograms: 3
```

- **`detector: heuristic`**: requires `form` and ignores `intent` (no JUDGE calls, `INTENT-policy.md` not read). Sets `bashInterceptor.enabled = false` in the main session's runtime settings layer before inspecting calls (subagents inherit that runtime setting too), and clears the override when `detector` changes or at `session_shutdown`.
- **`detector: jev`**: requires `intent` and leaves `bashInterceptor.enabled` as configured in `config.yml` (while the interceptor is on, all three lanes skip `bash` calls because the interceptor already rejects them; `exec_command`, `bash_bg`, and `eval` are still checked). An optional `form` block counts alongside `intent` and sends its `prompt` only while `intent` cannot run (`INTENT-policy.md` missing/invalid/disabled, or no judge model resolved); judge failures or 90 s timeouts log one warning per reason and do not trigger `form`.
- **`form` lane (command parser and counter)**:
  - Parses pipes, `;`/`&&`/`||`, quotes, heredocs, `$(…)`/backticks, and redirects (`>|`, `&>`), unwrapping `NAME=value` prefixes, shell keywords (`if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`), and wrapper commands (`timeout`, `env`, `nice`, `stdbuf`, `time`, `nohup`, `command`, `exec`, `builtin`, `xargs`); skips `sudo`/`doas`/`su`/`ssh` and inspects literal `bash|sh|zsh|dash -c '…'`, `eval '…'`, and `find -exec … ;` bodies in place.
  - Counts six shell categories: listing (`ls`, `tree`, `fd`, actionless `find`, `rg --files`, `ag -g`), reading (`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`, `sed -n`, awk line/range selectors, single-file `jq`, single read-only `sqlite3` queries and `.tables`/`.schema`, `tar -t`/`-xO`, `unzip -l`/`-p`), searching (`grep` with files or `-r`, `rg`/`ag`/`ack` unless reading piped stdin, awk `/re/`, worktree `git grep`), editing (`sed -i`, `perl -i`, `awk -i inplace`, `mv`), writing literal content (`echo`/`printf`/heredoc `cat` redirected to a file or piped to `tee`), and inline scripts (`node`/`bun`/`deno`/`python`/`ruby` with `-e`/`-c`/`-p`/`--eval` or `-` stdin); plus `eval` file calls (`Path.read_text`, `open`, `glob`, `os.listdir`, `readFileSync`, `Bun.file`, `readdir`, `Bun.Glob`).
  - Exemptions: listing/reading/searching captured in `$(…)`, piped into `wc`/`uniq -c`/`grep -c`, passed to `xargs`, or used as `grep -q` in an `if`/`while` test; `/dev/*` targets; and `tail -f`, `locate`, `find` with `-delete`/`-exec rm`, `git ls-files`, or pathless `grep` on stdin.
  - Silently records the first `form.afterHits` (`3`) hits; after that, steers `form.prompt` with a UI warning up to `form.maxNags` (`3`) times per context until the next compaction, `/clear`, or `branch_summary` (raising `maxNags` re-arms immediately). Persists state in session custom entry `mouriya.omp.tool-policy-nag.state`.
- **`intent` lane (`INTENT-policy.md`)**: sends one non-blocking JUDGE `choice` request per call across 12 options (`list`, `read`, `search`, `edit`, `write`, `move`, `eval`, `ast`, `pty`, `shell`, `mixed`, `none`). When a shell call selects anything other than `none` (or `eval` selects anything other than `eval`/`none`) with probability $\ge$ `threshold` (`0.5`), injects an `aside` reminder at the next step boundary naming the intent title, the built-in tool to use, and the call text.
- **`risk` lane (shell only, no model)**: runs synchronously in `tool_call` when `risk` is configured. Triggers when a command has $\ge$ `minCommands` (`4`) segments or $\ge$ `minChars` (`600`) chars, invokes $\ge$ `minPrograms` (`3`) distinct external programs (excluding shell builtins such as `cd`, `echo`, `printf`, `export`, `source`, `test`, `mkdir`), and includes a write operation (redirect/`tee`/in-place edit, write binaries such as `rm`/`cp`/`mv`/`chmod`/`dd`/`tar -c|-x`/`rsync`/`scp`/`make`/`install`/`patch`, or write subcommands of `git`, `gh`, `docker`, `kubectl`, `orb`, `npm`/`pnpm`/`yarn`/`bun`, `tofu`/`terraform`, `curl`, `wget`). Sends one reminder listing the counts, programs, and write steps.

### watchdog-agent

Source: `agent/extensions/watchdog-agent/`.

Runs periodic reviews configured by `WATCHDOG-<label>.md` files in `~/.omp/agent/extensions/watchdog-agent/` and `<dir>/WATCHDOG-*.md` or `<dir>/.omp/WATCHDOG-*.md` from `cwd` up to the git root (machine-local, not synced):

| Frontmatter field | Values and default | Behavior |
|---|---|---|
| `target` (required) | `main`, subagent name (e.g. `task:low`), `*`, `subagents`, or comma list | Selects which sessions run this watchdog |
| `name`, `enabled` | `name` defaults to file label; `enabled` defaults to `true` | Used by `/watchdog`; duplicate names across discovered files report an error |
| `delivery` | `aside` (default), `steer`, `nextTurn`, `followUp` | How reminders are injected (`nextTurn` waits for the next user input or subagent `before_agent_start`) |
| `every`, `scope` | `every` default `30`; `scope` `full` (default) or `window` | Each tool call and each non-empty text reply counts as 1 action; runs at `every` actions and catches up on remaining actions at terminal `agent_end`. `window` reads only messages after the last cursor |
| `maxPerContext` | Positive integer, unlimited by default | Max reminders between two compactions (compaction resets the cap count without resetting action count or `window` cursor) |
| `model`, `tools` | Chat reviewer mode (default) | Runs in an extension-less `taskDepth: 1` in-memory session; `model` tries `@advisor`, `advisor`, `@slow`, then the session model; `tools` defaults to `[read, grep, glob]` (may include `ast_grep, web_search, edit, write, bash, eval`). A first line starting with `PASS`/`OK`/`LGTM`/`NONE` passes; any other response injects `<watchdog name=… severity=…>` |
| `instructions`, `option.<label>[.prompt\|.delivery]` | JUDGE mode (enabled when $\ge 2$ `option.*` keys are set) | Cannot be combined with `model`/`tools`/`note`; calls `openJudge` to pick a declared lowercase option and injects its `.prompt` (no `.prompt` = pass). Errors or 90 s timeouts do not fall back to chat mode |

- **Cursor state**: stores the last reviewed position in session custom entry `mouriya.omp.watchdog-agent.cursor` and rebuilds it on resume or branch switch.
- **Commands**: `/watchdog [list]`, `/watchdog on|off <name> [session|global]`, `/watchdog rm <name>`. `/watchdog add <request>` and `/watchdog edit <name> [change]` send an `attribution: "agent"` prompt to the active model that steps through **1. Draft (expected behavior, settings table, full file text, and absolute path; no file write) → 2. Revise → 3. Write after user confirmation**. Any `write` or `edit` on a `WATCHDOG-*.md` file appends its recognition status to the tool result.

### turn-judge

Source: `agent/extensions/turn-judge/`.

Evaluates discovered `TURN-JUDGE-<label>.md` files after every turn that the model ended with `stopReason: "stop"` and non-empty text (including subagent final reports and IRC replies when `task.structured` is off). The repository ships `TURN-JUDGE-gpt-talk-only.md`; machine-created files stay machine-local.

- **Matching**: `target` (same syntax as `watchdog-agent`, default `main`), optional unanchored JavaScript regexes `model` and `provider` matched against the assistant message's model/provider, and optional comma-separated `skipTools` (if the turn called any listed tool since the previous `stop` ending, the file is skipped).
- **Frontmatter and JUDGE input**: `name`, `enabled` (default `true`), `target`, `model`, `provider`, `skipTools`, `maxChars` (default `30000`), `option.<label>` ($\ge 2$ options, no `.` or whitespace), `option.<label>.prompt`, and required `option.<label>.threshold` $\in (0, 1]$ when `.prompt` is set; the file body is the question. Sends `{ 时间线: [{ 类型, 内容 }], 本轮回复 }` to `openJudge`. `时间线` starts at the last human prompt on the branch and lists `用户说`, `提醒` (first 400 chars each), `模型想` (reasoning text, excluding redacted blocks), `模型说`, and `模型调用工具` (`name：intent`, without arguments or results), dropping the oldest entries after `用户说` when total length exceeds `maxChars`.
- **`TURN-JUDGE-gpt-talk-only.md`**: `target: main`, `model: (^|/)[Gg][Pp][Tt]`, `skipTools: wt, harness_restart`; options `做完在汇报`, `只需文字`, and `只说不做` (`threshold: 0.8`), which sends a prompt telling the model to continue working with tools when a GPT main agent stops in prose before finishing assigned work. Calibrated on 329 GPT main-session turns (2026-10-10 to 2026-10-25) under `futureppo-jev/decision-model-preview`: caught 6 of 19 hand-labelled premature stops with 0 false positives across 23 labelled negatives and 287 unlabelled turns.
- **Main session vs subagent delivery**: in the main session, judgments run in the background; the highest-probability triggered option sends its `.prompt` with `attribution: "agent"` (unless the user already typed or switched branches), while untriggered files merge into one `turn-judge <name>：<label>（<probabilities>）` UI notification. In a subagent, `message_end` awaits judgments for up to 20 s, sends triggered prompts as one `attribution: "agent"` message once idle, and lets the new turn's reply replace the subagent report returned to the parent (verdicts and warnings go to the OMP log).

### lang-nag

Source: `agent/extensions/lang-nag/`. Main session only.

At `agent_end`, takes the first 200 characters of the last paragraph of the last non-empty reply and asks `openJudge` whether it is written in `omomp.yml#lang-nag.language` (shipped: `language: 中文`, `instruction: 说中文`, read at session start or switch). On mismatch, prepends `"说中文\n\n"` to the user's next input (slash commands clear the pending flag; if the user sends a message before the check finishes, the check is aborted and the message is sent unchanged).

---

## Host, TUI and Compatibility Extensions

### child-memory-warning

Source: `agent/extensions/child-memory-warning/`. macOS (Darwin) only; enabled in both full and light mode.

On the first main session's `session_start`, opens `libproc`/`sysctl` via Bun FFI and samples every 2 s (non-Darwin platforms log one `未启用` info entry; main shutdown clears the timer and closes the library):

- Reads `ri_phys_footprint` from `proc_pid_rusage` and keys processes by `PID + kernel start time`. Tracks all descendants of the OMP process and process groups created by observed descendants; reparented orphans (`PPID === 1`) stay tracked until exit.
- Reads `omomp.yml#child-memory-warning.thresholdGiB` (shipped `4`; project `.omp/omomp.*` wins over agent-dir `omomp.*`) on every 2 s scan. If the section is missing or invalid, tracking continues while alerts pause and each new config problem warns once.
- When an owned process exceeds `thresholdGiB`, warns once per process identity (one main-UI warning and one `attribution: "agent"` message with PID, PPID, orphan status, GiB/bytes, threshold, and 240-char command). Never signals or kills processes.

### input-polish

Source: `agent/extensions/input-polish/`. Main interactive TUI only.

Intercepts `omomp.yml#input-polish.key` (default `ctrl+enter`, or `alt+enter` on terminals without Kitty keyboard protocol / `modifyOtherKeys`) and rewrites the input draft using `@input-polish` then `fallbackRole` (shipped `smol`, with `instruction: 在不改变原意的前提下，改写到听起来会让人更加想努力、能激动人心，但不要太夸张。`) in a tool-less `taskDepth: 1` helper session. Streams the rewrite into a read-only overlay above the editor while leaving the original draft untouched:

- `Enter` after completion replaces the draft with the rewrite and submits it; `Esc` or `Ctrl+C` cancels and closes the overlay.
- Blank drafts and drafts starting with `/`, `!`, or `$` are ignored. Rewrites that alter `[Paste #N …]` or `[Image #N …]` placeholders are rejected with an error in the overlay.

### doc-polish

Source: `agent/extensions/doc-polish/`. Registers `polish_doc` and `/polish-doc <path…>`.

Polishes `.md` and `.txt` files for readability without modifying the source file. Writes outputs to `/tmp/doc-polish/<timestamp>-<filename>/`: a copy of the original file, `split.json`, and `review.md`:

- Runs three `taskDepth: 1` in-memory subagent stages with extensions disabled: **Split** (`[read, write]` tools; writes line-range blocks and a keyword glossary to `split.json`) → **Polish** (no tools; rewrites batches of $\le 5000$ code points in parallel and regroups merged blocks via union-find) → **Check** (no tools; verifies meaning preservation per group).
- Models come from `@doc-polish.split`, `@doc-polish.polish`, and `@doc-polish.check` (assigned in `/model`; `check` falls back to `split`'s chain), each followed by `fallbackRole` in the machine-local `doc-polish` section of `omomp.*` (default concurrency `6`):

```yaml
doc-polish:
  fallbackRole: default
  concurrency: 8
```

- Fails before writing `/tmp/doc-polish/` if split or polish resolves no model. Unparseable polish batches keep the original text. The returned prompt requires the main agent to read every `review.md` in full without delegating or truncating.

### wt-tool

Source: `agent/extensions/wt-tool/`. Main interactive TUI only (`defaultInactive`, enabled on main `session_start`/`session_switch`).

OMP's `/wt` and `/move` reject calls while a turn is streaming, and `ExtensionAPI` does not expose `InteractiveMode`. The extension captures the live `InteractiveMode` instance during a synchronous `ctx.ui.setEditorComponent(undefined)` call, queues the tool request, and asks the model to end its turn; once the turn ends (`agent_end` without `willContinue`) and the session is idle, it runs `executeBuiltinSlashCommand` on the TUI instance and sends the result back as an `attribution: "agent"` message (pressing `Esc` cancels the queued action):

- **`wt`**: runs `/wt [<branch>]`. If the session is already in a linked worktree, the first call creates nothing and returns the current worktree path, branch, HEAD, uncommitted count, main checkout path, and a `confirm` hash; pass that `confirm` value on a second call to create another worktree.
- **`wt_remove`**: requires two calls. Calling without `confirm` runs a read-only check returning the worktree/main paths, `SAFE`/`UNSAFE`/`BLOCKED` status, files that removal would delete (staged, unstaged, untracked, ignored, up to 50 per category with totals), unmerged branch commits (kept on the branch), active job/subagent blockers, and a `confirm` hash bound to the worktree state. Calling with `confirm` re-checks the state when idle, runs `/move <main checkout>`, verifies the new `cwd`, re-checks the state, and calls `worktreeRemove(path, true)`, stopping immediately if anything changed.

### harness-restart

Source: `agent/extensions/harness-restart/`. Main interactive TUI only (enabled in light mode).

Queues a restart using the same idle-turn `InteractiveMode` mechanism as `wt-tool`. Right before calling `InteractiveMode.restart()`, appends custom session entry `mouriya.omp.harness-restart.request` (`reason` and timestamp); when the restarted process resumes the session, `session_start` sends `"Harness restart completed (<time>). Reason was: <reason>. Continue what you were doing."` with `attribution: "agent"`.

### commandcode-model-spec

Source: `agent/extensions/commandcode-model-spec/`.

Fixes two startup issues when `--model` selects a `commandcode` model: `models.db` caching discovered models with `openai-completions`/`anthropic-messages` instead of `commandcode-custom` (causing 401 errors), and model ids such as `google/gemini-3.5-flash-lite` matching the built-in `google` provider. At `session_start`, reads `<agentDir>/commandcode-models.json` (or `COMMANDCODE_MODELS_CACHE`) and, when the active model is in that catalog with `api !== "commandcode-custom"` and is not a credentialed built-in model, calls `setModel` to rebind it to the live `pi-commandcode-provider` model.

### antigravity-wire-profiles

Source: `agent/extensions/antigravity-wire-profiles/`.

OMP's `google-antigravity` provider only overrides the caller's `maxTokens` for wire ids present in its static `ANTIGRAVITY_MODEL_WIRE_PROFILES` table (`@oh-my-pi/pi-catalog/wire/gemini-headers`); newer wire ids (`gemini-4-argon-*`) were missing, so compaction's 512-token short summary request spent its entire budget on thinking and failed with `thought-only response without final output`.

At root `session_start` (awaited up to 20 s; `before_agent_start` awaits the same promise), the extension calls `POST <baseUrl>/v1internal:fetchAvailableModels` for the session credential and every stored Antigravity account, merges served models (non-internal, non-disabled, positive integer `maxOutputTokens`), and updates `ANTIGRAVITY_MODEL_WIRE_PROFILES` in place (adding and overwriting entries, never deleting). If all accounts fail, it keeps the existing table, warns in the log and main UI, and retries on the next root session start.

### read-topics

Source: `agent/extensions/read-topics/`.

Adds per-feature topics to the built-in `read` tool through a `tool://` internal-URL scheme: `read tool://read` lists the topics, `read tool://read/<topic>` returns one (line selectors apply, e.g. `tool://read/sqlite:1-40`), and an unknown topic fails with the available keys. `grep`/`find` over `tool://read` search every topic.

- **Content**: each topic is one section of OMP's bundled `omp://tools/read.md`, fetched with `getEmbeddedDoc` and cut by a fixed key → heading table: `selectors` (`## Inputs`), `outputs`, `flow`, `local-files`, `directories`, `archives`, `executables`, `video`, `profiler-reports`, `sqlite`, `documents`, `notebooks`, `images`, `internal-urls`, `web-urls`, `side-effects`, `limits`, `errors`. The maintainer-only `Source`, `Registration / Visibility` and `Notes` sections are not topics. The text follows the installed OMP version; the repo keeps no copy.
- **Lifecycle**: the factory registers the handler once per process in OMP's process-global `InternalUrlRouter`; the doc is loaded and cut on the first `tool://` read. The handler's `promptDoc` adds a `tool://read/<topic>` line to the system prompt's internal-URL list, and the `read` description in `omomp.yml#system-prompt-replace` names the topic keys.
- **Failure**: an OMP-owned or another host's `tool` scheme is left alone with a log warning. When the doc is missing, or a heading in the table is missing or repeated, the read fails with that drift spelled out instead of serving partial topics.

### omomp-lang

Source: `agent/extensions/omomp-lang/`.

Sets the UI language (`en` or `zh`) for person-facing text across local extensions and OMP plugins (notifications, widgets, status bar, dialogs, overlays, command/shortcut descriptions, tool labels, and renderers). Model prompts, steers, tool descriptions, tool results, and logs are not translated.

- Reads `omomp.yml#omomp-lang.language` (shipped `zh`) from the agent-dir `omomp.*` only (project `.omp/` copies are ignored; changes apply on the next OMP start).
- At module load, sets `process.env.OMOMP_LANG` unless the launch environment already defines it (`OMOMP_LANG=en omp`).
- `_shared/i18n.ts` `tr(en, zh)` resolves `OMOMP_LANG` → `omomp.yml#omomp-lang.language` → `LC_ALL` / `LC_MESSAGES` / `LANG` (`zh*` = Chinese) → English at each call site, reading the config section directly so deferred extensions that produce text before `omomp-lang` finishes loading still use the configured language.
- OMP-only plugins (`omp-todo-more`, `omp-playbooks`, `omp-thinking-translator`, `omp-codex-image-gen`, `omp-remote-build`) resolve the same chain; Pi-compatible plugins (`omp-unified-exec`, `pi-bansos`) read the environment; third-party npm plugins (`pi-commandcode-provider`, `pi-package-search`) are English-only.
