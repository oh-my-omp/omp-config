# omp-config

English | [简体中文](README.zh-CN.md)

`omp-config` holds the version-controlled configuration for Oh My Pi (`omp`): settings (`agent/config.yml`, `agent/config-light.yml`, `agent/omomp.yml`, `agent/thinking-translator.json`, `pi/agent/pi-bansos-relay-state.json`), system-prompt files (`agent/SYSTEM_TEMPLATE.md`, `agent/PERSONALITY.md`, `agent/APPEND_SYSTEM.md`, `agent/APPEND_SYSTEM_LIGHT.md`), subagent definitions (`agent/agents/*.md`), local TypeScript extensions (`agent/extensions/`, `agent/extensions-last/`), and the plugin install script (`install-plugins.sh`).

Runtime files stay on the machine and are not tracked here: databases (`*.db*`), session files, model caches (`models.yml`, `commandcode-models.json`), logs, lock files, installed plugins (`~/.omp/plugins/`), and provider credentials.

## Documentation

| Page | Contents |
|---|---|
| [Prompts and Context](docs/prompts-and-context.md) | `SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM.md`, `system-prompt-replace`, `append-system-model`, `repo-rules`, `fork-task`, `model-compaction`, `ctx`, and task logs |
| [Subagents](docs/agents.md) | The 7 custom subagents in `agent/agents/*.md`, model bindings, `user-prompt-inject`, dispatch rules, and worktree isolation |
| [Local Extensions](docs/extensions.md) | Extension table and reference for dispatch/yield checks, `JUDGE`-backed monitors, and host/TUI extensions |
| [Plugins and Runtime Modes](docs/plugins-and-modes.md) | Plugins declared in `install-plugins.sh` (`omp-todo-more`, `omp-thinking-translator`, etc.) and `omp` vs `omp-light` |
| [Setup, Sync and Maintenance](docs/operations.md) | File ownership, `/update-omp`, `/sync-omp-config`, `omp-config-autoupdate`, `_shared` modules, and upgrade checks |
| [CI Configuration Check (`ci/README.md`)](ci/README.md) | How `bun ci/check.ts` installs `omp`, applies the config, wires the free model and shadow proxy, and deduplicates diagnostics |
| [`extensions-last` (`agent/extensions-last/README.md`)](agent/extensions-last/README.md) | Extension load order and why `system-prompt-replace` sits outside `agent/extensions/` |
| [Subagent Authoring Notes (`agent/agents/README.txt`)](agent/agents/README.txt) | Subagent frontmatter, `spawns` lists, the depth-2 recursion limit, and `yield` pitfalls |

## Commands

Slash commands run inside `omp` started at the repository root:

```text
/update-omp [check]                          # apply working tree -> ~/.omp/agent, ~/.pi/agent, omp-light, plugins
/sync-omp-config [check]                     # copy eligible machine changes -> repo, validate, commit and push
/omp-config-autoupdate [status|on|off|run]   # toggle startup auto-update (off by default) or update from GitHub now
/migrate-omp-keys <target>                   # copy auth_credentials table to a remote host's agent.db over SSH
```

Shell commands run from the repository root:

```bash
omp                           # full mode
omp-light                     # light mode (skips 10 extensions and system-prompt-replace)
bun run check                 # biome check . && tsc --noEmit
./plugin-audit.sh             # compare install-plugins.sh against `omp plugin list`
bun ci/check.ts               # isolated HOME install + full and light RPC session check
```
