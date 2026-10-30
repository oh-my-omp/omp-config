# omp-config

English | [简体中文](README.zh-CN.md)

This configuration is organized around the following design choices:

1. **Eliminate duplication and internal contradictions across the system prompt.** Any non-minimal harness ships predefined text across its base template, built-in tool descriptions, and subagent wrappers that easily duplicates or conflicts with local rules, and models ignore instructions that contradict each other. Using Pi/OMP's full customization across the Handlebars base template, personality slot, appendices, and `before_agent_start` hooks, this repository removes duplicate per-tool prose from `SYSTEM_TEMPLATE.md` uses [`tool-topics`](docs/extensions.md#tool-topics) to cut each rendered tool description down to its common call instructions plus a `Topics` index, with the detailed call instructions OMP's terse built-in descriptions leave out served on demand as `tool://<tool>/<topic>`, and uses [`system-prompt-replace`](docs/prompts-and-context.md#system-prompt-replace) for the remaining wording-level edits (such as stripping the built-in child sentence that forbids Todo tracking), so each instruction appears once without contradiction.
2. **Use `read` + hashline `edit` for file operations, and use tool-routing violations as a trigger to re-anchor the system prompt.** Allowing `eval` or composed shell commands for routine file lookup and editing leads models to modify matched lines without reading surrounding context; in long tasks the token cost of reading adjacent context is small, whereas blind edits in shell commands, scripts, and configs that lack compiler or test coverage cause direct damage, so the config enables `edit.mode: hashline` (requiring a non-`:raw` `read` snapshot tag before anchored edits) and prohibits local file lookup in `eval`. At the same time, frontier models (Claude Opus included) progressively ignore static system prompts over long sessions. [`tool-policy-nag`](docs/extensions.md#tool-policy-nag) treats tool-routing violations as an observable proxy signal for system-prompt drift and injects a user-role steer phrased as a user observation — which receives higher instruction priority than static system prompts under opaque provider schemas — to pull the model's attention back to the entire system prompt. Its heuristic detector intentionally retains a high false-positive rate: inspecting model thinking blocks after triggers shows that false positives cost only a small number of self-check tokens with no observed downside. Mid-run and end-of-turn states are additionally checked by [`watchdog-agent`](docs/extensions.md#watchdog-agent) and [`turn-judge`](docs/extensions.md#turn-judge).
3. **Defer lossy compaction and preserve settled constraints.** A long session's context records user-confirmed requirements and ruled-out options alongside file contents; early compaction or truncated command output drops those constraints. The config orders compaction methods from least to most lossy (`remote → soft → snapcompact → handoff → shake`), disables 32k-token early background summarization (`compaction.asyncEnabled: false`), sets per-model thresholds via [`model-compaction`](docs/prompts-and-context.md#model-compaction), and copies the active branch via [`fork-task`](docs/prompts-and-context.md#fork-task) when a subagent needs the full conversation background.
4. **`todo` ([`omp-todo-more`](docs/plugins-and-modes.md#todo-more)) sits between an ordinary session and `/goal`.** It retains `/goal`'s enforcement of objectives, completion criteria (`objective`/`measure`/`doneWhen`), and unfinished work while allowing phases, items, time estimates, and blocked states to be revised during execution. State transitions and `DONE` commits form logical checkpoints, and across compaction rounds `omp-todo-more` re-injects the Todo snapshot, [`Task log`](docs/prompts-and-context.md#task-log), and [`ctx`](docs/prompts-and-context.md#ctx) subagent tree.
5. **Subagents are structured around model complementarity, multi-subscription cost distribution, and role boundaries.** First, trading a small amount of call latency across subagents lets different models complement one another (such as `gpt-*-sol`'s conservatism, `gpt-*-luna`'s low cost, and `claude-opus`'s open-ended design), keeping reasoning variance bounded. Second, binding tiers and fallback chains across separate subscriptions and free channels (`anthropic`, `openai-codex`, `opencode-go`, `bansos`) distributes load to lower blended cost. Third, task execution is separated from role boundaries: because a parent agent's prompt passes its own assumptions into the child, execution uses stateless `task:high/mid/low/free` runners orchestrated by the main agent rather than fixed workflow nodes or role-play personas (built-in `scout`, `reviewer`, etc. are disabled), with dispatch and handoff checked by [`task-split-check`](docs/extensions.md#task-split-check), [`isolation-nudge`](docs/extensions.md#isolation-nudge), and [`task-completion-judge`](docs/extensions.md#task-completion-judge). Predefined non-`task` roles exist only where a strict boundary must be held — keeping advisors independent of the caller's framing without replacing the main agent's judgment — enforced at runtime by [`user-prompt-inject`](docs/agents.md#user-prompt-inject), read-only tools on `discuss:*`, and `tools: []` on `mentor:default`, so only `discuss:steady`, `discuss:divergent`, and `mentor:default` are defined.

## Documentation

| Page | Contents |
|---|---|
| [Prompts and Context](docs/prompts-and-context.md) | Prompt layering (`SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM.md`, `tool-topics`, `system-prompt-replace`, `append-system-model`, `repo-rules`) and context retention (`fork-task`, `model-compaction`, `ctx`, `Task log`) |
| [Subagents](docs/agents.md) | The 7 selectable worker/advisor definitions plus internal `fork:self`, model bindings, advisor context, dispatch rules, and worktree isolation |
| [Local Extensions](docs/extensions.md) | 26-extension index, dispatch/yield gates (`isolation-nudge`, `task-split-check`, `task-completion-judge`), `JUDGE`-backed monitors (`tool-policy-nag`, `watchdog-agent`, `turn-judge`, `lang-nag`), the literal-path `delete` tool (`delete-guard`), host/TUI extensions, and the `session://` reader for other sessions (`session-urls`) |
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
bun run test                  # bun test ci: session-urls scanner differential and type-filter tests
./plugin-audit.sh             # compare install-plugins.sh against `omp plugin list`
bun ci/check.ts               # isolated HOME install + full and light RPC session check
```
