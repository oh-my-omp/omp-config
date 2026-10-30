# Plugins and Runtime Modes

[Home](../README.md) · English | [简体中文](plugins-and-modes.zh-CN.md)

## Plugins (`install-plugins.sh`)

Lightweight policy and lifecycle hooks live in `agent/extensions/`, while stateful engines, provider transports, cross-platform PTY backends, and Tern side-pane UIs are packaged as independent plugins installed into `~/.omp/plugins/` via `install-plugins.sh` (10 required + 1 commented-out optional, none version-pinned, and `~/.omp/plugins/` is not tracked in git).

- Every updater apply runs `omp install` on all required entries, installing missing plugins and upgrading installed ones.
- When startup auto-update sees an unchanged config commit, it still runs `omp install` on every unpinned GitHub entry (required plugins and already-installed optional plugins) so they track their default branch without waiting for a config commit.
- `./plugin-audit.sh` matches each Git/URL entry by the package name recorded in `~/.omp/plugins/package.json` (second column below); an installed optional plugin is listed under `[保留]` (keep) rather than missing or uninstall candidate.

| Source in `install-plugins.sh` | Package name in `omp plugin list` | Status | Tools / commands / skills / UI | Purpose and local config |
|---|---|---|---|---|
| `https://github.com/oh-my-omp/omp-todo-more` | `omp-todo-more` | Required (GitHub) | Tools: `todo`, `ctx`; command: `/todo-more`; event: `omp-todo-more:read`; Tern pane | Replaces native Todo (`todo.enabled: false` in `config.yml`); see [todo-more](#todo-more) |
| `https://github.com/oh-my-omp/omp-unified-exec` | `omp-unified-exec` | Required (GitHub fork) | `xd://` tools: `exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions` | Fork of `iamwrm/pi-unified-exec`: runs PTY sessions logged to `/tmp/pi-unified-exec-*.log`, skips Pi-only `createCodemodeExtension`, and uses `Bun.Terminal` on macOS/Linux/Windows under Bun (loading `@homebridge/node-pty-prebuilt-multiarch` only under Node.js). Uninstall `pi-unified-exec` before installing |
| `https://github.com/mouriya-s-lab/pi-bansos` | `pi-bansos` | Required (GitHub fork) | Provider: `bansos`; command: `/bansos` | Fork of `mannnrachman/pi-bansos`: local proxy on `127.0.0.1:18080` providing free models for `task:free`. Reads and writes `~/.pi/agent/pi-bansos-relay-state.json` (synced both ways); uninstall npm `pi-bansos` before installing |
| `pi-commandcode-provider` | `pi-commandcode-provider` | Required (npm) | Provider: `commandcode` (`api: "commandcode-custom"`); command: `/commandcode-quota` | Connects to Command Code and writes `~/.omp/agent/commandcode-models.json` (used with [`commandcode-model-spec`](extensions.md#commandcode-model-spec)) |
| `https://github.com/oh-my-omp/omp-thinking-translator` | `omp-thinking-translator` | Required (GitHub) | Live Chinese translation for assistant thinking blocks; command: `/thinking-translator` | Translates thinking blocks line by line using `~/.omp/agent/thinking-translator.json`; see [Thinking translation](#thinking-translation) |
| `https://github.com/oh-my-omp/omp-codex-image-gen` | `omp-codex-image-gen` | Required (GitHub) | `xd://` tool: `codex_generate_image`; skill: `imagegen` | Calls `gpt-image-2` with the local ChatGPT Codex subscription to generate or edit PNGs from 1–5 reference images |
| `pi-package-search` | `pi-package-search` | Required (npm) | `xd://` tools: `search_pi_packages`, `install_pi_package`; skill: `pi-package-search` | Searches npm for `pi-package` packages and installs them when requested |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | Required (npm) | TUI `Markdown.prototype.render` patch | Hides Markdown code fences in the TUI and removes default 2-column code indentation while keeping source indentation and syntax highlighting |
| `https://github.com/oh-my-omp/omp-playbooks` | `omp-playbooks` | Required (GitHub) | `xd://` tools: `playbook_open`, `playbook_read`, `playbook_edit`, `playbook_compile`, `playbook_check`, `playbook_run`, `playbook_timeline`, `playbook_launch`; CLI: `omp-playbook` | YAML Playbook service and Tern side-pane UI. When `tern` (from the Tern desktop app) is on `PATH` it links its Tern plugin; without it the install still succeeds and links nothing. An omp outside a Tern pane (no numeric `TERN_PANE`) gets no tools, topics or commands from it |
| `https://github.com/oh-my-omp/omp-ask-more` | `omp-ask-more` | Required (GitHub) | Tool: `ask` (replaces the native one); settings: `askMore.*` in `config.yml` | Native `ask` parameters plus a per-question `brief` (where/what/how, evidence read from disk, diagram, demo, risks) and per-option `tradeoff`, answered on a full-screen page (a sheet in Tern); the result keeps the native shape, so `turn-judge` and `user-prompt-inject` read it unchanged. An unattended ask notifies after `askMore.timeout` (1800 s) and hands unanswered questions to the model after `askMore.returnTimeout` (1200 s). Sessions without the TUI fall back to the native `ask`, so it stays enabled. Its Tern stylesheet is a separate, optional `tern plugin install github.com/oh-my-omp/omp-ask-more/tern` |
| `# https://github.com/oh-my-omp/omp-remote-build` | `omp-remote-build` | Optional (commented out) | `xd://` tools: `container_exec`, `container_write_stdin`, `container_list_sessions`, `container_kill_session`, `remote_env_init`, `remote_env_build_image` | Per-worktree Mutagen sync and Komodo build container on a remote Docker host. Requires `omp-unified-exec`, Mutagen, `km` CLI, and an SSH build host |

### todo-more

[omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) loads in both `omp` and `omp-light` while native Todo is disabled (`todo.enabled: false` in `agent/config.yml`). It sits between an ordinary session and `/goal`: it retains `/goal`'s enforcement of objectives, completion criteria (`objective`/`measure`/`doneWhen`), and unfinished items while allowing phases, tasks, time estimates, and blocked states to be revised during execution; task completions and commits form logical checkpoints and are re-injected across compaction rounds:

- **Branch snapshot, logical checkpoints, and reminders**: stores `{objective, measure, doneWhen}` and each item's `{title, explanation}`, minute estimate, and `DONE` commit SHA in the custom session entry `mouriya.omp.todo-more` on the active branch (`TodoTracker`, `/todo`, and history cards are derived from it). `planning.ts` blocks `edit` when the list is empty, and its empty-list reminder asks for a todo only in the work phase (the request changes files, config, git or external state), never for discussion or investigation; `reminders.ts` reminds the agent to continue at turn end while open items remain (unless asking the user); `DONE` requires a git commit clause whenever a git checkout has uncommitted changes (inert outside git or with a clean tree), recording the commit SHA on the completed item and logging the transition to [`Task log`](prompts-and-context.md#task-log) as a logical checkpoint; across compaction rounds, `omp-todo-more` re-injects the Todo snapshot and [`after-compact injection`](prompts-and-context.md#after-compact-injection) (`ctx list` and `ctx show`); and `before_agent_start` re-attaches `todo` to `task:*` subagents.
- **`/todo-more` editor**: edits the goal or item explanations in place (Enter inserts a newline, Tab/Shift+Tab switches fields, Ctrl+Enter saves, Esc cancels) without changing item status or starting a model turn.
- **Retiring old local files**: once the updater confirms `omp-todo-more` is enabled in OMP's plugin catalog with `./index.ts` present, it unlinks the 8 old local Todo files (`extensions/todo-more/{index,tool,render,reminders,planning}.ts`, `extensions/_shared/todo-more.ts`, `extensions/subagent-todo.ts`, `extensions/subagent-todo/index.ts`) and, when the plugin ships `src/ctx`, the 5 old local ctx files (`extensions/ctx-tool/{index,inventory,post-compact-hint}.ts`, `extensions/ctx-tasklog/index.ts`, `extensions/_shared/task-log.ts`). `/sync-omp-config` excludes all 13 paths.

### Thinking translation

`omp-thinking-translator` reads its model list from `~/.omp/agent/thinking-translator.json`, trying candidates in order on each request and re-reading the file at the start of the next message. Shipped chain:

1. `futureppo-pool/glm-5.3-flash` (`effort: "low"`)
2. `futureppo-pool/minimax-m3.1-flash` (`effort: "low"`)
3. `futureppo-pool/grok-4.7` (`effort: "minimal"`)
4. `commandcode/inclusionai/ling-3.1-flash:free` (`effort: "minimal"`)
5. `commandcode/poolside/laguna-s-2.1-free` (`effort: "minimal"`)
6. `commandcode/stealth/glyph-cluster:free` (`effort: "minimal"`)

`deepseek-v4.1-flash` is no longer served by the pool; `qwen3.8-27b` rejects `reasoning_effort`, and `qwen3.8-flash-next` / `Index-Translate-35B-A3B` fail OMP's `max_completion_tokens` request shape. None of them is in the chain.

Auto-discovered `futureppo-pool` models omit `reasoning_effort` support. To use the `futureppo-pool` entries, add `supportsReasoningEffort: true` under `providers.futureppo-pool` in the machine's `~/.omp/agent/models.yml` (machine-local, not synced), restart `omp`, and check `/thinking-translator status`:

```yaml
providers:
  futureppo-pool:
    modelOverrides:
      glm-5.3-flash:
        compat:
          supportsReasoningEffort: true
      minimax-m3.1-flash:
        compat:
          supportsReasoningEffort: true
      grok-4.7:
        compat:
          supportsReasoningEffort: true
```

---

## Full Mode (`omp`) vs Light Mode (`omp-light`)

`omp` loads all local extensions, dispatch/yield checks, and advisor hooks for multi-step engineering; short tasks and quick questions do not need those checks. `omp-light` applies `agent/config-light.yml` and `agent/APPEND_SYSTEM_LIGHT.md` to the launched process without modifying files on disk:

| Setting | `omp` (full mode) | `omp-light` (light mode) |
|---|---|---|
| Appended system prompt | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md` (empty) |
| `task.eager` | `preferred` | `default` |
| `disabledExtensions` | None | Disables 10 extensions: `doc-polish`, `fork-task`, `isolation-nudge`, `lang-nag`, `task-completion-judge`, `task-split-check`, `tool-policy-nag`, `turn-judge`, `user-prompt-inject`, `watchdog-agent` |
| `config.yml` `extensions` path list | Loads `extensions-last/system-prompt-replace` | `config-light.yml` overrides `extensions: []` to skip `extensions-last/system-prompt-replace` (`disabledExtensions` only filters by module name, not file paths); `omp-light.ts` reads the machine's `config.yml` and passes any non-`/extensions-last/` entries (such as `~/.claude`) back via `-e` |
| Remaining local extensions | Loaded | Loaded: `antigravity-wire-profiles`, `append-system-model`, `child-memory-warning`, `commandcode-model-spec`, `delete-guard`, `harness-restart`, `input-polish`, `model-compaction`, `omomp-lang`, `omp-config-autoupdate`, `repo-rules`, `session-urls`, `tool-topic-injection`, `tool-topics`, `wt-tool` (tool descriptions still get their surfaces and `Topics` indexes in light mode) |
| Installed plugins | All loaded | All loaded (`disabledExtensions` does not affect plugins) |
| Tools removed in light mode | — | `polish_doc`, `fork_task` (`todo`, `ctx`, `wt`, `wt_remove`, and `harness_restart` stay enabled) |

**Launcher installation**: `/update-omp` and startup auto-update install `agent/omp-light.ts` beside the resolved `omp` binary on `PATH` (executable `omp-light` on POSIX/macOS/Linux; `omp-light.ts` plus `omp-light.cmd` on Windows). `omp-light` reads `config-light.yml` and `APPEND_SYSTEM_LIGHT.md` from `PI_CODING_AGENT_DIR` (or `~/.omp/agent`), exits if either file is missing, and forwards all CLI arguments to `omp`.
