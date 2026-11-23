---
tool: task
name: limits
title: Fan-out, depth and run budgets
when: before planning a large fan-out, nested delegation, or a long-running child
upstream: pi-coding-agent@19.1.1 src/task/settings.ts, src/task/executor.ts, src/async/job-manager.ts, src/tools/settings.ts, omp://tools/task.md § Modes / Variants, § Limits & Caps; agent/config.yml
---
# Fan-out, depth and run budgets

- Concurrency: all spawns of the session share one semaphore of `task.maxConcurrency` (64 here); extra items queue. Background jobs are capped at 100 running at once (`async.maxJobs`); a spawn beyond that fails to register until jobs finish or are cancelled.
- Worker threads (`task.workerThreads`, default 4; `0` keeps subagents on the main thread): fewer than 9 concurrent runs stay on the main thread, then workers scale at 9/18/36/72 concurrent runs and exit after 60 s idle.
- Depth: spawning stops at depth 2 (`task.maxRecursionDepth`); a child at the maximum depth has no `task` tool. In this setup only `task:high` workers spawn `task:*` children.
- Request budget: a child gets a wrap-up notice after 200 assistant requests (`task.softRequestBudget`) and is force-stopped at 1.5× that, returning partial findings. Size slices so they finish well inside it.
- No wall-clock limit per child here (`task.maxRuntimeMs: 0`).
- Per-agent model helpers: `prewalk` (agent frontmatter `prewalk`, `task.agentPrewalk`, `task.agentPrewalkAuto`, or `task.prewalk` for bundled `task`) starts on the normal model and hands off to a cheaper model at the first edit/write; `advisor` (agent frontmatter `advisor` or `task.agentAdvisor`) pairs a child with an advisor model (subagents default to no advisor).
- Children inherit the workspace, skills, rules and allowed context files plus the shared `local://` root, never your conversation. A child's tools come from its agent definition.
