# Plugin Ecosystem and Dual Runtime Modes

[Home](../README.md) · English | [简体中文](plugins-and-modes.zh-CN.md)

## Plugin Ecosystem and External Capabilities

Lightweight policy and lifecycle hooks live in `agent/extensions/`, while stateful engines, provider transports, cross-platform PTY backends and Tern side-pane UIs are packaged as independent plugins installed into `~/.omp/plugins/` via `install-plugins.sh` (8 required + 2 commented-out optional, all unpinned; every updater apply runs `omp install` on each required entry to install missing plugins and upgrade installed ones, and an automatic update whose config commit is unchanged still runs it on every unpinned GitHub entry, required or installed optional, so those follow their default branch without a config commit). `plugin-audit.sh` keys each Git/URL entry by the package name `omp install` recorded for it in `~/.omp/plugins/package.json` (the second column), and reports an installed optional plugin as `[保留]` (keep), never as missing or an uninstall candidate:

| Declared source (`install-plugins.sh`) | `omp plugin list` package name | Category | Exposed tools / commands / skills / UI | Core mechanism and coupling with this config |
|---|---|---|---|---|
| `https://github.com/oh-my-omp/omp-todo-more` | `omp-todo-more` | Required (GitHub) | Tools: `todo`, `ctx`; command: `/todo-more`; event: `omp-todo-more:read`; Tern pane | Replaces native Todo disabled by `config.yml` (see [todo-more](#todo-more) below) |
| `https://github.com/oh-my-omp/omp-unified-exec` | `omp-unified-exec` | Required (GitHub fork) | `xd://` tools: `exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions` | Maintained fork of `iamwrm/pi-unified-exec`: starts long-lived sessions with full output logged to `/tmp/pi-unified-exec-*.log`; skips Pi-only `createCodemodeExtension` and uses Bun's native `Bun.Terminal` for PTY on macOS, Linux and Windows under Bun 1.4+ (loading `@homebridge/node-pty-prebuilt-multiarch` only under Node.js). Uninstall `pi-unified-exec` first if present |
| `https://github.com/mouriya-s-lab/pi-bansos` | `pi-bansos` | Required (GitHub fork) | Provider: `bansos`; command: `/bansos` | Fork of `mannnrachman/pi-bansos`: runs a local proxy on `127.0.0.1:18080` with OpenCode Desktop client fingerprinting and KiloCode gateway routing to supply zero-cost models for `task:free`. State file `~/.pi/agent/pi-bansos-relay-state.json` is synced both ways; uninstall npm `pi-bansos` first if present |
| `pi-commandcode-provider` | `pi-commandcode-provider` | Required (npm) | Provider: `commandcode` (`api: "commandcode-custom"`); command: `/commandcode-quota` | Connects to the Command Code API and writes `~/.omp/agent/commandcode-models.json` for `thinking-translator.json` and `doc-polish`, paired with local extension `commandcode-model-spec` |
| `https://github.com/oh-my-omp/omp-thinking-translator` | `omp-thinking-translator` | Required (GitHub) | Live Chinese translation renderer for assistant thinking blocks + late-row notifications; command: `/thinking-translator` | Deduplicates and streams per-line translations using `~/.omp/agent/thinking-translator.json` (see [Thinking translation](#thinking-translation) below) |
| `https://github.com/oh-my-omp/omp-codex-image-gen` | `omp-codex-image-gen` | Required (GitHub) | `xd://` tool: `codex_generate_image`; skill: `imagegen` | Uses a local ChatGPT Plus/Pro Codex subscription to generate or edit PNGs from 1–5 local reference images via `gpt-image-2` |
| `pi-package-search` | `pi-package-search` | Required (npm) | `xd://` tools: `search_pi_packages`, `install_pi_package`; skill: `pi-package-search` | Searches npm for `pi-package` extensions and installs them when explicitly requested |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | Required (npm) | TUI `Markdown.prototype.render` patch | Hides Markdown code fences in the TUI and removes default 2-column code indentation while preserving source indentation and ANSI syntax highlighting |
| `# https://github.com/oh-my-omp/omp-remote-build` | `omp-remote-build` | Optional (commented out by default) | `xd://` tools: `container_exec`, `container_write_stdin`, `container_list_sessions`, `container_kill_session` | Per-worktree Mutagen replica and Komodo-managed build container on a remote Docker host (auto-flushing Mutagen after writing tool calls). Requires `omp-unified-exec`, Mutagen, km CLI and an SSH build host |
| `# https://github.com/oh-my-omp/omp-playbooks` | `omp-playbooks` | Optional (commented out by default) | `xd://` tools: `playbook_open`, `playbook_read`, `playbook_edit`, `playbook_compile`, `playbook_check`, `playbook_run`, `playbook_timeline`, `playbook_launch`; CLI: `omp-playbook` | Collaborative YAML Playbook service and Tern side-pane form cards: supports joint `task`/`design` block editing, external reference expansion, `eval` `judge` checks, Run timelines and frozen subagent Launches with live `block_changed` notices. Its install validation requires Tern's `tern` command on `PATH` (supplied by the Tern desktop app), and a failed install stops the whole updater apply, so it is opt-in: uncomment it on machines with Tern |

### todo-more

[omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) loads through ordinary plugin discovery in both full and light mode while native Todo stays off (`todo.enabled: false`):

- **Branch snapshot vs host projections**: the `mouriya.omp.todo-more` custom entry on the current session branch is the primary state record (storing `{objective, measure, doneWhen}` plus each item's `{title, explanation}`, minute budget and git commit SHA recorded on `DONE`); the host `TodoTracker`, `/todo` and historical cards are projections. Its `planning.ts` blocks `edit` when the list is empty, and `before_agent_start` re-attaches `todo` to `task:*` subagents from which the host executor stripped it.
- **Native `/todo-more` editor**: typing `/todo-more` in OMP/Tern edits the goal or item explanations directly (Enter inserts a newline, Tab/Shift+Tab switches fields, Ctrl+Enter saves, Esc discards), committing only the edited field on the current branch without altering status/order or starting a model turn.
- **Safe retirement of legacy local modules**: once the updater confirms `omp-todo-more` is enabled in OMP's catalog with `./index.ts` present, both modes unlink the 8 legacy Todo paths (`extensions/todo-more/{index,tool,render,reminders,planning}.ts`, `extensions/_shared/todo-more.ts`, `extensions/subagent-todo.ts`, `extensions/subagent-todo/index.ts`) and, when the plugin includes `src/ctx`, the 5 legacy ctx paths (`extensions/ctx-tool/{index,inventory,post-compact-hint}.ts`, `extensions/ctx-tasklog/index.ts`, `extensions/_shared/task-log.ts`). Only leaf files/links are unlinked; reverse sync excludes all 13 paths.

### Thinking translation

`omp-thinking-translator` reads its ordered candidate chain from `~/.omp/agent/thinking-translator.json`, starting every translation request at the first model and falling back to the next only on failure (re-reading the config at the start of the next message). The repository's 5-model chain is:

1. `futureppo-pool/deepseek-v4.1-flash` (`effort: "low"`)
2. `futureppo-pool/grok-4.7` (`effort: "minimal"`)
3. `commandcode/inclusionai/ling-3.1-flash:free` (`effort: "minimal"`)
4. `commandcode/poolside/laguna-s-2.1-free` (`effort: "minimal"`)
5. `commandcode/stealth/glyph-cluster:free` (`effort: "minimal"`)

Because auto-discovered compatibility metadata for `futureppo-pool` omits `reasoning_effort`, add per-model overrides under the existing provider in the machine's `~/.omp/agent/models.yml` (machine-local, never synced), then restart OMP and verify with `/thinking-translator status` and a live translation:

```yaml
providers:
  futureppo-pool:
    modelOverrides:
      deepseek-v4.1-flash:
        compat:
          supportsReasoningEffort: true
      grok-4.7:
        compat:
          supportsReasoningEffort: true
```

---

## Dual Runtime Modes: Full Mode vs omp-light

Full mode (`omp`) runs the complete suite of dispatch gates, sideband judges and mandatory advisors for heavy engineering; quick questions and small edits do not need that ceremony tax. `omp-light` launches a trimmed process whose overrides apply only to that process without modifying any files on disk, partitioning all 22 local extensions into **10 disabled + 1 path-excluded + 11 retained**:

| Dimension | Full mode (`omp`) | Light mode (`omp-light`) |
|---|---|---|
| Appended system prompt | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md` (currently empty) |
| Proactive delegation (`task.eager`) | `preferred` | `default` (less proactive delegation; subagents remain available) |
| **10** local extensions disabled via `disabledExtensions` | All enabled | Disabled: `doc-polish`, `fork-task`, `isolation-nudge`, `lang-nag`, `task-completion-judge`, `task-split-check`, `tool-policy-nag`, `turn-judge`, `user-prompt-inject`, `watchdog-agent` |
| **1** trailing extension excluded via `extensions: []` | `system-prompt-replace` enabled | `config-light.yml` sets `extensions: []` to drop `extensions-last/system-prompt-replace` (`disabledExtensions` filters by module name and cannot reach file-path entries); `omp-light.ts` reads the machine's `config.yml` and passes every non-`/extensions-last/` entry (such as `~/.claude`) back via `-e` |
| **11** local extensions kept enabled | Enabled | Enabled: `antigravity-wire-profiles`, `append-system-model`, `child-memory-warning`, `commandcode-model-spec`, `harness-restart`, `input-polish`, `model-compaction`, `omomp-lang`, `omp-config-autoupdate`, `repo-rules`, `wt-tool` |
| Installed plugins (`omp-todo-more`'s `todo` and `ctx` included) | All loaded | All loaded (`disabledExtensions` does not filter plugins) |
| Tool availability difference | Full toolset | Only `polish_doc` and `fork_task` disappear; `todo`, `ctx`, `wt`, `wt_remove` and `harness_restart` remain available |

**Cross-platform launcher installation:** automatic update and `/update-omp` install `agent/omp-light.ts` into the directory of `omp` on PATH (an executable `0755` `omp-light` on POSIX; `omp-light.ts` plus a generated `omp-light.cmd` on Windows). `omp-light` reads `config-light.yml` and `APPEND_SYSTEM_LIGHT.md` from `PI_CODING_AGENT_DIR` (or `~/.omp/agent` when unset), exits immediately if either file is missing, and forwards all trailing CLI arguments to `omp`.
