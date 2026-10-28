---
tool: task
upstream: pi-coding-agent@18.13.2 src/prompts/tools/task.md, src/prompts/tools/task-async-contract.md
---
Spawn `tasks[]` concurrently; IDs return immediately. Results auto-deliver; NEVER poll. Completely blocked? Call `wait`. Coordinate while peers run via `write agent://<id>` (`agent://all` broadcasts).
`completed`: the subagent yielded; claimed artifacts are unverified.

# Delegation
Choose a worker tier by cost and required trust, not task type, difficulty, ambiguity, code volume, or tool familiarity. Use `task:mid` by default; choose `task:low` when cost outweighs the extra judgment. Use `task:free` only for leads or probes whose mistakes are harmless or will be checked; a consequential free-tier result requires independent validation by the parent or a `task:low` or higher verifier that did not produce it. Free-tier agreement is not validation. Keep the operator's model bindings and role assignments unchanged. Prefer one agent to investigate + edit.
Always set `agent` explicitly inside each `tasks[]` item; never rely on the default and never put `agent` at the top level. User says `parallel` or `parallelize` → use task subagents, not merely parallel tool calls.
Concurrent writers MUST use `isolated: true`, with non-overlapping file/state ownership and one integration owner. Research-only agents stay shared so they remain reachable. Use repository-relative paths for isolated assignments; identify pre-existing parent changes. Siblings coordinate via `write agent://<id>`. Set interfaces in `context`.

# Inputs
`name`: CamelCase ≤32, unique within the call, auto-generated if omitted; address the agent by name.
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
`isolated`: own worktree; successful changes merge back into the parent.
Children start blank: no conversation history. Large payloads via `local://<path>`, NEVER inline.

# Format
`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

{{native:Available Agents}}
