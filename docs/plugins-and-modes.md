# Plugins and Runtime Modes

[Home](../README.md) · English | [简体中文](plugins-and-modes.zh-CN.md)

## Plugins (`install-plugins.sh`)

Independent plugins are installed into `~/.omp/plugins/` via `install-plugins.sh` (required entries plus commented-out optional ones, none version-pinned, and `~/.omp/plugins/` is not tracked in git). Every omomp plugin is declared as `<url>#release`, so machines install the head of its `release` branch, which its daily release moves, never unreleased work on its `main`. The inventory below records installation sources and omp-config integration; plugin usage and configuration belong to the linked plugin sources.

- Every updater apply refreshes all required entries and every installed optional one against the spec declared in `install-plugins.sh`, and keeps the user's enable state and feature selection of each installed plugin:
  - a missing required plugin gets `omp install <spec>`;
  - an installed plugin whose recorded spec equals the declared one (the same GitHub owner/repo and `#ref`, both without a ref counting as equal, or a bare npm name recorded as a version range) gets `omp plugin upgrade <name>`, which moves `#release` and default-branch sources to their new commit and a bare npm name to its newest version while keeping `enabled` and `enabledFeatures`;
  - an installed plugin whose spec changed (another `#ref`, npm version or source, or a bare URL now declared as `#release`) gets `omp install <spec>`, followed by `omp plugin disable <name>` when it was disabled; features follow the new spec. An npm entry declared with a range, partial version or dist-tag is reinstalled this way on every apply; one pinned to the exact version already recorded runs no command;
  - a plugin installed as a local link (a `link:`, `file:`, `workspace:` or `portal:` dependency, an `omp plugin link` entry with no dependency, or a symlink in `~/.omp/plugins/node_modules`) is never installed over or upgraded. A link made over an installed dependency is replaced by the host's bun install whenever any plugin is installed or upgraded, so after its own commands the updater links it again with `omp plugin link` and restores its `enabled` and `enabledFeatures`, which the link resets;
  - a spec that is neither a GitHub source (`https://`, `git+https://`, `git@github.com:`, `github:`) nor an npm name runs no command, and the report notes it as not recognized.
- When startup auto-update sees an unchanged config commit, it still refreshes every GitHub entry without a `#ref` or on the `#release` channel (required plugins and already-installed optional plugins) by the same rules, so each plugin follows its own release (or, without a ref, its default branch) without waiting for a config commit; entries pinned to any other ref wait for the next config commit. Installed entries match a declared GitHub source by owner/repo across the forms OMP records, including `github:`, HTTPS and git URLs.
- `./plugin-audit.sh` matches each Git/URL entry by the package name recorded in `~/.omp/plugins/package.json` (second column below); an installed optional plugin is listed under `[保留]` (keep) rather than missing or uninstall candidate.

| Source in `install-plugins.sh` | Package name in `omp plugin list` | Status | omp-config integration |
|---|---|---|---|
| [`https://github.com/oh-my-omp/omp-todo-ng#release`](https://github.com/oh-my-omp/omp-todo-ng) | `omp-todo-ng` | Required (GitHub) | Runs on top of native Todo, which stays on (`agent/config.yml` `todo.enabled: true`); see [todo-ng](#todo-ng). |
| [`https://github.com/oh-my-omp/omp-actual-terminal#release`](https://github.com/oh-my-omp/omp-actual-terminal) | `omp-actual-terminal` | Required (GitHub) | Native launch is disabled (`agent/config.yml` `launch.enabled: false`); registers `bash` (`pty: true` terminal jobs), `write_stdin`, `monitor`, `term://`, and `help://bash/terminal`. |
| [`https://github.com/mouriya-s-lab/pi-bansos`](https://github.com/mouriya-s-lab/pi-bansos) | `pi-bansos` | Required (GitHub fork) | — |
| [`https://github.com/oh-my-omp/omp-thinking-translator#release`](https://github.com/oh-my-omp/omp-thinking-translator) | `omp-thinking-translator` | Required (GitHub) | Plugin-owned configuration is excluded from updater and sync writes; see [Thinking translation](#thinking-translation). |
| [`https://github.com/oh-my-omp/omp-ask-ng#release`](https://github.com/oh-my-omp/omp-ask-ng) | `omp-ask-ng` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-peers#release`](https://github.com/oh-my-omp/omp-peers) | `omp-peers` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-sessions#release`](https://github.com/oh-my-omp/omp-sessions) | `omp-sessions` | Required (GitHub) | — |
| [`https://github.com/oh-my-omp/omp-subagent-ng#release`](https://github.com/oh-my-omp/omp-subagent-ng) | `omp-subagent-ng` | Required (GitHub) | Ships `fork_task`. |
| [`# https://github.com/oh-my-omp/omp-dispatch#release`](https://github.com/oh-my-omp/omp-dispatch) | `omp-dispatch` | Optional (commented out) | — |
| [`# https://github.com/oh-my-omp/omp-playbooks#release`](https://github.com/oh-my-omp/omp-playbooks) | `omp-playbooks` | Optional (commented out) | — |
| [`# https://github.com/oh-my-omp/omp-remote-build#release`](https://github.com/oh-my-omp/omp-remote-build) | `omp-remote-build` | Optional (commented out) | — |

### todo-ng

The plugin runs on top of native Todo, so `agent/config.yml` keeps it on (`todo.enabled: true`): its `todo` tool shadows the built-in one and it switches the native reminders off for the process. The shipped light-mode disable list leaves `omp-todo-ng` loaded. The local `task-completion-judge` requests the session's Todo state through the `omp-todo-ng:read` event.

The updater checks ownership of the Todo, ctx and fork retirement targets before installing plugins. Once OMP's plugin catalog confirms `omp-todo-ng` is enabled with `./index.ts` present, the updater retires the local Todo files listed by `TODO_RETIREMENTS` in `agent/extensions/omp-config-autoupdate/omp-config-update.ts`; it retires the files listed by `CTX_RETIREMENTS` only when the ready plugin also contains `src/ctx`. Once the catalog confirms `omp-subagent-ng` is enabled with `./extensions/fork-task/index.ts` and `agents/fork-self.md` present, it retires the files listed by `FORK_RETIREMENTS`. `/sync-omp-config` excludes these same paths.

Plugin tool documentation: `help://todo/lifecycle` (and `todo({})` reads live plan state directly).

### Thinking translation

Set up translation using the [omp-thinking-translator README](https://github.com/oh-my-omp/omp-thinking-translator#readme). Its configuration lives in plugin settings and `config.yml` `modelRoles.omp-thinking-translator`, not in a separate JSON file; the updater retires legacy `~/.omp/agent/thinking-translator.json` automatically.

---

## Full Mode (`omp`) vs Light Mode (`omp-light`)

`omp` loads all local extensions, dispatch/yield checks, and advisor hooks for multi-step engineering; short tasks and quick questions do not need those checks. `omp-light` applies `agent/config-light.yml` and `agent/APPEND_SYSTEM_LIGHT.md` to the launched process without modifying files on disk:

| Setting | `omp` (full mode) | `omp-light` (light mode) |
|---|---|---|
| Appended system prompt | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md` (empty) |
| `OMOMP_MODE` environment variable | Unset (`full`) | `light`; [`append-system-model`](prompts-and-context.md#append-system-model) fragments select on it with `mode` / `exclude.mode`, so the shipped decision-support fragment (`mode: full`) is not injected |
| `task.eager` | `preferred` | `default` |
| `bashInterceptor.enabled` | `true` (the `config.yml` patterns redirect `cat`/`grep`/`find`/`sed -i`/`echo >` etc. to dedicated tools) | `false`: `bash` runs those commands unblocked |
| `disabledExtensions` | None | Disables these extensions: `fork-task` (the `omp-subagent-ng` plugin's extension entry), `isolation-nudge`, `task-completion-judge`, `task-split-check`, `tool-policy-nag`, `turn-judge`, `user-prompt-inject`, `watchdog-agent` |
| `config.yml` `extensions` path list | Loads `extensions-last/system-prompt-replace` | `config-light.yml` overrides `extensions` with a list that loads `extensions-last/system-prompt-replace` last too (its `REPLACE-SYSTEM-*.yml` rules select modes with `mode` / `exclude.mode`; the shipped rules say `mode: full`); `omp-light.ts` reads the machine's `config.yml` and passes any non-`/extensions-last/` entries (such as `~/.claude`) back via `-e` |
| Remaining local extensions | Loaded | Loaded: `append-system-model`, `argon-long-output`, `ast-top-level`, `child-memory-warning`, `delete-guard`, `harness-restart`, `input-polish`, `lang-nag`, `model-compaction`, `omomp-changelog`, `omomp-lang`, `omp-config-autoupdate`, `repo-rules`, `subagent-usage`, `task-result-guard`, `tool-topics`, `wt-tool` (OMP-owned tool descriptions still get their surfaces and `Topics` indexes in light mode; plugin tools keep their own descriptions) |
| Installed plugins | All loaded | All loaded except the `fork-task` plugin extension entry named in `disabledExtensions` above |
| Local tools removed in light mode | — | None (`fork_task` is the `omp-subagent-ng` plugin's tool; its `fork-task` extension entry is disabled by `config-light.yml`) |

**Launcher installation**: `/update-omp` and startup auto-update install `agent/omp-light.ts` beside the resolved `omp` binary on `PATH` (executable `omp-light` on POSIX/macOS/Linux; on Windows `omp-light.exe`, compiled from `omp-light.ts` with `bun build --compile`, so `bun` must be on `PATH` when the launcher is installed or updated). `omp-light` reads `config-light.yml` and `APPEND_SYSTEM_LIGHT.md` from `PI_CODING_AGENT_DIR` (or `~/.omp/agent`), exits if either file is missing, and forwards all CLI arguments to `omp`.
