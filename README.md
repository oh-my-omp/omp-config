# omp-config

English | [简体中文](README.zh-CN.md)

## Installation

Use `/onboard-omp` as the installation entry point for omomp. With [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi) already installed, clone this repository and start `omp` at its root:

```bash
git clone https://github.com/oh-my-omp/omp-config.git
cd omp-config
omp
```

Inside the `omp` session, run:

```text
/onboard-omp
```

The agent starts with a read-only walkthrough of your existing rules and skills, explains what omomp can replace or add, and helps you choose customizations in your language. When you explicitly ask it to install omomp, it adapts the setup and applies it through the `/update-omp` workflow. Running `/onboard-omp` alone does not install the configuration. See [Setup, Sync and Maintenance](docs/operations.md#maintenance-workflows) for diagnosis, updates and sync.

## Design

The full omomp setup is designed for a high-capability main agent: orchestration and supervision strengthen its execution and help maintain task quality, while the same demands are a heavy burden for a lower-capability main agent. Personal and domain-specific rules deliberately remain with the user. Onboarding starts with the machine's existing global rules and skills, explains which semantic constraints omomp mechanisms can take over and what capabilities they add, then uses the component walkthrough as a supplement.

This configuration is organized around the following design choices:

1. **Eliminate duplication and internal contradictions across the system prompt.** Any non-minimal harness ships predefined text across its base template, built-in tool descriptions, and subagent wrappers that easily duplicates or conflicts with local rules, and models ignore instructions that contradict each other. Using Pi/OMP's Handlebars base template, personality slot and appendices, this repository removes duplicate per-tool prose from `SYSTEM_TEMPLATE.md`; [`tool-topics`](docs/extensions.md#tool-topics) reduces OMP's own tool instructions to common call instructions plus a `Topics` index, with detailed instructions served on demand as `tool://<tool>/<topic>` (extension and plugin tools keep their own descriptions), and [`system-prompt-replace`](docs/prompts-and-context.md#system-prompt-replace) handles the remaining wording-level edits (such as stripping the built-in child sentence that forbids Todo tracking), so each instruction appears once without contradiction. Extensions leave OMP's system prompt and tool definitions as OMP built them and add their customization as [delta messages](docs/prompts-and-context.md#prompt-files) appended to the conversation: OMP drops a hook's system-prompt rewrite after every prompt and agent-initiated turns skip the hook, so a rewrite reaches only some requests and rewrites the prompt cache each time it comes and goes, while a delivered delta stays in the history.
2. **Use `read` + hashline `edit` for file operations, and use tool-routing violations as a trigger to re-anchor the system prompt.** Allowing `eval` or composed shell commands for routine file lookup and editing leads models to modify matched lines without reading surrounding context; in long tasks the token cost of reading adjacent context is small, whereas blind edits in shell commands, scripts, and configs that lack compiler or test coverage cause direct damage, so the config enables `edit.mode: hashline` (requiring a non-`:raw` `read` snapshot tag before anchored edits) and prohibits local file lookup in `eval`. At the same time, frontier models (Claude Opus included) progressively ignore static system prompts over long sessions. [`tool-policy-nag`](docs/extensions.md#tool-policy-nag) treats tool-routing violations as an observable proxy signal for system-prompt drift and, once the offending call has run, attaches a reminder phrased as a direct observation to that call's result (a developer-role context message), pulling the model's attention back to the entire system prompt without interrupting the turn's other running calls. Its heuristic detector intentionally retains a high false-positive rate: inspecting model thinking blocks after triggers shows that false positives cost only a small number of self-check tokens with no observed downside. Mid-run and end-of-turn states are additionally checked by [`watchdog-agent`](docs/extensions.md#watchdog-agent) and [`turn-judge`](docs/extensions.md#turn-judge).
3. **Defer lossy compaction and preserve settled constraints.** A long session's context records user-confirmed requirements and ruled-out options alongside file contents; early compaction or truncated command output drops those constraints. The config orders compaction methods from least to most lossy (`remote → soft → snapcompact → handoff → shake`), disables 32k-token early background summarization (`compaction.asyncEnabled: false`), sets per-model thresholds via [`model-compaction`](docs/prompts-and-context.md#model-compaction), and hands a subagent the full conversation background through the [omp-subagent-more](https://github.com/oh-my-omp/omp-subagent-more#readme) plugin's `fork_task` when needed.
4. **[`omp-todo-more`](https://github.com/oh-my-omp/omp-todo-more#readme) owns Todo and `ctx`, running on top of native Todo, which `config.yml` keeps on (`todo.enabled: true`).** Tool documentation: `xd://todo`, `xd://ctx`.
5. **Subagents are structured around model complementarity, multi-subscription cost distribution, and role boundaries.** First, trading a small amount of call latency across subagents lets different models complement one another (such as `gpt-*-sol`'s conservatism, `gpt-*-luna`'s low cost, and `claude-opus`'s open-ended design), keeping reasoning variance bounded. Second, binding tiers and fallback chains across separate subscriptions and free channels (`anthropic`, `openai-codex`, `opencode-go`, `bansos`) distributes load to lower blended cost. Third, task execution is separated from role boundaries: because a parent agent's prompt passes its own assumptions into the child, execution uses stateless `task:high/mid/low/free` runners orchestrated by the main agent rather than fixed workflow nodes or role-play personas (built-in `scout`, `security-reviewer`, etc. are disabled), with dispatch and handoff checked by [`task-split-check`](docs/extensions.md#task-split-check), [`isolation-nudge`](docs/extensions.md#isolation-nudge), and [`task-completion-judge`](docs/extensions.md#task-completion-judge). Predefined non-`task` roles exist only where a strict boundary must be held — keeping advisors independent of the caller's framing without replacing the main agent's judgment — enforced at runtime by [`user-prompt-inject`](docs/agents.md#user-prompt-inject), read-only tools on `discuss:*`, and `tools: []` on `mentor:default`, so the advisor roles are `discuss:steady`, `discuss:divergent`, and `mentor:default`. `reviewer` is a repository copy of OMP's bundled review agent, the base for a customized review role.

## Documentation

| Page | Contents |
|---|---|
| [Prompts and Context](docs/prompts-and-context.md) | Prompt layering (`SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM.md`, `tool-topics`, `system-prompt-replace`, `append-system-model`, `argon-long-output`, `repo-rules`) and context retention (`model-compaction`) |
| [Subagents](docs/agents.md) | The selectable worker/advisor definitions, model bindings, advisor context, dispatch rules, and worktree isolation |
| [Local Extensions](docs/extensions.md) | Index of every local extension, dispatch/yield gates (`isolation-nudge`, `task-split-check`, `task-completion-judge`) and the agent-side `/usage` for subagent dispatch budgets (`subagent-usage`), `JUDGE`-backed monitors (`tool-policy-nag`, `watchdog-agent`, `turn-judge`, `lang-nag`), the bash and eval deletion guard and literal-path `delete` tool (`delete-guard`), and host/TUI extensions |
| [Plugins and Runtime Modes](docs/plugins-and-modes.md) | External plugins in `install-plugins.sh` (`omp-todo-more`, `omp-sessions`, `omp-thinking-translator`, etc.) and `omp` vs `omp-light` |
| [Setup, Sync and Maintenance](docs/operations.md) | Repo ↔ machine ownership rules, `/onboard-omp`, `/update-omp`, `/sync-omp-config`, `omp-config-autoupdate`, `_shared` modules, and upgrade checks |
| [CI Configuration Check (`ci/README.md`)](ci/README.md) | How `bun ci/check.ts` installs `omp`, applies the config, wires the free model and shadow proxy, and deduplicates diagnostics |
| [Test Sandbox (`sandbox/README.md`)](sandbox/README.md) | How `bun sandbox/sandbox.ts` builds a throwaway container with this machine's `~/.omp` config, credentials and the working tree, drives real sessions per model, exports their prompt-cache hits, and removes and ledgers each run |
| [`extensions-last` (`agent/extensions-last/README.md`)](agent/extensions-last/README.md) | Extension load order and why `system-prompt-replace` sits outside `agent/extensions/` |
| [Subagent Authoring Notes (`agent/agents/README.txt`)](agent/agents/README.txt) | Subagent frontmatter, `spawns` lists, the depth-2 recursion limit, and `yield` pitfalls |

## Commands

Slash commands run inside `omp` started at the repository root:

```text
/onboard-omp [check|<plane>]                 # guided installation: explain the setup; adapt and install on explicit request
/update-omp [check]                          # apply working tree -> ~/.omp/agent, omp-light, plugins; keeps local customizations, adapts conflicts
/sync-omp-config [check]                     # copy eligible machine changes -> repo, validate, commit and push
/omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|agent]
                                             # startup auto-update (off by default), update from GitHub now, or adapt local customizations that conflict with upstream
/omomp-changelog [full|last [N]]            # merged changelog of the installed omomp components: the latest 3 release days, `last [N]` or `full`
/migrate-omp-keys <target>                   # copy auth_credentials table to a remote host's agent.db over SSH
```

Shell commands run from the repository root:

```bash
omp                           # full mode
omp-light                     # light mode (skips the governance extensions in config-light.yml)
bun run check                 # biome check . && tsc --noEmit
bun run test                  # bun test ci: delete-guard, tool-policy-nag pty and updater three-way apply tests
./plugin-audit.sh             # compare install-plugins.sh against `omp plugin list`
bun ci/check.ts               # isolated HOME install + full and light RPC session check
```
