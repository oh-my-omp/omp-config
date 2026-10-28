---
tool: wait
name: report
title: Reading a background-job report
when: before acting on a job snapshot from `wait`, or when a job id and an agent id seem to differ
upstream: pi-coding-agent@18.13.2 src/tools/wait.ts, src/async/job-control.ts, src/session/async-job-delivery.ts
---
# Reading a background-job report

- `wait` watches every running job you own and returns when the first one settles, a message arrives, you are interrupted, or the 30-minute cap passes. It does not return only when all jobs are done, and the cap does not cancel anything.
- Queued messages and finished-but-undelivered results of your jobs come back immediately. A result delivered by `wait` is consumed: no duplicate follow-up arrives later. If a message wins the race, the job result still arrives normally afterwards.
- The report has `## Completed (N)` (completed, failed and cancelled) and `## Still Running (N)`. Each entry names id, type (`bash`, `task`, `eval`), status and label, with its output or `Error: …` once.
- Running task rows may add runtime, request count, cost, context fill, `~<n>%` self-estimate and `stage: …`.
- A task's agent id can differ from its job id. Address `agent://<agent-id>` / `history://<agent-id>` by the agent id the report names. When the report says the agent output is not yet published, `agent://<agent-id>` still shows an earlier turn.
- Structured results report their validation status; read the payload from `agent://<agent-id>` or one field from `agent://<agent-id>/<field>`. `unavailable` means nothing was validated.
- "Wait interrupted by message." means a steering message arrived: handle it before waiting again.
- To inspect without consuming delivery use `read proc://<id>`; to cancel, `write proc://<id>/kill`. `wait` itself never cancels work.
