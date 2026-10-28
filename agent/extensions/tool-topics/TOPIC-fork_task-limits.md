---
tool: fork_task
name: limits
title: Prerequisites, unsupported fields and source errors
when: before using `from`, or when `fork_task` refuses to start
upstream: agent/extensions/fork-task/index.ts at e957767; pi-coding-agent@18.13.2 src/task/index.ts, src/task/settings.ts
---
# Prerequisites, unsupported fields and source errors

- Requires background jobs (`async.enabled`), the native `task` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- Not available here: `solutionSpace`, `sourceSession` and `model` are not fork fields; `effort` is ignored (`task.enableEffort: false`); `tools` fails (`eval.tools.enabled: false`); `outputSchema`/`schemaMode` are ignored (`task.structured: false`).
- `from` resolves a registered agent id exactly, then case-insensitively; advisors cannot be sources; an empty value or your own id forks your own conversation. Errors before dispatch: no registered agent with that id, or the source has no persisted transcript yet.
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Plan mode: every child shares your workspace whatever `isolated` says.
- Results, follow-up, `wait` and `proc://` work as for `task`: see `tool://task/results` and `tool://task/follow-up`.
