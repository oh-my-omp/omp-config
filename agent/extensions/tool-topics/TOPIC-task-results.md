---
tool: task
name: results
title: Reading and handling task results
when: before relying on a delivered task result that looks truncated, failed, or was never delivered
upstream: pi-coding-agent@18.13.2 omp://tools/task.md § Outputs, § Limits & Caps, § Errors; src/prompts/tools/task-async-contract.md; src/async/job-manager.ts
---
# Reading and handling task results

- Each spawn is a background job; its result arrives once as a follow-up message. `read proc://<id>` inspects status/output without consuming delivery; `write proc://<id>/kill` (no content) cancels it, and a cancelled job's result is not delivered.
- Delivery retention is short: a consumed result expires after about 30 s, an unconsumed one after about 5 min. The agent's output and transcript stay readable at `agent://<id>` / `history://<id>`.
- Long output: about 11,500 characters come inline; beyond that you get a 5,000-character preview and the full text at `agent://<id>`. Raw output over 500,000 bytes or 5,000 lines is truncated in the result; the full raw output is in the agent's artifact.
- Failure: the child result has `exitCode=1` with `stderr` or `error`; a failed async job still delivers its output plus follow-up and transcript hints. A child that never yields gets three reminders, then is finalized as a failure/partial report ("Subagent exited without calling yield tool after 3 reminders").
- Preflight rejections (nothing spawned): duplicate names in one call, empty `task`, missing `context`, top-level `task` or `agent` beside `tasks[]`, unknown or disabled agents, depth or spawn-policy violations. Disabled here: `task`, `scout`, `sonic`, `reviewer`, `security-reviewer`.
- A batch can report some ids as failed to register (job cap reached) while the others keep running.
- An advisory in the result (two or more generic items → specialize; several live siblings → coordinate via `write agent://<id>`) is guidance, not an error.
