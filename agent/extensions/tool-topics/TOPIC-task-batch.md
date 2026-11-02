---
tool: task
name: batch
title: Templated batch dispatch from eval
when: before dispatching many items built from a template, or in waves
upstream: pi-coding-agent@18.13.2 src/eval/js/tool-bridge.ts, src/extensibility/extensions/wrapper.ts, src/eval/agent-bridge.ts, omp://tools/eval.md § Subagents
---
# Templated batch dispatch from eval

- Build `tasks` in an eval cell and dispatch with `await tool.task({context, tasks: items.map(...)})`; send later waves from later cells. Every item still carries `task` and `solutionSpace`; homogeneous items may share one `solutionSpace`.
- It is this same tool: the same `tool_call` checks (split, report length, isolation) and per-item fields apply. Items no longer launch while the call streams. The call returns once the children are spawned; their results arrive in your conversation, not in the cell.
- When code must compute on the results (merge, count, transform, build the next wave), use `completion`, `judgeBatch` or `agent(…, { schema })` in the cell instead: `tool://eval/workflow`. Those children skip this setup's split and isolation checks and take no `solutionSpace`.
- Concurrency and job caps: `tool://task/limits`.
