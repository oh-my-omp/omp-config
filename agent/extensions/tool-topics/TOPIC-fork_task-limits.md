---
tool: fork_task
name: limits
title: Prerequisites, unsupported fields and source errors
when: before using `from`, or when `fork_task` refuses to start
upstream: agent/extensions/fork-task/index.ts and self.ts; pi-coding-agent@18.13.2 src/task/index.ts, src/task/settings.ts
---
# Prerequisites, unsupported fields and source errors

- Requires background jobs (`async.enabled`), the native `task` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- Omit `agent` for a same-model self fork (shared cwd by default); name `agent` for a context handoff under that agent's model and tools (isolated by default). `shake` is opt-in, and no inherited-size/cost limit exists.
- Not available here: `solutionSpace`, `sourceSession` and `model` are not fork fields; `effort` is ignored (`task.enableEffort: false`); `tools` fails (`eval.tools.enabled: false`); `outputSchema`/`schemaMode` are ignored (`task.structured: false`).
- `from` requires an explicit `agent` and resolves a registered id exactly, then case-insensitively; advisors cannot be sources. An empty value or your own id selects your conversation as the handoff source. Errors before dispatch name an unregistered source or a source with no persisted transcript.
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Plan mode: every child shares your workspace whatever `isolated` says.
- Results, follow-up, `wait` and `proc://` work as for `task`: see `tool://task/results` and `tool://task/follow-up`.
- Self forks replay an in-process request snapshot. Same-process idle/park follow-ups are supported; cold revival after restart fails before provider dispatch when that snapshot is gone. Create a fresh self fork rather than silently changing the child's contract.
