---
tool: task
name: results
title: Reading and handling task results
when: before relying on a delivered task result that looks truncated, failed, or was never delivered
upstream: pi-coding-agent@19.1.1 omp://tools/task.md § Outputs, § Limits & Caps, § Errors; src/prompts/tools/task-async-contract.md; src/prompts/tools/task-spawn-feedback.md; src/task/result-summary.ts; src/async/job-manager.ts; src/async/job-control.ts
hiddenFromIndex: true
inject:
  - id: task-results-error
    tool: task
    onError: true
  - id: task-results-truncated
    tool: task
    resultPattern: '(?:truncated|agent://|failed to register)'
---
# Reading and handling task results

- Each spawn is a background job; its result arrives once as a follow-up message. `read proc://<id>` inspects status/output without consuming delivery; `write proc://<id>/kill` cancels it (`content: ""`, ignored on this target), and a cancelled job's result is not delivered.
- A settled job reported by `wait` or `write proc://<id>/kill` (not by `task` spawn acknowledgments) carries a `Delivery:` line naming how its result reached the call, so a delivered result never reads as a duplicate or a loss:
  - `Delivery: already delivered or recovered.` — an earlier call consumed it; it is not pushed again.
  - `Delivery: delivered by this wait — it finished while you were waiting.` / `Delivery: delivered by this call — it finished as the call ran.` — the job settled during this call and this call consumed its result, so no duplicate push follows; a wait already watching the job reports the same case as `Delivery: delivered directly to wait.`
  - `Delivery: handed over by this snapshot — this snapshot superseded its queued completion push.` — the queued push was replaced by this report, so the result arrived here and no duplicate follows. With a known finish time the line inserts `(it finished <age> before this call)` before the dash.
  - `Delivery: not auto-delivered; recovered by this snapshot — it had already finished <age> before this call.` — the job had settled before the call without an auto-delivery; this report is its delivery, and the age says how long it had been finished. Without a known age the dash and age clause are omitted.
- Delivery retention is short: a consumed result expires after about 30 s, an unconsumed one after about 5 min. The agent's output and transcript stay readable at `agent://<id>` / `history://<id>`.
- Long output: about 11,500 characters come inline; beyond that you get a 5,000-character preview and the full text at `agent://<id>`. Raw output over 500,000 bytes or 5,000 lines is truncated in the result; the full raw output stays readable at `agent://<id>` (written to `<id>.md`).
- Failure: the child result has `exitCode=1` with `stderr` or `error`; a failed async job still delivers its output plus follow-up and transcript hints. A child that never yields gets three reminders, then is finalized as a failure/partial report ("Subagent exited without calling yield tool after 3 reminders").
- Preflight rejections (nothing spawned): duplicate names in one call, empty `task`, missing `context`, top-level `task` or `agent` beside `tasks[]`, unknown or disabled agents, depth or spawn-policy violations. Disabled here: `task`, `scout`, `sonic`, `security-reviewer`.
- A batch can report some ids as failed to register (job cap reached) while the others keep running.
- An advisory in the result (two or more generic items → specialize; several live siblings → coordinate via `write agent://<id>`) is guidance, not an error.
