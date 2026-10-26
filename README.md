# omp-config

English | [简体中文](README.zh-CN.md)

This configuration is built around four practical problems in long-running `omp` sessions:

1. **Prompt rules alone do not hold across long tasks.** Models eventually take shortcuts such as shelling out to `cat`/`sed -i`/`rg` instead of `read`/`edit`/`grep`, and once tool conventions slip, project rules in `CLAUDE.md` slip with them. Anything that can be checked at runtime is therefore checked by tools or hooks: file edits require a `read` hashline snapshot (`edit.mode: hashline`), main-session shell and eval calls are checked by `bashInterceptor` and [`tool-policy-nag`](docs/extensions.md#tool-policy-nag), and ongoing or finished turns are checked by [`watchdog-agent`](docs/extensions.md#watchdog-agent) and [`turn-judge`](docs/extensions.md#turn-judge).
2. **A long session's context holds agreed requirements and ruled-out options, not just file caches.** Compaction, reading only `grep` snippets instead of full design files, or piping command output through `head`/`tail` drops constraints already settled with the user. The config orders compaction methods from least to most lossy, turns off early background summarization (`compaction.asyncEnabled: false`), raises thresholds for large-window models ([`model-compaction`](docs/prompts-and-context.md#model-compaction)), and copies the full conversation when a subagent needs that background ([`fork-task`](docs/prompts-and-context.md#fork-task)).
3. **`todo` ([`omp-todo-more`](docs/plugins-and-modes.md#todo-more)) sits between a normal chat session and `/goal`.** It keeps `/goal`'s pressure on objectives and completion conditions (prompting the agent to continue while open items remain unless a user decision is needed), while allowing tasks, phases, estimates, and blocked states to change during execution. State transitions and `DONE` commits form logical checkpoints, and `omp-todo-more` re-injects the Todo state, [`Task log`](docs/prompts-and-context.md#task-log), and [`ctx`](docs/prompts-and-context.md#ctx) subagent tree across compaction rounds. When a GPT main agent stops in prose before finishing assigned work, [`turn-judge`](docs/extensions.md#turn-judge) (`TURN-JUDGE-gpt-talk-only.md`) sends it back to continue with tools.
4. **Subagents are designed around three points: cross-model complementarity, multi-subscription cost, and strict role boundaries.** First, at the cost of a small amount of runtime latency, routing work through different subagents lets models complement each other — such as GPT `sol`'s conservatism, GPT `luna`'s low cost, and Claude Opus's open-ended design — keeping different models' reasoning within a narrow variance range. Second, binding tiers across different subscriptions (`anthropic`, `openai-codex`, `opencode-go`, `bansos`) lowers the overall blended cost. Third, subagents are not treated as fixed workflow nodes or human-style role-play personas (built-in `scout`, `reviewer`, etc. are all disabled): when a model writes a subagent prompt, it passes its own framing to the child as work outsourcing, so execution follows Claude Code's model of a general-purpose, disposable `task` runner (`task:high/mid/low/free` split only by cost and trust) orchestrated by the stronger main agent and checked at dispatch/handoff by [`task-split-check`](docs/extensions.md#task-split-check), [`isolation-nudge`](docs/extensions.md#isolation-nudge), and [`task-completion-judge`](docs/extensions.md#task-completion-judge). A predefined non-`task` role exists not to inspire thinking through persona play, but to hold a strict boundary (for example, keeping an advisor from being led by the main agent's framing or replacing the main agent's own judgment), which requires runtime mechanisms beyond a prompt ([`user-prompt-inject`](docs/agents.md#user-prompt-inject), read-only tools on `discuss:*`, and `tools: []` on `mentor:default`), so non-`task` roles are kept to those three.

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
