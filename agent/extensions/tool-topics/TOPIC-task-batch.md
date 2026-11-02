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
- `agent()`/`workpool()` return results to the cell, so a cell can build the next wave from them. They skip this setup's split and isolation checks and take no `solutionSpace`: use them only when the cell itself must consume results.
- Concurrency and job caps: `tool://task/limits`.
