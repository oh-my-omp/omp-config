---
tool: task
upstream: pi-coding-agent@19.1.1 src/prompts/tools/task.md, src/prompts/tools/task-async-contract.md, src/task/types.ts, src/task/settings.ts
---
Spawn `tasks[]` concurrently; IDs return immediately. Results auto-deliver; NEVER poll. Completely blocked? Call `wait`. Coordinate while peers run via `write agent://<id>` (`agent://all` broadcasts; main agent only).
When `fork_task` is available and a child needs the current session's full conversation context instead of starting blank, use `fork_task` (`help://fork_task/limits`): it shares the same `agent://<id>` results/messaging, `wait`, and structured output contracts.
`completed`: the subagent yielded; claimed artifacts are unverified.

{{native?:Results}}

# Delegation
Choose and dispatch agents according to each agent's definition text (its description).
Always set `agent` explicitly inside each `tasks[]` item; never rely on the default and never put `agent` at the top level. User says `parallel` or `parallelize` → use task subagents, not merely parallel tool calls.
Concurrent writers MUST use `isolated: true`, with non-overlapping file/state ownership and one integration owner. Research-only agents stay shared so they remain reachable. Use repository-relative paths for isolated assignments; identify pre-existing parent changes. Siblings coordinate via `write agent://<id>`. Set interfaces in `context`.
Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.
User-tagged model agents `m<N>` (`<model agent="m<N>" name="…"/>`) are pinned models, not specialists; spawn one only when the user names it.

# Inputs
`name`: CamelCase ≤32, unique within the call, auto-generated if omitted; address the agent by name.
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
`isolated`: own worktree; successful changes merge back into the parent.
`tools`: names of tools you defined in an eval cell; the child may call them and they run in your kernel (`help://eval/tools`).
{{native-bullet?:effort}}
{{native-bullet?:model}}
{{native-bullet?:schemaMode}}
Children spawned by `task` start blank (no conversation history; use `fork_task` when available to inherit full conversation context). Large payloads via `local://<path>`, NEVER inline.

# Format
`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).
`steps`: ordered stages for one agent, each sent only after it finishes the previous one; earlier stages' reports arrive as progress messages, and the last stage's result is the run's result. First step carries `# Target` files/non-goals beyond `context`; each step is one `# Change` stage; the last step adds `# Acceptance`; independent work goes to separate tasks.
`task` and `steps` are mutually exclusive: send exactly one per item, `steps` while the `task.steps` setting is on and `task` while it is off.

{{native:Available Agents}}
