---
tool: task
name: limits
title: Fan-out, depth and run budgets
when: before planning a large fan-out, nested delegation, or a long-running child
upstream: pi-coding-agent@18.13.2 src/task/settings.ts, src/async/job-manager.ts, omp://tools/task.md § Limits & Caps; agent/config.yml
---
# Fan-out, depth and run budgets

- Concurrency: all spawns of the session share one semaphore of `task.maxConcurrency` (64 here); extra items queue. Background jobs are capped at 100 running at once; a spawn beyond that fails to register until jobs finish or are cancelled.
- Depth: spawning stops at depth 2 (`task.maxRecursionDepth`); a child at the maximum depth has no `task` tool. In this setup only `task:high` workers spawn `task:*` children.
- Request budget: a child gets a wrap-up notice after 200 assistant requests (`task.softRequestBudget`) and is force-stopped at 1.5× that, returning partial findings. Size slices so they finish well inside it.
- No wall-clock limit per child here (`task.maxRuntimeMs: 0`).
- Children inherit the workspace, skills, rules and allowed context files plus the shared `local://` root, never your conversation. A child's tools come from its agent definition.
