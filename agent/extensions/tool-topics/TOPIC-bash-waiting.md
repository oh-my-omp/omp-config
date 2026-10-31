---
tool: bash
name: waiting
title: Waiting for an outside condition
when: 'before waiting for something outside your control: a host coming back, CI finishing, a deploy'
upstream: agent/config.yml launch.enabled; omp-unified-exec xd://exec_command/waiting
---
# Waiting for an outside condition

- Do not loop with `bash` and `sleep`, and do not re-probe call after call.
- Start one quiet loop with `exec_command` that prints only when it ends, for example 24 h with a 5-minute probe:
  `(for i in $(seq 288); do probe >/dev/null 2>&1 && exit 0; sleep 300; done; exit 1) && echo READY || echo GAVE_UP`
- Failed checks print nothing. Never add a per-check marker: every printed line is output a `monitor` can wake you on.
- Attach `monitor` to the returned `session_id` without `condition`, so the loop's end wakes you once and nothing else does.
- When the wait ends, or the expected state never arrives, stop the loop with `kill_session` instead of leaving it running.
- How `exec_command`, `monitor` and `kill_session` behave while you wait: `xd://exec_command/waiting`.
