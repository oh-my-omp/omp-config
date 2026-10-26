# Runtime Gates, Sideband Judges and Local Extensions

[Home](../README.md) · English | [简体中文](extensions.zh-CN.md)

## Pre-Dispatch and Pre-Yield Hard Gates

### isolation-nudge

Checks `task` calls at `tool_call` in main and subagent sessions (`fork_task` is isolated by default and not checked): when a call would leave $\ge 2$ write-capable agents (`task:*`, built-in `task`, omitted `agent`, `m1`, etc., counting both the current batch and still-running shared writer jobs from this session) sharing the working directory with at least one item leaving `isolated` unset, blocks the call once per SHA-256 of the item's `task` text and asks for `isolated: true` on writers and an explicit `isolated: false` on research-only items; an unchanged redispatch passes.

### task-split-check

At `tool_call`, asks the OMP model role `@task-split-check` (assigned in `/model`; `modelRoles` is machine-local, so the repository ships no model for it), then the role named by `omomp.yml#task-split-check.fallbackRole` (repository value `smol`), resolved per request, `medium` reasoning unless the role entry carries a `:level` suffix, shared 25s abort deadline across the batch, a provider error moving to the next model of that chain, to evaluate two yes/no checks per item of `task` / `fork_task` concurrently, blocking the entire call if any item fails:

| Check | Scope | Criterion | In-memory cache and redispatch policy |
|---|---|---|---|
| `split` | Items for `task:low`, `task:mid`, `task:free` in main-session `task` calls | Judges the item's `task` text alone (shared `context` is background only): does it stuff multiple unrelated topics into one agent (by topic, not file count) | Caches all conclusive verdicts (`pass-repeats`): if the main agent confirms it is a single topic and redispatches unchanged, the second call passes |
| `report-limit` | Items with `agent` set to `task:*` or omitted, in `task` and `fork_task` of any session | Judges both shared `context` and item `task`: does it cap the length of the worker's report (words, lines, paragraphs, tokens or "brief report"; length limits on deliverables written to files do not count) | Caches only clear verdicts (`skip-clear`): **the cap must be removed** (long reports can go to `local://<name>.md`); unchanged redispatches stay blocked |

Unavailable models, missing/invalid config, request errors or timeouts fail open; every judged call logs `task-split-check verdicts`.

### task-completion-judge

Intercepts terminal structured `yield` calls inside `task:low`, `task:mid` and `task:free` subagent sessions (`task:high`, main sessions, error yields and incremental yields are not intercepted):

- **Evidence window (60k-token budget)**: extracts the assignment from the branch's last `session_init` (ignoring inherited `fork_task` history before it), combines the system prompt's shared background, the worker's own Todo `goal`, the submitted `yield` payload (capped at 6,000 chars), and the newest unbroken sequence of tool calls and results after `session_init` that fit the remaining budget (up to 800 chars per call argument and result, keeping 60% head + 40% tail with an omission line when truncated; token count estimated at 1 per ASCII char and 2 per non-ASCII char).
- **Judge model and standard**: asks the OMP model role `@task-completion-judge`, then the role named by `omomp.yml#task-completion-judge.fallbackRole` (repository value `smol`), resolved per judgment, `low` effort unless the role entry carries a `:level` suffix, 25s timeout, a provider error moving to the next model of that chain, for `DONE` or `NOT_DONE`. The assignment defines the required scope: if the worker's Todo `goal` narrows the assignment, its stated measure never appears in the tool calls, or it falls short of `doneWhen` (honestly reporting a blocker included), the verdict is `NOT_DONE`.
- **Double single-bounce gate and annotation**:
  1. The first `NOT_DONE` verdict blocks `yield` with the reason, requiring the worker to finish and verify.
  2. After a `DONE` verdict, it queries `omp-todo-more:read` fresh and blocks once more if any `pending` or `in_progress` items remain (`blocked` items do not trigger this), listing their explanations and requiring the worker to update its Todo list first.
  3. Each bounce occurs at most once per subagent session; once passed, later yields in that session pass unjudged. When `yield`'s data is an open object without a custom `outputSchema`, passing deliveries carry `data.completion_judge = { verdict, reason, bounced }` (`bounced` records only the `NOT_DONE` bounce). Any config, model or plugin-read failure logs a warning and fails open.

---

## Runtime Sideband Correction and Shared Native JUDGE Role

`turn-judge`, the `intent` lane of `tool-policy-nag` (under `detector: jev`), the option backend of `watchdog-agent` and `lang-nag` share OMP's **JUDGE model role** through `openJudge` in `_shared/judge.ts`. Every judgment first goes to OMP's own judge-role chain: `modelRoles.judge`, then `retry.fallbackChains.judge`, or OMP's built-in judge defaults when that key is absent. The chain skips candidates without credentials, moves to the next candidate after a provider error (a 401/402/403 parks that candidate for 5 minutes) and stops at an abort or timeout; from its first native judgment API model on, OMP keeps only native candidates, and `openJudge` never adds the session model. When that chain fails for any reason but abort or timeout, or resolves no candidate, the role named by `fallbackRole` in the `judge` section of `omomp.yml` answers (repository value `fallbackRole: tiny`, i.e. `@tiny`): the chat models of that role's own chain (`modelRoles.tiny`, then `retry.fallbackChains.tiny`), in order, as prompted judges; on-device `local` models are skipped. Prompted answers are one-hot (the chosen option has probability 1), so option thresholds act as plain picks. Without a `judge` section there is no fallback. Attempts of both stages are recorded in the session's usage ledger, and exact native repeats are answered from OMP's shared judgment cache. Nothing runs only when neither the chain nor the fallback role resolves a model. Role config and the section are re-read on every trigger.

### tool-policy-nag

Main session only. Inspects `bash`, `bash_bg`, `exec_command` (including JSON written to `xd://bash`, `xd://bash_bg`, `xd://exec_command`) and `eval` at `tool_call`; **it only reminds and never blocks a command**. Configured in the `tool-policy-nag` section of `omomp.yml` (re-read per watched call from project `.omp/omomp.*` then agent-dir `omomp.*`; nothing is preset in code, so without a valid section no lane runs). `detector` picks how tool-routing violations are caught, `heuristic` (the `form` lane) or `jev` (the `intent` lane); `risk` is an independent third lane, off when missing or `null`:

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

- **`detector: heuristic`** requires `form`; the `intent` block is ignored (kept only so switching back is one word), so no JUDGE request is made and `INTENT-policy.md` is not read. Before every watched call is inspected, the extension puts a runtime-only override `bashInterceptor.enabled = false` on the main session's live settings, whatever `agent/config.yml` (which turns it on) says; subagents read those settings through and lose the interceptor too. The override is cleared when the detector changes and at `session_shutdown`; nothing is written to disk.
- **`detector: jev`** requires `intent`; `bashInterceptor.enabled` follows config, and while it is on, `bash` calls are skipped by every lane because the interceptor already refuses routing violations before they run (`exec_command`, `bash_bg` and `eval` stay watched). An optional `form` block counts beside the intent lane and sends its `prompt` only while the intent lane cannot run (adjacent `INTENT-policy.md` missing, invalid or disabled, or neither the JUDGE role chain nor the fallback role resolves a model); a judgment failure (judge chain and fallback role both failed) or 90s timeout warns once per reason and never triggers a fallback `form` nudge.
- **`form` lane (heuristic parser and counter)**:
  - Parses pipes, `;`/`&&`/`||`, quotes, here-documents, `$(…)`/backtick substitutions and redirects (`>|` and `&>` included), and resolves every command to the program it runs through `NAME=value` prefixes, the reserved words `if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`, and wrappers with their own options (`timeout`, `env`, `nice`, `stdbuf`, `time`, `nohup`, `command`, `exec`, `builtin`, `xargs`); `sudo`/`doas`/`su`/`ssh` are skipped, and literal `bash|sh|zsh|dash -c '…'`, `eval '…'` and `find -exec … ;` bodies are analyzed in place. Counts six shell violation classes: listing (`ls`, `tree`, `fd`, `find` without actions, `rg --files`, `ag -g`), reading (`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`, `sed -n`, awk line ranges and `/start/,/end/` sections, `jq` over one JSON file, single read-only `sqlite3` queries and `.tables`/`.schema`, `tar -t`/`tar -xO`, `unzip -l`/`-p`), searching (`grep` with files or `-r`, `rg`/`ag`/`ack` — pathless means the working directory unless stdin is piped — awk `/re/`, `git grep` over the working tree), editing (`sed -i`, `perl -i`, `awk -i inplace`, `mv`), writing authored bytes (`echo`/`printf`/here-document `cat` redirected to a file or piped into `tee`), and inline scripts (`node`/`bun`/`deno`/`python`/`ruby` with `-e`/`-c`/`-p`/`--eval` before the script operand, or `-` stdin); plus `eval` file/directory calls (`Path.read_text`, `open`, `glob`, `os.listdir`, `readFileSync`, `Bun.file`, `readdir`, `Bun.Glob`). Listing, reading and searching whose output feeds the shell is not counted: a `$(…)` capture, a pipeline that passes only through stdin filters into `wc`/`uniq -c`/`grep -c`, `xargs` arguments, or `grep -q` as an `if`/`while` test. `/dev/*` targets exempt read/search/edit/write. Unlike OMP's interceptor, `tail -f`, `locate`, `find` with `-delete`/`-exec rm`, `git ls-files` and pathless `grep` on stdin are not hits.
  - Records the first `form.afterHits` (`3`) hits silently; past that, every hit steers the configured `form.prompt` (non-empty) with a UI warning, up to `form.maxNags` (`3`) times per context, then stays quiet until the next compaction, `/clear` or `branch_summary` (raising `maxNags` in config re-arms it at once). All three fields are required. State persists in session custom entry `mouriya.omp.tool-policy-nag.state` and rebuilds across branch switches.
- **`intent` lane (native JUDGE tool-routing classification)**:
  - Fires one non-blocking parallel JUDGE `choice` request per watched call using the question and 12 option rubrics in `INTENT-policy.md` (`list`, `read`, `search`, `edit`, `write`, `move`, `eval`, `ast`, `pty`, `shell`, `mixed`, `none`, with explicit counterexamples for `km ls actions`, `ssh host 'cat x'`, `npm test > log`, `curl -I`, stream filters, etc.).
  - When a shell call picks anything other than `none` (or an `eval` call picks anything other than `eval`/`none`) with probability $\ge$ `threshold` (`0.5`), inserts an `aside` reminder at the next step boundary naming the Chinese intent title, the required built-in tool and the call text, uncapped, and logs `Tool-policy intent verdict`.
- **`risk` lane (deterministic model-free risk check, shell only)**:
  - Runs synchronously inside `tool_call`, independent of the tool lanes. Triggers when all three hold: ① simple command segments $\ge$ `minCommands` (`4`) or total characters $\ge$ `minChars` (`600`); ② distinct external programs after stripping shell plumbing (`cd`/`echo`/`printf`/`export`/`source`/`test`/`mkdir`, etc.) $\ge$ `minPrograms` (`3`); ③ includes a write step (redirect/`tee`/in-place edit, a writing binary such as `rm`/`cp`/`mv`/`chmod`/`dd`/`tar -c|-x`/`rsync`/`scp`/`make`/`install`/`patch`, or a write subcommand such as `git add|commit|push|reset`, `gh … create|delete|download|upload`, `docker run|build|push|rm|exec`, `kubectl apply|delete|exec`, `orb push|create|delete`, `npm|pnpm|yarn|bun install|add`, `tofu|terraform apply|destroy|state|init`, `curl -o|-O|-T|-d|-X POST`, `wget -O` checked on the first two non-flag arguments).
  - Sends one reminder naming the segment count, character count, external programs and writing steps, shows a UI warning and logs `Tool-policy risk`.

### watchdog-agent

Per-target runtime reviewer driven by `WATCHDOG-<label>.md` files (discovered in `~/.omp/agent/extensions/watchdog-agent/` and `<dir>/WATCHDOG-*.md` or `<dir>/.omp/WATCHDOG-*.md` from `cwd` up to the git root; machine-owned, never synced):

| Frontmatter field | Values and default | Behavior |
|---|---|---|
| `target` (required) | `main`, subagent name (e.g. `task:low`), `*`, `subagents` or CSV list | Selects which sessions run this watchdog |
| `name`, `enabled` | `name` defaults to file label; `enabled` defaults to `true` | Addressed by `name` in `/watchdog`; duplicate names across discovered files error |
| `delivery` | `aside` (default), `steer`, `nextTurn`, `followUp` | Delivery mode (`nextTurn` waits for the user's next real input or a subagent's next `before_agent_start`) |
| `every`, `scope` | `every` default `30`; `scope` `full` (default) or `window` | Each tool call and each non-empty text reply counts as 1 action; runs immediately at `every` and catches up on the remainder at terminal `agent_end`. `window` reads only messages after the cursor |
| `maxPerContext` | Positive integer, unlimited by default | Max reminders injected between two compactions; compaction resets the cap count without resetting action count or `window` cursor |
| `model`, `tools` | Chat reviewer backend (default) | Runs in an extension-less `taskDepth: 1` in-memory session; `model` falls back through `@advisor`, `advisor`, `@slow` to the session model; `tools` defaults to `[read, grep, glob]` (may grant `ast_grep, web_search, edit, write, bash, eval`). First line starting with `PASS`/`OK`/`LGTM`/`NONE` passes; anything else injects `<watchdog name=… severity=…>` |
| `instructions`, `option.<label>[.prompt\|.delivery]` | JUDGE backend (selected by declaring $\ge 2$ `option.*` keys) | Cannot be combined with `model`/`tools`/`note`; uses OMP's JUDGE role chain, then the `judge` section's fallback role, to pick one declared lowercase option against the body criteria and injects its `.prompt` (no `.prompt` = silent pass). Errors or 90s timeouts never fall back to the chat reviewer |

- **Cursor persistence and recovery**: each conclusive review writes its cursor to session custom entry `mouriya.omp.watchdog-agent.cursor`; session resume and branch switches rebuild the cursor, cap count since last compaction, and trailing action count from the branch.
- **Slash commands and 3-round authoring flow**:
  - `/watchdog [list]` inspects status; `/watchdog on|off <name> [session|global]` toggles the session override or rewrites `enabled` in the file; `/watchdog rm <name>` deletes after confirmation.
  - `/watchdog add <request>` and `/watchdog edit <name> [change]` write nothing themselves; they send an `attribution: "agent"` prompt to the active model (with full schema defaults, project/global paths, current default reviewer model and existing names) enforcing a 3-round flow without `ask`: **1. Draft (expected behavior, settings table, full file text and absolute path; no disk write) → 2. Revise → 3. Write only after explicit user confirmation**. Any `write`/`edit` touching `WATCHDOG-*.md` appends a live recognition status line (recognized / unrecognized with reason / valid but outside search path / deleted) to the tool result.

### turn-judge

After every turn that the model ended itself (`stopReason: "stop"` with non-empty text) in a session a discovered `TURN-JUDGE-<label>.md` file targets, evaluates that file with one JUDGE request (the repository ships `TURN-JUDGE-gpt-talk-only.md`, below; files a machine writes itself stay machine-owned; silent when no file applies or neither the JUDGE role chain nor the fallback role resolves a model). With `task.structured` off (OMP's default), a subagent's final report and its replies to IRC wakes are such turns.

- **Scope**: `target` uses `watchdog-agent`'s grammar — a comma list of `main`, `subagents` (aliases `subagent`/`sub`/`subs`), `*` (aliases `all`/`any`) or a subagent definition name / registry id such as `task:mid` — and defaults to `main` when absent; `model` and `provider` are unanchored JavaScript regexes, as in `append-system-model`, tested against the judged message's own `model`/`provider`; `skipTools` is a comma list of tool names, and a turn that called any of them is not judged by the file (for `wt` and `harness_restart`, which only run after the turn ends). A file applies only when its target covers the session, every regex it sets matches and no skip tool was called; a file that does not apply makes no JUDGE request. An empty `target`, `skipTools` or regex, or an invalid regex, makes the file invalid (warned once per process).
- **Frontmatter and input state**: `name`, `enabled` (default `true`), `target`, `model`, `provider`, `skipTools`, `maxChars` (default `30000`), `option.<label>` ($\ge 2$ options; labels may be Chinese without `.` or whitespace), `option.<label>.prompt`, and required `option.<label>.threshold` $\in (0, 1]$ whenever `.prompt` is set; the body is the question. JUDGE receives `{ 时间线: [{ 类型, 内容 }], 本轮回复 }`. `时间线` covers only the work the judged turn belongs to: it starts at the last human prompt on the branch and lists, in the order things happened, `用户说` (that prompt: non-synthetic, in the main session `attribution: "user"`, in a subagent any, its assignment included), `提醒` (later non-human prompts such as harness reminders or a turn-judge prompt, first 400 characters each), `模型想` (thinking text: GPT's and Gemini's reasoning summaries, Claude's reasoning; redacted blocks are left out), `模型说` (assistant text), and `模型调用工具` (`name：intent`, the harness intent the call carries; arguments and results are left out). The judged message's own thinking closes the `时间线` and its text is `本轮回复`; past `maxChars` characters, the oldest entries after `用户说` are dropped whole. `skipTools` counts the tool calls after the model's previous `stop` ending, so a turn a nudge or reminder starts counts from zero.
- **Shipped `TURN-JUDGE-gpt-talk-only.md`**: `target: main`, `model: (^|/)[Gg][Pp][Tt]` (any GPT model), `skipTools: wt, harness_restart`; options `做完在汇报` / `只需文字` / `只说不做`, and `只说不做` at $\ge 0.8$ types a prompt telling the model to keep working with tools instead of announcing or apologising. It targets the GPT main-agent habit of ending a turn with words while the assigned work is unfinished; listing a plan, proposal or options for the user to confirm counts as legitimate text. Calibrated on the 329 GPT main-session turns from 2026-10-10 to 2026-10-25 that `skipTools` leaves, under the JUDGE role `futureppo-jev/decision-model-preview`: it catches endings that apologise or restate the requirement and stop (6 of 19 hand-labelled positives), flags none of 23 labelled negatives or 287 unlabelled turns, and misses mid-task status stops such as "正在进入示例运行验证"; the labels are the maintainer's own reading of the transcripts, not a held-out set, and the judge model is whatever the machine's JUDGE role is.
- **Main-session trigger and merged notification**: judgments run in the background. Among options carrying a `.prompt` whose probability reaches their `.threshold`, the highest-probability option sends its prompt with `attribution: "agent"` (turns caused by that prompt are judged too, uncapped); untriggered files merge their verdicts into a single UI info notification `turn-judge <name>：<chosen label>（<probabilities>）` once all judgments for the turn return. If the user types or switches sessions/branches before the verdict returns, only the info notification is shown.
- **Subagent trigger**: the `message_end` handler awaits the judgments under one 20 s budget (OMP stops waiting for an extension handler at 30 s), so the task executor does not collect the result before them. When files trigger in time and no newer message has entered the branch, it waits for the subagent to go idle, sends all triggered prompts as one `attribution: "agent"` message that starts a new turn, and returns once that turn is admitted. The reply to it replaces the judged report as the result the parent receives, so a subagent prompt should ask for the complete revised report; a file that keeps triggering keeps the subagent from returning. Late or stale verdicts are reported, not sent. Subagents have no UI, so their verdicts and warnings go to the OMP log only.

### lang-nag

Main session only. At `agent_end`, takes the first 200 characters of the last paragraph of the last non-empty reply and asks the JUDGE role chain above one choice question: is it mainly in `language`? (repository values: `language: 中文`, `instruction: 说中文`, read at session start or switch; no judge candidate, or every candidate failing, means no nag). On a mismatch, prepends `"说中文\n\n"` to the user's next real input (slash commands clear the pending verdict; if detection is still running when the user sends a message, it is aborted and the message goes out unchanged).

---

## Host Resource Guard, Interactive Tools and Session Control

### child-memory-warning

macOS (Darwin) only, enabled in both full and light mode. The first main session's `session_start` opens system LP64 `libproc`/`sysctl` via Bun FFI and starts one process-wide 2 s sampling timer (main-session switches refresh the delivery context; main shutdown clears the timer before closing the native handle; non-Darwin platforms log one `未启用` info entry):

- **Physical footprint accounting and orphan tracking**: reads `ri_phys_footprint` from `proc_pid_rusage` (including compressed and swapped memory, not RSS) and identifies processes by `PID + kernel start time`. Validates the process table across two passes to track all descendants of the OMP process and process groups led by observed descendants; previously observed descendants remain owned after reparenting (`PPID === 1` orphans) until exit (only short-lived processes born and orphaned entirely between two scans without a surviving group anchor cannot be attributed).
- **Threshold configuration**: `omomp.yml#child-memory-warning.thresholdGiB` (repository value `4`, any positive number, fractions allowed). The main session cwd's `.omp/omomp.*` section wins over the agent-dir one; both are re-read every scan, so edits apply from the next 2 s sample without restart. Without a valid section, ownership tracking continues but alerts pause; each new config problem (missing or invalid section, skipped project copy) logs one warning and shows one main-UI warning.
- **Alert delivery**: when any owned descendant's `phys_footprint` exceeds the threshold, alerts once per process identity (one main-UI warning plus one `attribution: "agent"` message to the main agent with PID, PPID, orphan status, GiB/bytes, the threshold and 240-char command); **it only warns and never signals or kills processes**.

### input-polish

Main interactive TUI only. Pressing the configured chord (default `Ctrl+Enter`, or `alt+enter` for terminals without Kitty keyboard protocol / `modifyOtherKeys`) intercepts the key in a raw terminal-input listener and rewrites the draft with the OMP model role `@input-polish` (assigned in `/model`; thinking per the role entry's `:level`, off otherwise), then the role named by `fallbackRole` (repository values in `omomp.yml#input-polish`: `key: ctrl+enter`, `instruction: 在不改变原意的前提下，改写到听起来会让人更加想努力、能激动人心，但不要太夸张。`, `fallbackRole: smol`) in a tool-less `taskDepth: 1` in-memory helper session, and streams the rewrite into a read-only overlay over the input box while keeping the original draft in the editor; a model that fails moves the polish to the next model of the chain with the preview cleared:

- **Keys and placeholder fidelity**: swallows other keys during streaming and preview; pressing `Enter` after completion closes the overlay, replaces the editor text with the rewrite and lets that same `Enter` submit through the normal editor path; `Esc` / `Ctrl+C` aborts and closes the overlay leaving the editor untouched. Blank drafts and drafts starting with `/`, `!` or `$` are not polished. Any rewrite that alters the count or identity of `[Paste #N …]` or `[Image #N …]` placeholders is rejected and shown as an error in the overlay.

### doc-polish

Registers the `polish_doc` tool and `/polish-doc <path…>` command to restructure and polish `.md` / `.txt` documents for engineer readability without changing their meaning. **It never modifies the source file**, writing its outputs under `/tmp/doc-polish/<timestamp>-<filename>/`: a copy of the original, the split index `split.json`, and the grouped before/after/comment review `review.md`:

- **Three-stage restricted in-memory subagent pipeline** (`taskDepth: 1`, extensions disabled to prevent recursion):
  1. **Split**: holds only `[read, write]`, reads the source file itself, and writes a block index with start/end lines plus a keyword glossary.
  2. **Polish**: tool-less; runs batches of $\le 5000$ code points (an overlong block runs alone, never truncated) with only the batch's relevant glossary terms in parallel, returning polished blocks and glossary-change records; union-find over `sourceIndices` then regroups merged paragraphs.
  3. **Check**: tool-less; verifies meaning preservation per regrouped block at the same concurrency limit.
- **Models and machine-local config**: each stage takes its models from its OMP model role, assigned in `/model`: `@doc-polish.split`, `@doc-polish.polish`, `@doc-polish.check`, each followed by the role named by `fallbackRole` in the `doc-polish` section of `omomp.*` (project `.omp/omomp.*` before agent dir). A role entry's `:level` sets the stage's thinking level; `@doc-polish.check` without a model of its own uses the split chain; concurrency defaults to `6`. The `doc-polish` section is machine-local (not in the repo; `/update-omp` asks before creating a missing one); a typical machine configuration is:

```yaml
doc-polish:
  fallbackRole: default
  concurrency: 8
```

- **Failure policy and receiver contract**: resolves the split and polish roles before doing any work (erroring immediately without writing `/tmp/doc-polish/` when one resolves no model, naming the roles to assign); a sub-agent request whose model fails moves to the next model of its role chain (the split index is cleared before each attempt), and keeps original text for any batch whose polish output cannot be parsed. `review.md` records the models that actually answered each stage. The returned tool result / prompt carries a hard requirement: the receiving main agent must handle the review personally and read every `review.md` in full without delegating, paging or truncating.

### wt-tool

Enables `wt` and `wt_remove` in the interactive TUI's main session only (`defaultInactive`, activated on main `session_start`/`session_switch`). Because OMP's `/wt` and `/move` refuse to run while streaming and `ExtensionAPI` does not expose `InteractiveMode`, the extension swaps `InteractiveMode.prototype.setEditorComponent` during one synchronous `ctx.ui.setEditorComponent(undefined)` call to capture the live `InteractiveMode` instance, queues one request at a time, and tells the model to end its turn immediately; once the turn truly ends (`agent_end` without `willContinue`) and the session is idle, it invokes `executeBuiltinSlashCommand` on the live TUI instance (temporarily wrapping `showError`/`showWarning`/`showStatus`/`present` to capture output while suppressing `editor.addToHistory`, then sending the outcome back as an `attribution: "agent"` message that starts a new turn; pressing Esc cancels the queued request):

- **`wt` (create and move into a linked worktree)**: runs built-in `/wt [<branch>]`. When the session is already inside a linked worktree, the first call **creates nothing** and returns the current worktree path, branch, HEAD, uncommitted count, main checkout path, consequences of forcing a nested fork and a `confirm` hash; only a second call with that `confirm` value queues `/wt`.
- **`wt_remove` (move back to the main checkout and force-remove the linked worktree, keeping the branch)**: requires two calls:
  1. **Without `confirm` (read-only check)**: reports the worktree and main checkout paths, verdict (`SAFE` / `UNSAFE` / `BLOCKED`), files that removal would permanently delete (staged, unstaged, untracked and ignored, up to 50 per category with totals), branch commits unreachable from the main checkout's HEAD (kept on the branch), blockers (running background jobs, running task subagents, or live task subagents whose cwd is inside the worktree), and a deterministic `confirm` hash bound to the worktree fingerprint (HEAD, branch tip, porcelain status, changed-file size/mtime and ignored-entry list).
  2. **With `confirm` (execute)**: re-verifies the fingerprint and blockers before queueing; when idle, executes **re-check → `/move <main checkout>` → verify new cwd → re-check → `worktreeRemove(path, true)`**, stopping immediately and reporting the exact stage if anything changed or blocked.

### harness-restart

Enables `harness_restart` in the interactive TUI's main session (retained in light mode). Uses the same queue and `InteractiveMode` capture pattern as `wt-tool`: the tool call queues the request and asks the model to end its turn; once idle, right before calling `InteractiveMode.restart()`, it appends a durable custom session entry `mouriya.omp.harness-restart.request` (`reason` and timestamp); when the restarted process resumes the session, `session_start` detects the marker and sends `"Harness restart completed (<time>). Reason was: <reason>. Continue what you were doing."` with `attribution: "agent"`.

### commandcode-model-spec

Fixes two host auth failures when `--model` selects a `commandcode` model at startup: ① **cache shadowing** (`models.db` caches discovered commandcode models as `openai-completions`/`anthropic-messages`, so `--model` uses the host transport instead of the plugin's `commandcode-custom` and gets 401); ② **prefix collision** (ids like `google/gemini-3.5-flash-lite` resolve to a credential-less built-in `google` provider). At `session_start`, the extension reads `<agentDir>/commandcode-models.json` (or `COMMANDCODE_MODELS_CACHE`), and when the selected model belongs to the catalog with `api !== "commandcode-custom"` (and is not an available credentialed built-in model), calls `setModel` to rebind it to the live model registered by `pi-commandcode-provider`.

### antigravity-wire-profiles

Makes every Antigravity (`google-antigravity`) request take `generationConfig.maxOutputTokens` and `labels.model_enum` from the backend model list instead of OMP's hand-captured `ANTIGRAVITY_MODEL_WIRE_PROFILES` table (`@oh-my-pi/pi-catalog/wire/gemini-headers`). The provider replaces the caller's `maxTokens` only for wire ids in that table; ids added after it was captured (`gemini-4-argon-*`) are missing, so compaction's short summary went out with 512 output tokens at high thinking and failed with `thought-only response without final output`. At the root session's `session_start` (awaited, 20 s budget; `before_agent_start` awaits the same load) the extension calls `POST <baseUrl>/v1internal:fetchAvailableModels` with the session's credential and every stored Antigravity account, unions the served rows (not internal or disabled, positive integer `maxOutputTokens`) and writes them into the exported table in place. It only adds or overwrites entries and never deletes one, because one account's roster does not prove another account lacks a model. The provider reads the table per request, so agent turns, compaction and in-process subagents all use the backend values, and a listed wire id ignores the caller's `maxTokens` (the table's existing contract). When no account yields a usable list, the table keeps its previous contents, a warning goes to the log and the main UI, and the next root session start retries.

### omomp-lang

Chooses the language (`en` or `zh`) of every person-facing string the local extensions and the omp plugins show: notifications, widgets, status entries, dialogs, overlays, command and shortcut descriptions, tool labels and renderers. Text sent to the model (prompts, steers, tool descriptions, tool-result content), logger lines and user data keep their wording.

- **Setting**: `omomp.yml#omomp-lang.language` (repository value `zh`), read from the agent-dir `omomp.*` only: the language belongs to the process, so a project `.omp/` copy is not read. A change applies from the next OMP start.
- **Export**: at module load the extension sets `process.env.OMOMP_LANG` to that value unless the launch environment already names a language (`OMOMP_LANG=en omp`, or a Tern pane that omp-playbooks starts with its own language); an explicit launch value wins. Child processes inherit the variable. The first main session reports invalid `omomp.*` copies once (log + UI warning).
- **Resolution** (`_shared/i18n.ts` `tr(en, zh)`, called where the text is produced): `OMOMP_LANG` when `en`/`zh` (any case) → the `omomp-lang` section → the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG` (`zh…` means Chinese) → English. Every consumer reads the section itself, not only the exported variable, because OMP imports extension modules concurrently and, in interactive mode, binds extensions that register no provider, shortcut, composer shape or file fallback only after the first frame (`startup-deferral.ts`); text produced before `omomp-lang` loads still follows `omomp.yml`.
- **Plugins**: the OMP-only plugins (`omp-todo-more`, `omp-playbooks`, `omp-thinking-translator`, `omp-codex-image-gen`, `omp-remote-build`) resolve the same chain in their own i18n module. The Pi-compatible plugins (`omp-unified-exec`, `pi-bansos`) read only the environment, so text they register before `omomp-lang` loads follows the locale. omp-playbooks hands its language to the Tern panes it starts (`env OMOMP_LANG=…`). The npm plugins `pi-commandcode-provider` and `pi-package-search` are third-party and show English only.

## Local Extensions Index

| # | Extension directory | Wiki section | Scope | Light mode | Config source (`omomp.yml` section or sibling file) |
|---|---|---|---|---|---|
| 1 | `system-prompt-replace` | [Prompts & Context](prompts-and-context.md#system-prompt-replace) | Main + Sub | No | `omomp.yml#system-prompt-replace` (repo-managed) |
| 2 | `append-system-model` | [Prompts & Context](prompts-and-context.md#append-system-model) | Main + Sub | Yes | `APPEND_SYSTEM_MODEL.md` (machine-owned) |
| 3 | `repo-rules` | [Prompts & Context](prompts-and-context.md#repo-rules) | Main + Sub | Yes | Scans `.claude/rules`, `.agents/rules`, `.pi/rules` (cwd up to the git root), `~/.claude/rules`, and OMP's native rules for `paths` |
| 4 | `fork-task` | [Prompts & Context](prompts-and-context.md#fork-task) | Main + Sub | No | No config file |
| 5 | `model-compaction` | [Prompts & Context](prompts-and-context.md#model-compaction) | Main writes / Sub reads | Yes | `omomp.yml#model-compaction` (machine-owned) |
| 6 | `user-prompt-inject` | [Agents & Advisors](agents.md#user-prompt-inject) | Subagents | No | `PROMPT-INJECT-*.md` (repo ships `user-goal.md`) |
| 7 | `isolation-nudge` | [Hard Gates](#isolation-nudge) | Main + Sub | No | No config file |
| 8 | `task-split-check` | [Hard Gates](#task-split-check) | Main (`split`) / Main+Sub (`report-limit`) | No | `omomp.yml#task-split-check` (repo-managed) |
| 9 | `task-completion-judge` | [Hard Gates](#task-completion-judge) | `task:low/mid/free` | No | `omomp.yml#task-completion-judge` (repo-managed) |
| 10 | `tool-policy-nag` | [Sideband Judges](#tool-policy-nag) | Main | No | `omomp.yml#tool-policy-nag` + `INTENT-policy.md` (repo-managed) |
| 11 | `watchdog-agent` | [Sideband Judges](#watchdog-agent) | Main + Sub | No | `WATCHDOG-*.md` (machine-owned) |
| 12 | `turn-judge` | [Sideband Judges](#turn-judge) | Main + Sub (per file `target`) | No | `TURN-JUDGE-*.md` (`gpt-talk-only` repo-managed; others machine-authored) |
| 13 | `lang-nag` | [Sideband Judges](#lang-nag) | Main | No | `omomp.yml#lang-nag` (repo-managed) |
| 14 | `child-memory-warning` | [Host & TUI](#child-memory-warning) | Main process-wide | Yes | `omomp.yml#child-memory-warning` (repo-managed) |
| 15 | `input-polish` | [Host & TUI](#input-polish) | Main TUI | Yes | `omomp.yml#input-polish` (repo-managed) |
| 16 | `doc-polish` | [Host & TUI](#doc-polish) | Main + Sub | No | `omomp.yml#doc-polish` (machine-owned) |
| 17 | `wt-tool` | [Host & TUI](#wt-tool) | Main TUI | Yes | No config file |
| 18 | `harness-restart` | [Host & TUI](#harness-restart) | Main TUI | Yes | No config file |
| 19 | `commandcode-model-spec` | [Host & TUI](#commandcode-model-spec) | Main + Sub | Yes | Reads machine-local `commandcode-models.json` |
| 20 | `antigravity-wire-profiles` | [Host & TUI](#antigravity-wire-profiles) | Root main (process-wide table) | Yes | Backend `fetchAvailableModels` list; no file |
| 21 | `omp-config-autoupdate` | [Operations](operations.md#omp-config-autoupdate) | Root main | Yes | `omomp.yml#omp-config-autoupdate` (machine-owned) |
| 22 | `omomp-lang` | [Host & TUI](#omomp-lang) | Process-wide (module load) | Yes | `omomp.yml#omomp-lang` (repo-managed) |
