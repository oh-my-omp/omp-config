---
tool: exec_command
name: waiting
title: Waiting for an outside condition
when: 'before waiting for something outside your control: a host coming back, CI finishing, a deploy'
upstream: omp-unified-exec@0.14.19 (7e87dd6) src/index.ts exec_command/monitor descriptions; agent/config.yml launch.enabled
---
# Waiting for an outside condition

- Do not loop with `bash` and `sleep`, and do not re-probe call after call.
- Start one quiet loop with `exec_command` that prints only when it ends, for example 24 h with a 5-minute probe:
  `(for i in $(seq 288); do probe >/dev/null 2>&1 && exit 0; sleep 300; done; exit 1) && echo READY || echo GAVE_UP`
- `exec_command` has no command deadline, so the loop may outlive the call's `yield_time_ms`; the call returns `session_id` while the loop keeps running.
- Failed checks print nothing. Never add a per-check marker: every printed line is output the monitor can wake you on.
- Attach `monitor` to that `session_id` without `condition`, so the loop's end wakes you once and nothing else does.
- To look at progress without disturbing the wait, read `terminal_url` (`term://…`); `monitor` observes without consuming output.
- When the wait ends, or the expected state never arrives, stop the loop with `kill_session` instead of leaving it running.
