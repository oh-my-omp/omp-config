# Subagents

[Home](../README.md) · English | [简体中文](agents.zh-CN.md)

`agent/config.yml` disables OMP's 5 built-in subagents (`task`, `scout`, `sonic`, `reviewer`, `security-reviewer`) in `task.disabledAgents`; they are rejected at preflight even if listed in `spawns`. `agent/agents/*.md` contains 7 selectable worker/advisor definitions plus internal `fork:self`, used only when a `fork_task` item omits `agent` (see [`agent/agents/README.txt`](../agent/agents/README.txt) for frontmatter pitfalls; keep non-agent notes as `.txt`).

The subagent setup follows these design principles:
1. **Cross-model complementarity**: trading a small amount of call latency across subagents combines distinct model traits — `gpt-*-sol` for conservative analysis (`discuss:steady`, `mentor:default`, `task:mid`), `gpt-*-luna` for low-cost execution and fallbacks (`task:low`), and `claude-opus` for open-ended design (`discuss:divergent`, `task:high`) — keeping reasoning variance bounded across models.
2. **Cost distribution across subscriptions**: binding worker and advisor chains across separate subscriptions and free channels (`anthropic`, `openai-codex`, `opencode-go`, `bansos`) spreads quota usage to lower blended cost.
3. **Stateless `task` runners vs runtime-bounded advisor roles**: because a parent agent's prompt passes its own framing into the child, general execution uses stateless `task` runners (`task:high/mid/low/free`, differentiated by cost and trust) orchestrated by the main agent rather than fixed workflow nodes or role-play personas (built-in `scout`, `reviewer`, and `security-reviewer` are disabled). Predefined non-`task` roles are introduced only when a strict role boundary is required — keeping advisors independent of the caller's summary without taking over the main agent's decision — and are enforced through runtime constraints ([`user-prompt-inject`](#user-prompt-inject) injecting root user prompts, read-only tools on `discuss:*`, and `tools: []` on `mentor:default`), limiting non-`task` roles to `discuss:steady`, `discuss:divergent`, and `mentor:default`.

## Subagent Definitions and Model Bindings

Responsibilities, tool limits, and `spawns` lists live in `agent/agents/<name>.md`; model chains live in `agent/config.yml` under `task.agentModelOverrides` (when a model change alters a tier's class or cost, update its `description` in `agent/agents/<name>.md` and this table together):

| Subagent | Cost in `description` (per 1M tokens) | Model chain in `config.yml` | Allowed `spawns` / `tools` | Role and limits |
|---|---|---|---|---|
| `task:high` | Claude Opus 5.5, ~$0.45 | `anthropic/claude-opus-5-5:high` | `spawns: task:mid, task:low, task:free, task:high, discuss:steady, discuss:divergent, mentor:default` | Requires explicit user permission in the current conversation. Handles design and core work, and is the only worker that can spawn depth-2 children (`task:mid` is listed first as the default spawn), owning contracts, acceptance, and integration for its batch. |
| `task:mid` | Opus class, ~$0.30 | `openai-codex/gpt-6-1-sol:high` | `spawns: mentor:default` | Default worker tier for implementation, investigation, debugging, and verification outside design and core work; settles disagreements between cheaper workers. |
| `task:low` | Opus class, ~$0.01 | `openai-codex/gpt-5.6-luna:max` | `spawns: mentor:default` | Used when cost outweighs extra judgment (bulk mechanical edits, lookups, routine checks) and to independently validate `task:free` results. |
| `task:free` | Opus class, $0.00 | `bansos/muse-spark-1.3-contributor:xhigh, opencode-go/muse-spark-1.3-contributor:xhigh, openai-codex/gpt-6-luna:max` | `spawns: mentor:default` | For leads, candidates, and probes whose errors are harmless or will be checked. Any consequential result must be verified by the parent or `task:low+`; agreement among `task:free` workers is not validation. |
| `discuss:divergent` | — | `anthropic/claude-opus-5-5:medium, openai-codex/gpt-5.6-luna:max` | `tools: read, grep, glob` | Read-only discussion partner (expansive stance): questions the problem framing and constraints, and proposes materially different alternatives (deleting the feature, changing state ownership, solving the class) with `path:line` citations and trade-offs. |
| `discuss:steady` | — | `openai-codex/gpt-5.6-sol:medium` | `tools: read, grep, glob` | Read-only discussion partner (conservative stance): checks proposals against the code with `path:line` citations, surfacing hidden assumptions, unhandled states, migration risks, and simpler alternatives. |
| `mentor:default` | — | `openai-codex/gpt-5.6-sol:high, openai-codex/gpt-5.6-luna:max` | `tools: []` (`yield` only) | Tool-less mentor: consulted before long investigations to sharpen the plan and after work to review what changed, what ran, and what remains unverified. Must place its full reply inside `yield`. |
| `fork:self` | Caller’s current model | Pinned by `fork_task`, not a tier binding | Caller’s tool order; available `yield` appended; native depth/policy limits still apply | Internal self-fork dispatch identity. Omit `agent` in `fork_task`; never select this definition through ordinary `task`. |

## Advisor Context and `user-prompt-inject`

By default, a subagent only sees the prompt its caller passes in `task` and `context`. The following settings keep `mentor:default`, `discuss:steady`, and `discuss:divergent` grounded in the user's actual request and the repository's code:

1. [`user-prompt-inject`](#user-prompt-inject) prepends the human user's prompts from the root main session to every model call of `mentor:default`, `discuss:steady`, and `discuss:divergent`.
2. Consequential decisions consult both `discuss:steady` and `discuss:divergent`; follow-ups on the same topic message the existing agent via `write agent://<id>`.
3. `mentor:default` has `tools: []`, so the calling agent must write out the concrete file paths, symbols, commands, and observed outputs it relies on rather than passing file names for the mentor to open.

### user-prompt-inject

Source: `agent/extensions/user-prompt-inject/`.

On every subagent `context` event (initial spawn, `write agent://<id>` wakes, and parked resumes), walks `ctx.agent.parentId` in `AgentRegistry` up to the root main session (including from depth-2 grandchildren spawned by `task:high`), reads non-empty text messages on the main session's active branch (`getBranch()`, pre-compaction messages included) with `role: "user"`, `attribution: "user"`, and not `synthetic`, renders matching `PROMPT-INJECT-<label>.md` templates, and prepends one request-only developer message (`<user-prompt-inject name=…>`) without persisting it to the session file:

- **Template discovery**: scans `~/.omp/agent/extensions/user-prompt-inject/PROMPT-INJECT-*.md` and `<dir>/PROMPT-INJECT-*.md` / `<dir>/.omp/PROMPT-INJECT-*.md` from `cwd` up to the git root. The repository ships `PROMPT-INJECT-user-goal.md` (`target: mentor:default, discuss:steady, discuss:divergent`, `name: user-goal`, `enabled: true`, body using `{{user_prompt[0:e]}}`).
- **Placeholders**: `{{user_prompt[0]}}` (first), `{{user_prompt[-1]}}` (latest), and `{{user_prompt[a:e]}}` (half-open slice supporting negative indices, rendering each item as `<user_prompt index="N">…</user_prompt>`). Any other `{{user_prompt…}}` syntax logs a warning and skips the file.
- **`attribution: "agent"` on extension messages**: `pi.sendUserMessage` defaults to `attribution: "user"` when omitted. Every extension in this repository that sends user-role messages (`watchdog-agent`, `turn-judge`, `tool-policy-nag`, `doc-polish`, `wt-tool`, `harness-restart`, `child-memory-warning`) passes `attribution: "agent"` so extension messages are not collected as human prompts.

## Dispatch Rules and Worktree Isolation

- **Tier selection**: use `task:mid` by default; use `task:low` when cost outweighs extra judgment (mechanical edits, lookups, validating `task:free` — a slice that requires verification before use is cheaper to run once on `task:low` than on `task:free` plus a validator). Architecture, domain types, cross-slice interfaces, and doc/prompt/skill/agent-definition design must not be assigned to `task:free`, `task:low`, or `task:mid`.
- **Recursion depth limit (depth 2)**: the main session is depth 0 and its children are depth 1. `task:high` is the worker tier that can fan out executable task slices; self forks retain native spawn/depth limits. OMP strips the `task` tool at depth 2, so grandchildren must receive directly executable leaf tasks.
- **`agent` and `effort`**: ordinary `task` requires an explicit `agent` to avoid a disabled default. In `fork_task`, omit `agent` to clone the caller or name an agent for a context handoff; `from` still requires `agent`. Omit `effort` unless the user asks. Self forks preserve caller request controls; explicit-agent forks follow their tier binding.
- **Worker workflow**: each `task:*` worker must read the relevant code, review its plan with `mentor:default` before editing (except at depth 2), and track its steps in `todo` without yielding while open items remain or using `drop`/`rm` to shrink the assignment.
- **Parallel writers and `isolated: true`**: when two or more writing agents run concurrently on the same repository, every writer must explicitly use `isolated: true`. A self fork defaults to shared cwd; an explicit-agent fork defaults to isolated. Read-only shared agents remain reachable for follow-ups; plan mode forces shared read-only children. Use repository-relative paths inside isolated assignments. `task.isolation.merge: branch` cherry-picks child commits with their messages and Todo trailers; check the returned merge/no-change result.
