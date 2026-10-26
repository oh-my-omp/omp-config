# Subagents

[Home](../README.md) · English | [简体中文](agents.zh-CN.md)

`agent/config.yml` disables OMP's 5 built-in subagents (`task`, `scout`, `sonic`, `reviewer`, `security-reviewer`) in `task.disabledAgents`; they are rejected at preflight even if listed in `spawns`. All subagent calls go through the 7 definitions in `agent/agents/*.md` (see [`agent/agents/README.txt`](../agent/agents/README.txt) for frontmatter rules and pitfalls; keep notes in `agent/agents/` as `.txt` so OMP does not parse them as agent definitions).

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

## Advisor Context and `user-prompt-inject`

By default, a subagent only sees the prompt its caller passes in `task` and `context`. Three settings keep `mentor:default`, `discuss:steady`, and `discuss:divergent` grounded in the user's actual request and the repository's code:

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
- **Recursion depth limit (depth 2)**: the main session is depth 0 and its children are depth 1. Only `task:high` can spawn depth-2 children; OMP strips the `task` tool at depth 2 (so depth-2 workers cannot spawn `mentor:default` either) and they must receive directly executable leaf tasks.
- **Explicit `agent`, no `effort` override**: always set `agent` on each task item (omitting it falls back to the first `spawns` entry or a disabled built-in agent) and omit `effort` unless the user asks for it (`task.enableEffort: false` hides the parameter). `config.yml` retains model bindings for built-in `task` and `sonic` only for Vibe mode's first-level dispatch.
- **Worker workflow**: each `task:*` worker must read the relevant code, review its plan with `mentor:default` before editing (except at depth 2), and track its steps in `todo` without yielding while open items remain or using `drop`/`rm` to shrink the assignment.
- **Parallel writers and `isolated: true`**: when $\ge 2$ writing workers run concurrently on the same repository (within one batch, or while an earlier shared writer job is still running), every writer must set `isolated: true` (`fork_task` defaults to `true`; read-only research agents use `isolated: false` so they stay reachable via `write agent://<id>`; plan mode forces shared directories). Pass repository-relative paths in isolated assignments because OMP enforces worktree boundaries through prompting and absolute paths point back to the parent checkout. `task.isolation.merge: branch` cherry-picks each worker's commits onto the parent branch with commit messages and todo-more `Model` trailers preserved; check the task result for `Merged branch: <name>` (or `No changes to apply.`).
