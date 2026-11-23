---
tool: task
name: batch
title: Templated batch dispatch from eval
when: before dispatching many items built from a template, or in waves
upstream: pi-coding-agent@18.22.2 src/eval/js/tool-bridge.ts, src/extensibility/extensions/wrapper.ts, src/eval/agent-bridge.ts, omp://tools/eval.md § Prelude helpers, § judge() and judgment batches, § completion(), § agent()
---
# Templated batch dispatch from eval

- Build `tasks` in an eval cell and dispatch with `await tool.task({context, tasks: items.map(...)})`; send later waves from later cells. Every item still carries `solutionSpace` and exactly one instruction field: `steps` while the `task.steps` setting is on, `task` while it is off; the two are mutually exclusive. `steps` holds ordered stages for that one agent, each sent only after it finishes the previous one, and the last stage's result is that run's result; its first step carries `# Target` files/non-goals beyond `context`, each step is one `# Change` stage, and the last adds `# Acceptance`. Homogeneous items may share one `solutionSpace`.
- It is this same tool: the same `tool_call` checks (split, report length, isolation) and per-item fields apply. Items no longer launch while the call streams. The call returns once the children are spawned; their results arrive in your conversation, not in the cell.
- When code must compute on the results (merge, count, transform, build the next wave), use `completion`, `judgeBatch` or `agent(…, { schema })` in the cell instead: `help://eval/workflow`. Those children skip this setup's split and isolation checks and take no `solutionSpace`.
- Concurrency and job caps: `help://task/limits`.
