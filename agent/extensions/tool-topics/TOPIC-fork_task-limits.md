---
tool: fork_task
name: limits
title: Prerequisites, unsupported fields and source errors
when: before using `from`, or when `fork_task` refuses to start
upstream: agent/extensions/fork-task/index.ts and replica.ts; pi-coding-agent@18.13.2 src/task/index.ts, src/task/settings.ts, src/task/discovery.ts
---
# Prerequisites, unsupported fields and source errors

- Requires background jobs (`async.enabled`), the native `task` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- Every child replicates the source's latest request (system prompt, tools, message prefix); `context`, an `agent` role and `task` arrive as its new user message. Omit `agent` to keep the source's model (shared cwd by default); name `agent` to run that agent's model binding with its prompt as a `<role>` block (isolated by default). The named agent's tool restrictions do not apply: the child has the source's tools. `shake` is opt-in, and no inherited-size/cost limit exists.
- Not available here: `solutionSpace`, `sourceSession`, `model` and `tools` are not fork fields; `effort` is ignored (`task.enableEffort: false`); `outputSchema`/`schemaMode` are ignored (`task.structured: false`).
- `from` resolves a registered id exactly, then case-insensitively; advisors cannot be sources. An empty value or your own id selects your conversation. Errors before dispatch name an unregistered source, a parked source (wake it with `write agent://<id>`, then fork), a source that has sent no request in this process, an unknown, disabled or internal `agent`, or a source with no persisted transcript.
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Plan mode: every child shares your workspace whatever `isolated` says.
- Results, follow-up, `wait` and `proc://` work as for `task`: see `tool://task/results` and `tool://task/follow-up`.
- Children replay an in-process request snapshot. Same-process idle/park follow-ups are supported; cold revival after restart fails before provider dispatch when that snapshot is gone. Create a fresh fork rather than silently changing the child's contract.
