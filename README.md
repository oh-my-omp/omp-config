# omp-config

English | [简体中文](README.zh-CN.md)

This configuration is built around four practical problems in long-running `omp` sessions:

1. **Prompt rules alone do not hold across long tasks.** Models eventually take shortcuts such as shelling out to `cat`/`sed -i`/`rg` instead of `read`/`edit`/`grep`, and once tool conventions slip, project rules in `CLAUDE.md` slip with them. Anything that can be checked at runtime is therefore checked by tools or hooks: file edits require a `read` hashline snapshot (`edit.mode: hashline`), main-session shell and eval calls are checked by `bashInterceptor` and [`tool-policy-nag`](docs/extensions.md#tool-policy-nag), and ongoing or finished turns are checked by [`watchdog-agent`](docs/extensions.md#watchdog-agent) and [`turn-judge`](docs/extensions.md#turn-judge).
2. **A long session's context holds agreed requirements and ruled-out options, not just file caches.** Compaction, reading only `grep` snippets instead of full design files, or piping command output through `head`/`tail` drops constraints already settled with the user. The config orders compaction methods from least to most lossy, turns off early background summarization (`compaction.asyncEnabled: false`), raises thresholds for large-window models ([`model-compaction`](docs/prompts-and-context.md#model-compaction)), and copies the full conversation when a subagent needs that background ([`fork-task`](docs/prompts-and-context.md#fork-task)).
3. **`todo` ([`omp-todo-more`](docs/plugins-and-modes.md#todo-more)) sits between a normal chat session and `/goal`.** It keeps `/goal`'s pressure on objectives and completion conditions (prompting the agent to continue while open items remain unless a user decision is needed), while allowing tasks, phases, estimates, and blocked states to change during execution. State transitions and `DONE` commits form logical checkpoints, and `omp-todo-more` re-injects the Todo state, [`Task log`](docs/prompts-and-context.md#task-log), and [`ctx`](docs/prompts-and-context.md#ctx) subagent tree across compaction rounds. When a GPT main agent stops in prose before finishing assigned work, [`turn-judge`](docs/extensions.md#turn-judge) (`TURN-JUDGE-gpt-talk-only.md`) sends it back to continue with tools.
4. **Writing code and making architectural or scoping judgments require different models.** The main session keeps architecture, domain types, cross-module interfaces, and final verification, while bounded implementation and investigation slices go to tiered workers (`task:high`, `task:mid`, `task:low`, `task:free`; built-in subagents are disabled). Before dispatch, [`task-split-check`](docs/extensions.md#task-split-check) and [`isolation-nudge`](docs/extensions.md#isolation-nudge) check task splitting, report-length caps, and worktree isolation; before handoff, [`task-completion-judge`](docs/extensions.md#task-completion-judge) checks the result against the assignment, tool history, and Todo state. To keep advisors from echoing a caller's selective summary, [`user-prompt-inject`](docs/agents.md#user-prompt-inject) prepends the root user prompts to `mentor:default`, `discuss:steady`, and `discuss:divergent`, while `mentor:default` has no tools so the caller must state concrete file paths and observed outputs.

## Documentation

| Page | Contents |
|---|---|
| [Prompts and Context](docs/prompts-and-context.md) | Prompt layering (`SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM.md`, `system-prompt-replace`, `append-system-model`, `repo-rules`) and context retention (`fork-task`, `model-compaction`, `ctx`, `Task log`) |
| [Subagents](docs/agents.md) | The 7 custom subagents in `agent/agents/*.md`, model bindings, advisor setup (`user-prompt-inject`, `discuss:steady` / `discuss:divergent`, `mentor:default`), dispatch rules, and worktree isolation |
| [Local Extensions](docs/extensions.md) | 22-extension index, dispatch/yield gates (`isolation-nudge`, `task-split-check`, `task-completion-judge`), `JUDGE`-backed monitors (`tool-policy-nag`, `watchdog-agent`, `turn-judge`, `lang-nag`), and host/TUI extensions |
| [Plugins and Runtime Modes](docs/plugins-and-modes.md) | External plugins in `install-plugins.sh` (`omp-todo-more`, `omp-thinking-translator`, etc.) and `omp` vs `omp-light` |
| [Setup, Sync and Maintenance](docs/operations.md) | Repo ↔ machine ownership rules, `/update-omp`, `/sync-omp-config`, `omp-config-autoupdate`, `_shared` modules, and upgrade checks |
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
