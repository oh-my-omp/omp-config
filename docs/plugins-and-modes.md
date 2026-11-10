# Plugins and Runtime Modes

[Home](../README.md) · English | [简体中文](plugins-and-modes.zh-CN.md)

## Plugins (`install-plugins.sh`)

Independent plugins are installed into `~/.omp/plugins/` via `install-plugins.sh` (required entries plus commented-out optional ones, none version-pinned, and `~/.omp/plugins/` is not tracked in git). The inventory below records installation sources and omp-config integration; plugin usage and configuration belong to the linked plugin sources.

- Every updater apply runs `omp install` on all required entries, installing missing plugins and upgrading installed ones.
- When startup auto-update sees an unchanged config commit, it still runs `omp install` on every unpinned GitHub entry (required plugins and already-installed optional plugins) so they track their default branch without waiting for a config commit. Installed entries match a declared GitHub source by owner/repo across the forms OMP records, including `github:`, HTTPS and git URLs.
- `./plugin-audit.sh` matches each Git/URL entry by the package name recorded in `~/.omp/plugins/package.json` (second column below); an installed optional plugin is listed under `[保留]` (keep) rather than missing or uninstall candidate.

| Source in `install-plugins.sh` | Package name in `omp plugin list` | Status | omp-config integration |
|---|---|---|---|
| [`https://github.com/oh-my-omp/omp-todo-more`](https://github.com/oh-my-omp/omp-todo-more) | `omp-todo-more` | Required (GitHub) | Runs on top of native Todo, which stays on (`agent/config.yml` `todo.enabled: true`); see [todo-more](#todo-more). |
| [`https://github.com/oh-my-omp/omp-unified-exec`](https://github.com/oh-my-omp/omp-unified-exec) | `omp-unified-exec` | Required (GitHub fork) | Native launch is disabled (`agent/config.yml` `launch.enabled: false`); the local bash surface routes to `xd://exec_command`. |
| [`https://github.com/mouriya-s-lab/pi-bansos`](https://github.com/mouriya-s-lab/pi-bansos) | `pi-bansos` | Required (GitHub fork) | `agent/config.yml` includes a `bansos/...` model in the `task:free` binding. |
| [`https://github.com/oh-my-omp/omp-thinking-translator`](https://github.com/oh-my-omp/omp-thinking-translator) | `omp-thinking-translator` | Required (GitHub) | Plugin-owned configuration is excluded from updater and sync writes; see [Thinking translation](#thinking-translation). |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | Required (npm) | — |
| [`https://github.com/oh-my-omp/omp-playbooks`](https://github.com/oh-my-omp/omp-playbooks) | `omp-playbooks` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-ask-more`](https://github.com/oh-my-omp/omp-ask-more) | `omp-ask-more` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-peers`](https://github.com/oh-my-omp/omp-peers) | `omp-peers` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-sessions`](https://github.com/oh-my-omp/omp-sessions) | `omp-sessions` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-subagent-more`](https://github.com/oh-my-omp/omp-subagent-more) | `omp-subagent-more` | Required (GitHub) | Ships `fork_task`. |
| [`# https://github.com/oh-my-omp/omp-remote-build`](https://github.com/oh-my-omp/omp-remote-build) | `omp-remote-build` | Optional (commented out) | — |

### todo-more

The plugin runs on top of native Todo, so `agent/config.yml` keeps it on (`todo.enabled: true`): its `todo` tool shadows the built-in one and it switches the native reminders off for the process. The shipped light-mode disable list leaves `omp-todo-more` loaded. The local `task-completion-judge` requests the session's Todo state through the `omp-todo-more:read` event.

The updater checks ownership of the Todo, ctx and fork retirement targets before installing plugins. Once OMP's plugin catalog confirms `omp-todo-more` is enabled with `./index.ts` present, the updater retires the local Todo files listed by `TODO_RETIREMENTS` in `agent/extensions/omp-config-autoupdate/omp-config-update.ts`; it retires the files listed by `CTX_RETIREMENTS` only when the ready plugin also contains `src/ctx`. Once the catalog confirms `omp-subagent-more` is enabled with `./extensions/fork-task/index.ts` and `agents/fork-self.md` present, it retires the files listed by `FORK_RETIREMENTS`. `/sync-omp-config` excludes these same paths.

Plugin tool documentation: `xd://todo` and `xd://ctx`.

### Thinking translation

Set up translation using the [omp-thinking-translator README](https://github.com/oh-my-omp/omp-thinking-translator#readme). Its configuration and model selection belong to the plugin and the machine, not this repository. The updater does not create, rewrite or delete `~/.omp/agent/thinking-translator.json`; `/sync-omp-config` excludes it.

---

## Full Mode (`omp`) vs Light Mode (`omp-light`)

`omp` loads all local extensions, dispatch/yield checks, and advisor hooks for multi-step engineering; short tasks and quick questions do not need those checks. `omp-light` applies `agent/config-light.yml` and `agent/APPEND_SYSTEM_LIGHT.md` to the launched process without modifying files on disk:

| Setting | `omp` (full mode) | `omp-light` (light mode) |
|---|---|---|
| Appended system prompt | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md` (empty) |
| `OMOMP_MODE` environment variable | Unset (`full`) | `light`; [`append-system-model`](prompts-and-context.md#append-system-model) fragments select on it with `mode` / `exclude.mode`, so the shipped decision-support fragment (`mode: full`) is not injected |
| `task.eager` | `preferred` | `default` |
| `bashInterceptor.enabled` | `true` (the `config.yml` patterns redirect `cat`/`grep`/`find`/`sed -i`/`echo >` etc. to dedicated tools) | `false`: `bash` runs those commands unblocked |
| `disabledExtensions` | None | Disables these extensions: `fork-task` (the `omp-subagent-more` plugin's extension entry), `isolation-nudge`, `lang-nag`, `task-completion-judge`, `task-split-check`, `tool-policy-nag`, `turn-judge`, `user-prompt-inject`, `watchdog-agent` |
| `config.yml` `extensions` path list | Loads `extensions-last/system-prompt-replace` | `config-light.yml` overrides `extensions` with a list that loads `extensions-last/system-prompt-replace` last too (its `REPLACE-SYSTEM-*.yml` rules select modes with `mode` / `exclude.mode`; the shipped rules say `mode: full`); `omp-light.ts` reads the machine's `config.yml` and passes any non-`/extensions-last/` entries (such as `~/.claude`) back via `-e` |
| Remaining local extensions | Loaded | Loaded: `append-system-model`, `argon-long-output`, `ast-top-level`, `child-memory-warning`, `delete-guard`, `harness-restart`, `input-polish`, `model-compaction`, `omomp-lang`, `omp-config-autoupdate`, `repo-rules`, `subagent-usage`, `tool-topics`, `wt-tool` (OMP-owned tool descriptions still get their surfaces and `Topics` indexes in light mode; plugin tools keep their own descriptions) |
| Installed plugins | All loaded | All loaded except the `fork-task` plugin extension entry named in `disabledExtensions` above |
| Local tools removed in light mode | — | None (`fork_task` is the `omp-subagent-more` plugin's tool; its `fork-task` extension entry is disabled by `config-light.yml`) |

**Launcher installation**: `/update-omp` and startup auto-update install `agent/omp-light.ts` beside the resolved `omp` binary on `PATH` (executable `omp-light` on POSIX/macOS/Linux; `omp-light.ts` plus `omp-light.cmd` on Windows). `omp-light` reads `config-light.yml` and `APPEND_SYSTEM_LIGHT.md` from `PI_CODING_AGENT_DIR` (or `~/.omp/agent`), exits if either file is missing, and forwards all CLI arguments to `omp`.
