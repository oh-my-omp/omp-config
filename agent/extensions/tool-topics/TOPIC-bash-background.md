---
tool: bash
name: background
title: Background jobs and deadlines
when: before running a command that may take over a minute, or after one moved to a background job
upstream: pi-coding-agent@18.13.2 src/tools/bash.ts, src/exec/settings.ts, omp://tools/bash.md § Inputs, § Outputs, § Limits & Caps
---
# Background jobs and deadlines

- A non-PTY call still running after 60 s (`bash.autoBackground`) returns a preview and a job id `bg_N`; the command keeps running until its `timeout`. When a deadline exists, the foreground wait ends 1 s before it at the latest. At the job cap the call stays in the foreground instead.
- `async: true` returns the job id at once. It does not remove the deadline: the job keeps the effective `timeout`; `timeout: 0` is the only no-deadline form.
- The job's result arrives once, as a follow-up message to the session that started it. Do not wait for it with more calls (`sleep`, `ps`, `tail`, repeated `read proc://bg_N`): continue other work; with nothing left, end the turn (main session) or call `wait` (subagent).
- `read proc://bg_N` shows status/output for one-off diagnosis without consuming delivery; `write proc://bg_N/kill` (no content) cancels.
- A non-zero exit or a reached timeout marks the job `failed`; progress updates carry `details.async.state` `running` / `completed` / `failed`.
- A requested timeout outside 1–3600 is clamped and the result says so (`details.requestedTimeoutSeconds` vs `timeoutSeconds`).
- Service mode (`name`/`ready`) is disabled in this setup (`launch.enabled: false`); long-lived processes belong in `xd://exec_command`.
