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
| 10 | `tool-policy-nag` | [tool-policy-nag](#tool-policy-nag) | Main (`pty` lane: Main + Sub) | No | `omomp.yml#tool-policy-nag` + `INTENT-policy.md` (repo) |
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
| 23 | `tool-topics` | [tool-topics](#tool-topics) | Main + Sub (prompt); process-wide (`tool://` scheme) | Yes | `TOPIC-*.md` / `SURFACE-*.md` beside it (repo) |
| 24 | `tool-topic-injection` | [tool-topic-injection](#tool-topic-injection) | Main + Sub | Yes | `omomp.yml#tool-topic-injection` (repo) |
| 25 | `session-urls` | [session-urls](#session-urls) | Process-wide (`session://` scheme) | Yes | Reads the session files, recap journal and prompt history; no config |
| 26 | `delete-guard` | [delete-guard](#delete-guard) | Main + Sub | Yes | None |

---

## Task Dispatch and Yield Checks

### isolation-nudge

Source: `agent/extensions/isolation-nudge/`.

Runs at `tool_call` on `task` in main and subagent sessions; `fork_task` is not checked by this extension. Forks with `agent` default to isolation, while forks without it default to shared cwd, so concurrent fork writers must explicitly set `isolated: true`. When a `task` call would leave $\ge 2$ write-capable agents (`task:*`, built-in `task`, omitted `agent`, `m1`, etc., counting both the current batch and running shared writer jobs from the same session) in the same working directory with at least one item leaving `isolated` unset, it blocks the call once per SHA-256 of the item's `task` text and asks for `isolated: true` on writers and `isolated: false` on read-only items. A second call with the same `task` text passes.

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

Source: `agent/extensions/tool-policy-nag/`. The `form`, `intent` and `risk` lanes run in the main session only; the `pty` lane runs in main and sub sessions.

Inspects `bash`, `bash_bg`, `exec_command` (including writes to `xd://bash`, `xd://bash_bg`, `xd://exec_command`), and `eval` at `tool_call`. The `pty` lane refuses calls before they run; the other lanes only send reminders and never block a tool call. By design, the reminder lanes use tool-routing violations as an observable signal that the model has drifted from the static system prompt (frontier models, Claude Opus included, frequently ignore static system prompts in long sessions): `form.prompt` is injected not as a system notice, but as a user-role steer phrased as a direct user observation, which receives higher instruction priority across opaque provider schemas and pulls the model back to the system prompt. The heuristic detector intentionally does not minimize false positives: line-by-line inspection of post-trigger thinking blocks shows that false triggers cost only a small number of self-reflection tokens without other adverse effects.

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
  pty: {}
```

- **`pty` lane (`pty.ts`, blocking, main and sub sessions, no model)**: runs first in `tool_call`, under either `detector`, when the section has a `pty` object and the calling session's active tools (`pi.getActiveTools()`) include `exec_command`; without either it lets everything through. It refuses, before any process starts, a `bash` call (direct, through `xd://bash` — refused at the outer `write` — or through the eval `tool.bash` bridge; `pty: true` does not exempt it) or an eval cell that runs one of three kinds of command:
  - **passthrough** — handed to another machine, container, user or shell: `ssh` (not `-G`/`-V`/`-O`), `mosh`, `vagrant ssh`, `gcloud compute ssh`, `aws ssm start-session`, `docker`/`podman`/`nerdctl` `exec`/`run`, `docker compose`/`docker-compose` `exec`/`run`, `kubectl` `exec`/`run`/`debug`/`attach`, `incus`/`lxc` `exec`/`shell`, `pct exec`/`enter`, `qm guest exec`/`terminal`, `orb`/`orbctl` with `-m` or `run`/`shell` or nothing, `limactl shell`, `multipass exec`/`shell`, `distrobox enter`, `nsenter`, `su`, `bash`/`zsh`/`sh`/`dash`/`ksh`/`fish -c`, `pwsh`/`powershell -c`/`-Command`;
  - **terminal** — needs a terminal or stops at a prompt: a bare `bash`/`zsh`/`sh`/`fish`/`python`/`python3`/`node`/`irb`/`ghci` with nothing on stdin; `psql`/`mysql`/`mariadb`/`redis-cli`/`sqlite3`/`mongosh` without a query, file or stdin; `vim`/`vi`/`nvim`/`nano`/`emacs` (not `--batch`/`--headless`), `htop`, `btop`, `top` (not `-b`/`-l`), `lazygit`, `lazydocker`, `tig`, `k9s`; `git rebase -i`, `git add -p`/`-i`, `git commit` without `-m`/`-F`/`-C`/`--no-edit`; `expect`, `script`, `unbuffer`; `sudo`/`doas`/`run0` that may prompt (`sudo -n`/`-S` and `doas -n` are judged by the command they run); `passwd`; `gh auth login` without `--with-token`; `pexpect` or `pty.spawn`/`pty.fork` in a Python cell;
  - **open-ended** — does not end on its own or waits on an outside condition: `tail -f`/`-F`, `journalctl -f`, `docker`/`podman logs -f`, `docker compose logs -f`, `kubectl logs -f`, `kubectl get -w`, `watch`, `gh run watch`, `ping` without `-c`, `docker compose up` without `-d`/`--wait`, `nohup`, `setsid`, a pipeline ending in a lone `&`, `sleep` in a `while`/`until`/`for` loop body.

  Any simple command of the line decides — every pipeline stage, `$(…)` body, `;`/`&&`/`||` link, and the command behind `env`/`timeout`/`nice`/`nohup`/`stdbuf`/`time`/`command`/`exec` — and the first hit in source order names the category. Eval cells count only launches spelled under their own names with literal arguments: py `subprocess.run`/`call`/`check_call`/`check_output`/`Popen`, `os.system`, `os.popen`, `!cmd` and `%%bash`; js `Bun.$` without `${}`, `Bun.spawn`/`spawnSync`, child_process `exec`/`execSync`/`spawn`/`spawnSync`/`execFile`/`execFileSync`; a hit refuses the whole cell. It lets through what it cannot read: an unterminated line, a program word from `$…`, a program run by `xargs`, `find -exec` or `parallel`, the shell's `eval`, a renamed import, a variable, concatenation or interpolation, an eval cell that does not parse. The refusal is the tool result: the category, the program, the call, `xd://exec_command`, the category's rewrite (passthrough: `ssh host bash -s <<'EOF'` with the script as the quoted here-document, or an interactive `cmd` driven by `write_stdin`, or the `shell` parameter, or `read ssh://`; terminal: drive it with `write_stdin`/`monitor`, the human types passwords in the terminal page; open-ended: start it there and wait with `monitor`), and a note that this is entry routing, not a risk judgment. A refused call reaches no other lane: nothing is counted, reminded, judged or marked. `exec_command` itself is never judged. The rules are the closed registry `RULES` in `pty.ts`; `ci/tool-policy-nag-pty.test.ts` holds a hit and a miss for each. Light mode disables the whole extension, so the lane does not run there.
- **`detector: heuristic`**: requires `form` and ignores `intent` (no JUDGE calls, `INTENT-policy.md` not read). Sets `bashInterceptor.enabled = false` in the main session's runtime settings layer before inspecting calls (subagents inherit that runtime setting too), and clears the override when `detector` changes or at `session_shutdown`.
- **`detector: jev`**: requires `intent` and leaves `bashInterceptor.enabled` as configured in `config.yml` (while the interceptor is on, the `form`, `intent` and `risk` lanes skip `bash` calls because the interceptor already rejects them; `exec_command`, `bash_bg`, and `eval` are still checked, and the `pty` lane runs before that skip). An optional `form` block counts alongside `intent` and sends its `prompt` only while `intent` cannot run (`INTENT-policy.md` missing/invalid/disabled, or no judge model resolved); judge failures or 90 s timeouts log one warning per reason and do not trigger `form`.
- **`form` lane (command parser and counter)**:
  - Parses pipes, `;`/`&&`/`||`, quotes, heredocs, `$(…)`/backticks, and redirects (`>|`, `&>`), unwrapping `NAME=value` prefixes, shell keywords (`if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`), and wrapper commands (`timeout`, `env`, `nice`, `stdbuf`, `time`, `nohup`, `command`, `exec`, `builtin`, `xargs`); skips `sudo`/`doas`/`su`/`ssh` and inspects literal `bash|sh|zsh|dash -c '…'`, `eval '…'`, and `find -exec … ;` bodies in place.
  - Counts six shell categories: listing (`ls`, `tree`, `fd`, actionless `find`, `rg --files`, `ag -g`), reading (`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`, `sed -n`, awk line/range selectors, single-file `jq`, single read-only `sqlite3` queries and `.tables`/`.schema`, `tar -t`/`-xO`, `unzip -l`/`-p`), searching (`grep` with files or `-r`, `rg`/`ag`/`ack` unless reading piped stdin, awk `/re/`, worktree `git grep`), editing (`sed -i`, `perl -i`, `awk -i inplace`, `mv`), writing literal content (`echo`/`printf`/heredoc `cat` redirected to a file or piped to `tee`), and inline scripts (`node`/`bun`/`deno`/`python`/`ruby` with `-e`/`-c`/`-p`/`--eval` or `-` stdin); plus `eval` file calls (`Path.read_text`, `open`, `glob`, `os.listdir`, `readFileSync`, `Bun.file`, `readdir`, `Bun.Glob`).
  - Exemptions: listing/reading/searching captured in `$(…)`, piped into `wc`/`uniq -c`/`grep -c`, passed to `xargs`, or used as `grep -q` in an `if`/`while` test; `/dev/*` targets; and `tail -f`, `locate`, `find` with `-delete`/`-exec rm`, `git ls-files`, or pathless `grep` on stdin.
  - Silently records the first `form.afterHits` (`3`) hits; after that, steers `form.prompt` with a UI warning up to `form.maxNags` (`3`) times per context until the next compaction, `/clear`, or `branch_summary` (raising `maxNags` re-arms immediately). Persists state in session custom entry `mouriya.omp.tool-policy-nag.state`.
- **`intent` lane (`INTENT-policy.md`)**: sends one non-blocking JUDGE `choice` request per call across 11 options (`list`, `read`, `search`, `edit`, `write`, `move`, `eval`, `ast`, `shell`, `mixed`, `none`). When a shell call selects anything other than `none` (or `eval` selects anything other than `eval`/`none`) with probability $\ge$ `threshold` (`0.5`), injects an `aside` reminder at the next step boundary naming the intent title, the built-in tool to use, and the call text. Which shell entry a command needs is the `pty` lane's question, not an option here.
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
- **Frontmatter and JUDGE input**: `name`, `enabled` (default `true`), `target`, `model`, `provider`, `skipTools`, `maxChars` (default `30000`), `option.<label>` ($\ge 2$ options, no `.` or whitespace), `option.<label>.prompt`, and required `option.<label>.threshold` $\in (0, 1]$ when `.prompt` is set; the file body is the question. Sends `{ 时间线: [{ 类型, 内容 }], 本轮回复 }` to `openJudge`. `时间线` starts at the last human prompt on the branch and lists `用户说`, `用户在ask中回答` (what the user chose or typed in an `ask` call, one `question → answer` line per answered question, read from the tool result by `_shared/ask-answers.ts`; a cancelled, refused or unanswered ask adds nothing), `提醒` (first 400 chars each), `模型想` (reasoning text, excluding redacted blocks), `模型说`, and `模型调用工具` (`name：intent`, without arguments or results), dropping the oldest entries after `用户说` when total length exceeds `maxChars`.
- **`TURN-JUDGE-gpt-talk-only.md`**: `target: main`, `model: (^|/)[Gg][Pp][Tt]`, `skipTools: wt, harness_restart`; options `做完在汇报`, `只需文字`, and `只说不做` (`threshold: 0.8`), which sends a prompt telling the model to continue working with tools when a GPT main agent stops in prose before finishing assigned work, including when it only restates an approach the user picked in `ask`. The user's `ask` answers count as the user speaking: confirming a decision the user made in `ask` is a proper text-only end when deciding was all the user asked for. The threshold was calibrated on 329 GPT main-session turns (2026-10-10 to 2026-10-25) under `futureppo-jev/decision-model-preview`, before the ask answers entered the timeline: it caught 6 of 19 hand-labelled premature stops with 0 false positives across 23 labelled negatives and 287 unlabelled turns.
- **Main session vs subagent delivery**: in the main session, judgments run in the background; the highest-probability triggered option sends its `.prompt` with `attribution: "agent"` (unless the user already typed or switched branches), while untriggered files merge into one `turn-judge <name>：<label>（<probabilities>）` UI notification. In a subagent, `message_end` awaits judgments for up to 20 s, sends triggered prompts as one `attribution: "agent"` message once idle, and lets the new turn's reply replace the subagent report returned to the parent (verdicts and warnings go to the OMP log).

### lang-nag

Source: `agent/extensions/lang-nag/`. Main session only.

At `agent_end`, takes the first 200 characters of the last paragraph of the last non-empty reply and asks `openJudge` whether it is written in `omomp.yml#lang-nag.language` (shipped: `language: 中文`, `instruction: 说中文`, read at session start or switch). On mismatch, prepends `"说中文\n\n"` to the user's next input (slash commands clear the pending flag; if the user sends a message before the check finishes, the check is aborted and the message is sent unchanged).

---

## Deletion

### delete-guard

Source: `agent/extensions/delete-guard/`. Main and sub sessions, full and light mode; no config, no switch, independent of `tools.approvalMode` and `bashInterceptor`.

**Guard.** A `tool_call` hook judges every `bash` call: the loop's own calls, writes to `xd://bash`, and the nested `bash` event omp emits for such a write (each event is judged; either one blocking stops the call). The bash tool runs in the embedded brush shell on every platform, so the text is classified in the posix dialect. A blocked call does not run and returns `delete-guard: …` naming the rule (deletion command or non-literal command) and the command text; it points to `delete` when the session's active tools include it, otherwise it says the session cannot delete. A guard error is logged as a warning and blocks the call.

- **What is classified**: every command the text would run, including `$(…)`, backticks, `<(…)`/`>(…)`, substitutions in unquoted here-document bodies, literal `sh|bash|zsh|dash|ksh -c '…'` scripts, a quoted here-document read by a shell, and literal `eval`, `trap` and `alias` bodies, up to 8 nested levels. Text that cannot be parsed (an unterminated quote, substitution or group) is blocked.
- **Deletion commands**, whatever their arguments: `rm`, `unlink`, `rmdir`, `shred` (lowercased, basename of a path, quotes and backslashes removed: `RM`, `/bin/rm`, `\rm`), also behind `sudo`, `doas`, `command`, `builtin`, `exec`, `env`, `nice`, `nohup`, `time`, `timeout`, `stdbuf`, `busybox` and `xargs` (their options are skipped by table; an unknown option is read both with and without a value and blocks if either reading reaches a deletion), `find -delete` and `find -exec|-execdir|-ok|-okdir`.
- **Non-literal commands**: a command name from an expansion, substitution, glob or brace pattern (`$CMD x`, `$(printf rm) x`); a non-literal nested shell, `eval`, `trap` or `alias` script (`sh -c "$s"`); a shell argument from an expansion (`bash "$FLAGS"`, which may be `-c` or `-s`); `env -S`; a shell reading its script from stdin other than a quoted here-document (`… | sh`, a here-string, an unquoted here-document, no script at all). An unknown long shell option is read both with and without a value. Substitutions are found in here-document bodies on any descriptor, and inside double quotes `'` does not quote (`"${x:-'$(…)'}"` runs the substitution).
- **Nested Windows shells** (any platform; on Windows they are how cmd and PowerShell are reached from brush): `powershell|pwsh` (`.exe`, any path) with `-Command`/`-c` or a positional script is classified as PowerShell — `Remove-Item` and its aliases `rm`, `ri`, `del`, `erase`, `rd`, `rmdir`, `[System.IO.File]::Delete`, `[IO.Directory]::Delete` and any `.Delete(` call are deletions; `& $cmd`, `Invoke-Expression`/`iex`, `-EncodedCommand` and a script read from stdin are non-literal; `-File` runs a script file and passes. The command after `=` (`$x=Remove-Item x`), `return`/`throw`/`exit`, `&` or `.` is classified like any other, and a control block's `}` ends its statement. `cmd` (`.exe`) with `/c` or `/k` is classified as cmd — `del`, `erase`, `rd`, `rmdir`, also inside `for … do`, `if …` and `(…)` blocks and after `start` (its `/d`, `/node`, `/affinity` and `/machine` values skipped), are deletions; a command name with `%VAR%`/`!VAR!` is non-literal; `cmd` without `/c`/`/k` reads stdin and is non-literal. Case never matters, and scripts nest across dialects.
- **Passes**: words that are only arguments (`echo rm -rf /`, `git rm`, `npm rm`), expansions in arguments (`ls $HOME`), literal nested scripts that delete nothing, literal script files (`bash x.sh`, `sh < x.sh`, `source`), `-n` syntax checks (undone by `+n`), and `--version`/`--help`.
- **Not covered**: `exec_command`, programs with their own deletion semantics (`git clean`, `rsync --delete`), the contents of script files, and aliases or functions the bash tool sources from the user's shell rc.

**Eval.** The same hook judges `eval` cells by their text before they run, with the same rules and reasons. A command that is not a literal string (an f-string or template with placeholders, a variable, a concatenation) is blocked as non-literal.

- **Python** (own tokenizer; a cell that cannot be tokenized is blocked): deletion APIs — the names `rmtree`, `removedirs`, `unlink`, `rmdir` wherever code names them (calls, references such as `map(os.unlink, …)`, imports; not strings or comments), and `os.remove` on `os` or an `os` alias, or imported from `os` under any name (`from os import remove as erase`). Shell handoffs — `os.system`, `os.popen`, `subprocess.getoutput|getstatusoutput`, `asyncio.create_subprocess_shell`, any call whose `shell=` is not literally `False` or `None` (`shell=flag` may start a shell), and the kernel's `!cmd`, `x = !cmd` and `%%bash` body — classify the literal command as a script of the system shell: posix on macOS and Linux, cmd (`ComSpec`) on Windows; `%%bash` stays posix. Launches without a shell — `subprocess.run|call|check_call|check_output|Popen` and `asyncio.create_subprocess_exec` — classify a literal argv (a non-literal argv[0] is blocked). The bridge `tool.bash({"command": …})` is classified too. `%time`/`%timeit` arguments, `%%capture`/`%%timeit` bodies, f-string placeholders and the expressions nested in their format specs (`f"{x:{w}}"`) are judged as Python.
- **JavaScript** (omp's own Babel parser with the kernel's options): deletion APIs — `rmSync`, `unlinkSync`, `rmdirSync`, `unlink`, `rmdir` wherever named, `rm` on an fs or fs.promises binding or `require` (`fs.promises` reached through a bound `fs`, `import {promises}` and `const {promises} = require("fs")` included), and `.delete()` on `Bun.file(…)` or a name bound to it. `child_process` `exec`/`execSync` strings are system-shell scripts (cmd on Windows); `spawn`/`spawnSync`/`execFile`/`execFileSync` are argv, or a script when the options may start a shell (`shell` not literally `false`, `null` or `undefined`, or options the code does not spell out); `Bun.spawn`/`Bun.spawnSync` argv, `Bun.$` templates (posix on every platform; any `${}` is non-literal), `tool.bash({command})` and `tool.write` to `xd://bash` are classified. Name tables have no prototype, so `toString` or `hasOwnProperty` are ordinary names.
- **Passes**: argv launches of other programs (`subprocess.run(["ls"])`), `!ls`, `%run`, strings and comments that only mention an API, `list.remove`, `Map.delete`, and any cell without these calls.
- **Not covered**: a generic name (`remove`, `run`, `exec`, `spawn`, `rm`) aliased in an earlier cell (distinctive names are caught whatever the cell), `getattr`-style dynamic access, `os.exec*`/`os.spawn*`/`pty.spawn`, and script files (`%run`, `%load`). A function definition whose body names a deletion API is blocked even when the cell does not call it.

**`delete` tool.** Registered (approval `write`, top-level) on macOS, Linux and Windows; other platforms register no tool, and the guard there says the session cannot delete. Parameters: `paths` (non-empty string array) and `mode` (`"trash"`, the default, or `"permanent"`). The tool description, the `mode` parameter and the guard's reason tell the agent to leave `mode` unset and to set `"permanent"` only when the user explicitly asks for unrecoverable deletion; "delete", "remove", "clean up" or a request phrased as `rm -rf` is not such a request.

- **Literal paths**: no `~`, environment variable or glob expansion; relative paths resolve against the session cwd. `"$HOME"` and `"*.log"` are file names.
- **Validation before any change**: every path is checked first; one refusal refuses the whole call and touches nothing. Refused: empty or blank paths, paths starting with `~`, paths that do not exist, the filesystem root, the home directory and its ancestors, the session cwd and its ancestors. Protected directories are compared by file identity (`dev:ino`), so case variants, firmlinks, bind mounts and symbolic links reaching them are refused; the check covers the path, what its text reaches through links, and a link's target. A protected directory that no longer exists (a removed cwd) is compared by spelling. A path whose `..`, `.` or trailing `/` passes through a symbolic link (`link/../x`, `link/`) reaches a different file than its normalized form and is refused. A link that passes, dangling links included, is deleted as the link itself. On Windows a bare drive (`C:`) is refused; roots are the drive root (`C:\`, `C:/`, and `\` or `/`, which resolve to it), a UNC share root (`\\server\share`) and `\\?\C:\`; spellings are compared case-folded with `\` separators; the home directory is `USERPROFILE`.
- **`trash`**: moves each path to the platform trash, restorable from the file manager. macOS runs `/usr/bin/trash -v <path>` with the path as argv (no shell); if the binary is missing the call fails before touching anything and says `permanent` is only for an explicit request for unrecoverable deletion. Linux implements the [freedesktop.org Trash spec](https://specifications.freedesktop.org/trash-spec/latest/) without `gio` or `trash-cli`: the home trash (`$XDG_DATA_HOME/Trash`, default `~/.local/share/Trash`) for paths on its device, otherwise, on the mount that really holds the path (its parent directory's links resolved), `$topdir/.Trash/$uid` (sticky shared directory) and, when any step there fails (creating its directories, writing the info file or moving the entry), `$topdir/.Trash-$uid`; it writes `files/<name>` and `info/<name>.trashinfo` (`Path=` the URI-escaped original path, absolute in the home trash and relative to the mount in a top-directory trash). A name whose `files/` or `info/` entry already exists becomes `<name>.2`, `<name>.3`, …, so an entry already in the trash is never overwritten. Windows runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` by absolute path with a fixed script that calls `Microsoft.VisualBasic.FileIO.FileSystem` `DeleteFile`/`DeleteDirectory` with `SendToRecycleBin`; the path travels in an environment variable, never in the script text. UNC paths and non-fixed drives (no Recycle Bin) and symbolic links or junctions fail with the same note about `permanent`; a missing `powershell.exe` fails the call before touching anything. A failed move is reported and never falls back to permanent deletion.
- **`permanent`**: deletes recursively and cannot be undone, and only after the user confirms it. Once every path has passed validation and before anything is touched, the tool shows a confirmation listing the resolved paths, on every call (no session-wide grant). A declined, cancelled or aborted dialog, or a session without UI (subagents, `--no-ui` RPC, print mode), deletes nothing and returns an error telling the agent to leave `mode` unset; such sessions can only move paths to the trash.
- **Result**: paths run in order and each gets an `ok` or `failed` line; any failure marks the call as an error, the summary says the `ok` lines took effect, and paths already handled stay handled.

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

OMP's `/wt` and `/move` reject calls while a turn is streaming, and `ExtensionAPI` does not expose `InteractiveMode`. The extension captures the live `InteractiveMode` instance during a synchronous `ctx.ui.setEditorComponent(undefined)` call, queues the tool request, and asks the model to end its turn; once the turn hands control back (`agent_end` without `willContinue`, or with `awaitingAsyncWork` while only background jobs can resume the session) and the session is idle, it runs `executeBuiltinSlashCommand` on the TUI instance and sends the result back as an `attribution: "agent"` message (pressing `Esc` cancels the queued action). A continuation the session schedules itself (stop reminder, retry, compaction) keeps the request queued until a later end:

- **`wt`**: runs `/wt [<branch>]`. If the session is already in a linked worktree, the first call creates nothing and returns the current worktree path, branch, HEAD, uncommitted count, main checkout path, and a `confirm` hash; pass that `confirm` value on a second call to create another worktree. Its description tells the model to propose a worktree when the working tree holds changes it did not make, asking the human first when unsure whether they are interference.
- **`wt_remove`**: requires two calls. Calling without `confirm` runs a read-only check returning the worktree/main paths, `SAFE`/`UNSAFE`/`BLOCKED` status, files that removal would delete (staged, unstaged, untracked, ignored, up to 50 per category with totals), unmerged branch commits (kept on the branch), active job/subagent blockers, and a `confirm` hash bound to the worktree state. Calling with `confirm` re-checks the state when idle, runs `/move <main checkout>`, verifies the new `cwd`, re-checks the state, and calls `worktreeRemove(path, true)`, stopping immediately if anything changed.

### harness-restart

Source: `agent/extensions/harness-restart/`. Main interactive TUI only (enabled in light mode).

Queues a restart using the same idle-turn `InteractiveMode` mechanism and arming rule as `wt-tool`. Right before calling `InteractiveMode.restart()`, appends custom session entry `mouriya.omp.harness-restart.request` (`reason` and timestamp); when the restarted process resumes the session, `session_start` sends `"Harness restart completed (<time>). Reason was: <reason>. Continue what you were doing."` with `attribution: "agent"`.

### commandcode-model-spec

Source: `agent/extensions/commandcode-model-spec/`.

Fixes two startup issues when `--model` selects a `commandcode` model: `models.db` caching discovered models with `openai-completions`/`anthropic-messages` instead of `commandcode-custom` (causing 401 errors), and model ids such as `google/gemini-3.5-flash-lite` matching the built-in `google` provider. At `session_start`, reads `<agentDir>/commandcode-models.json` (or `COMMANDCODE_MODELS_CACHE`) and, when the active model is in that catalog with `api !== "commandcode-custom"` and is not a credentialed built-in model, calls `setModel` to rebind it to the live `pi-commandcode-provider` model.

### antigravity-wire-profiles

Source: `agent/extensions/antigravity-wire-profiles/`.

OMP's `google-antigravity` provider only overrides the caller's `maxTokens` for wire ids present in its static `ANTIGRAVITY_MODEL_WIRE_PROFILES` table (`@oh-my-pi/pi-catalog/wire/gemini-headers`); newer wire ids (`gemini-4-argon-*`) were missing, so compaction's 512-token short summary request spent its entire budget on thinking and failed with `thought-only response without final output`.

At root `session_start` (awaited up to 20 s; `before_agent_start` awaits the same promise), the extension calls `POST <baseUrl>/v1internal:fetchAvailableModels` for the session credential and every stored Antigravity account, merges served models (non-internal, non-disabled, positive integer `maxOutputTokens`), and updates `ANTIGRAVITY_MODEL_WIRE_PROFILES` in place (adding and overwriting entries, never deleting). If all accounts fail, it keeps the existing table, warns in the log and main UI, and retries on the next root session start.

### tool-topics

Source: `agent/extensions/tool-topics/`; routing and registration come from [`_shared/tool-topics.ts`](operations.md#registering-tool-topics-from-plugins).

Progressive tool instructions. Each covered tool's description in the system prompt keeps its common call instructions and ends with a `Topics` index; the detailed call instructions are topics read on demand as `tool://<tool>/<topic>` (line selectors apply; `read tool://<tool>` lists one tool's topics with their conditions; `grep`/`find` over `tool://` search them). `SYSTEM_TEMPLATE.md` requires reading the matching topic before a call that needs it; [tool-topic-injection](#tool-topic-injection) additionally delivers a topic after calls to read-only tools.

- **Files**: `TOPIC-<tool>-<name>.md` with a strict YAML header (`tool`, `name`, `title`, `when`, `upstream`) and a Markdown body; `SURFACE-<tool>.md` (header `tool`, `upstream`) replaces the tool's whole description. Topics are call instructions — parameters, syntax, values, preconditions, results, error recovery — never implementation detail. `when` is the one line the index shows (“before …”, “when …”). `upstream` names the OMP version and the sources the text was checked against.
- **Coverage**: surfaces for `read`, `bash`, `task` (which splices the native `# Available Agents` section with `{{native:Available Agents}}`); topics for read, bash, edit (hashline mode), eval, grep, find, task, write, ask, fork_task, the devices ast_edit, debug, github, checkpoint, and the `exec_command` plugin device (waiting for an outside condition, terminal lifetime and reclaim, sending input and monitoring). Simple tools — `wait`, `glob`, `web_search`, `ast_grep`, `wt`, `wt_remove`, `harness_restart` — have no topics: their native description already holds the call contract.
- **Lifecycle**: files are read once when the extension loads and each tool's topics are registered under owner `omp-config/tool-topics`; changes need a restart. On every `before_agent_start` (main and sub, full and light) the extension locates each tool by name in OMP's rendered layout — inline `//` comment lines above `type <tool> =`, or a `## <tool>` device section before `### Schema` — and replaces its description with the surface (or keeps the native text) plus the index. Topics another owner (a plugin) registered for its own tools are read from the registry on every `before_agent_start`: that tool keeps its native description and gets their index, so a plugin maintains its own topics (see [Registering Tool Topics from Plugins](operations.md#registering-tool-topics-from-plugins)). Sessions without `read` keep native descriptions.
- **Failure**: a bad file is skipped with a warning. A tool whose layout or `{{native:…}}` section is not found keeps its native description, with a log warning and one main-session notice per tool and reason. A tool whose registration fails gets no index.

### tool-topic-injection

Source: `agent/extensions/tool-topic-injection/`; the reusable rule engine is `_shared/tool-topic-injection.ts`. Main/sub and full/light sessions load it. It observes `tool_result`, does not block or change execution, and returns matched topics as trusted developer context after the tool batch, before the next model call. Failed tool calls also receive guidance.

The shipped rules live in `omomp.yml` and are re-read per result (project `.omp/omomp.*` before agent-dir `omomp.*`). No valid section means off; invalid copies warn and are skipped. An empty `rules` list disables injection:

```yaml
tool-topic-injection:
  rules:
    - id: read-ssh
      tool: read
      parameter: path
      pattern: '^ssh://'
      topic: tool://read/ssh
    - id: read-sqlite
      tool: read
      parameter: path
      pattern: '\.(sqlite3?|db3?)(:|\?|$)'
      topic: tool://read/sqlite
    # … read-archives, read-json, read-documents, read-forge, read-runtime, read-web,
    #   grep-regex, grep-scopes, eval-ssh-cat, bash-ssh-cat
```

Shipped rules cover only calls that change nothing and are cheap to repeat (read, grep) plus the eval/bash `ssh … cat` misuse rules: a topic delivered after the call improves the next one. `task`, `fork_task`, `edit`, `write` and mutating devices have no rules, since a topic arriving after their call is too late; their topics are read before the call.

`tool` is an exact tool name; `parameter` names a string argument (or dotted property path). `pattern` is JavaScript regex source, without slash delimiters or flags; it is a text matcher, not a shell parser. Missing/non-string parameters do not match. `topic` is a registered `tool://<tool>/<topic>` leaf. Rule ids must be unique and stable within the owner.

Each rule injects once while its marker remains in the actual model context reconstructed from the active leaf. The shared `_shared/context-delivery.ts` guard is also used by `repo-rules`; its only temporary set covers the current turn before the host persists the developer message. Compaction that drops a marker makes the rule eligible again; retained-tail markers still suppress duplicates. Resume and tree navigation follow the current branch, not the entire transcript. Two rules pointing to one topic each get one injection. A missing/empty/failed topic is warned and does not consume eligibility; other rules still run.

External plugins can use the [exported engine and schema](operations.md#progressive-topic-injection-api) with their own owner and rule provider; they do not need to import this extension.

### session-urls

Source: `agent/extensions/session-urls/`. Registers the read-only `session://` scheme in OMP's process-global URL router, so main sessions, subagents (`task`, `fork_task`, seance) and light mode all read other sessions on this machine with `read` and `grep` instead of locating JSONL files by hand. `read session://README` returns the full grammar.

- **Find**: `session://find?text=<words>[&project=.|<bucket>|<path>][&max=N]` matches prompt history (OMP's FTS index in `history.db`), titles and recaps; `session://sessions.jsonl`, `session://here/sessions.jsonl` and `session://projects/<bucket>/sessions.jsonl` list session metadata (sid, cwd, title, created, modified, status, size, recap, parent) as JSONL.
- **Read**: `session://<id-prefix>/timeline` renders the active branch as a timeline: column-0 headers `HH:MM:SS <kind> #<entry>[.<block>]`, every body line indented two spaces, a `── turn N` line per user turn and `── idle` marks for gaps of 5 minutes or more. User, developer, thinking, assistant text, IRC in and out, task dispatches and subagent results (as the parent received them) are shown in full; every other tool call is one line, `tool(args) status #<result entry> // intent`, without its output. `…/entry/<id>` (or `…/entry/@<raw line>`) shows one entry in full, a tool result together with its arguments, intent and timing. `…/events.jsonl` is the same events as JSONL; `…/raw.jsonl` is the session file; `…/agents/<AgentId>/…` repeats the tree for subagents; `…/artifacts/<N>` and `…/local/<path>` are that session's `artifact://` and `local://`, and references to them inside a timeline are rewritten to these URLs.
- **Type filter**: `timeline` and `events.jsonl` (root sessions and subagents) take `?type=<filter>`, or the same filter as a path prefix `session://type/<filter>/<path>`, which is the form that survives a grep glob (after a glob segment, `?` is glob text). A filter is a comma list, and repeated `type=` values and a prefix plus a query add up: event kinds (`user`, `developer`, `thinking`, `say`, `call`, `irc_out`, `irc_in`, `dispatch`, `subresult`, `exec`, `marker`, plus the header labels `calls` and `result`), groups (`irc`, `subagent`, `tools`, `ai`, `speech`), `call:<tool>` (any event carrying that tool's call, so `call:task` is dispatches and `call:write` outgoing IRC), `marker:<what>`, and `-<x>` / `!<x>` exclusions (exclusions alone keep everything else). Matching is case-insensitive; an unknown token fails with the accepted forms. A filtered timeline prints a `filter` header line with the shown count and keeps each turn line's full counts; jq's next-page hint on a filtered `events.jsonl` keeps the `type`.
- **jq**: `?q=<filter>&raw=&compact=&offset=&limit=` on `events.jsonl`, `sessions.jsonl` and `find` runs OMP's embedded jaq (`executeJsonQuery`) on a per-call temp JSONL. OMP's own `read …?q=` reaches only `local://`/`artifact://` files, so the scheme runs it itself; `raw.jsonl` takes no query.
- **grep**: one traversable tree, `session://projects/<bucket>/<YYYY-MM-DD>/<full-id>/timeline` (plus `…/agents/<AgentId>/timeline`) and its alias `session://here/…` for the current project, listed through the router's `readDirectory`; hits keep the `session://` path and line, readable directly. Each session directory lists only `timeline` and `agents/`, so a grep never searches one session twice or walks tool output; one grep call covers about 7 GB of session files within its 30 s budget, so scope by project and date.
- **Reading model**: nothing is cached or written beside the sessions. Each read streams the file once through a projecting JSON tokenizer (`scanner.ts`) that builds only the fields the view needs and measures skipped strings without materializing them, then picks the active branch with OMP's `resolveSessionLeafId`. On the largest session here (731 MB, 3850 entries) a scan takes about 6 s with a peak of +12 to +35 MB RSS, where OMP's own loader peaks at +2.6 GB. Unparsable lines and a still-being-written last line are reported in the timeline header, not dropped silently. `ci/session-urls-scanner.test.ts` (`bun run test`) checks the tokenizer against `JSON.parse` under every chunking.
- **Host coupling**: every OMP-internal import (router, session listing/index/loader helpers, `tools/read-json`) sits in `omp-adapter.ts`; a host upgrade that moves one fails there at load. The handler never replaces an OMP-owned `session` scheme or another host's handler.

### omomp-lang

Source: `agent/extensions/omomp-lang/`.

Sets the UI language (`en` or `zh`) for person-facing text across local extensions and OMP plugins (notifications, widgets, status bar, dialogs, overlays, command/shortcut descriptions, tool labels, and renderers). Model prompts, steers, tool descriptions, tool results, and logs are not translated.

- Reads `omomp.yml#omomp-lang.language` (shipped `zh`) from the agent-dir `omomp.*` only (project `.omp/` copies are ignored; changes apply on the next OMP start).
- At module load, sets `process.env.OMOMP_LANG` unless the launch environment already defines it (`OMOMP_LANG=en omp`).
- `_shared/i18n.ts` `tr(en, zh)` resolves `OMOMP_LANG` → `omomp.yml#omomp-lang.language` → `LC_ALL` / `LC_MESSAGES` / `LANG` (`zh*` = Chinese) → English at each call site, reading the config section directly so deferred extensions that produce text before `omomp-lang` finishes loading still use the configured language.
- OMP-only plugins (`omp-todo-more`, `omp-playbooks`, `omp-thinking-translator`, `omp-codex-image-gen`, `omp-remote-build`) resolve the same chain; `omp-ask-more` reads `OMOMP_LANG` → `LC_ALL` / `LC_MESSAGES` / `LANG` from the environment once at module load; Pi-compatible plugins (`omp-unified-exec`, `pi-bansos`) read the environment; third-party npm plugins (`pi-commandcode-provider`, `pi-package-search`) are English-only.
