---
tool: bash
name: waiting
title: Waiting for an outside condition
when: 'before waiting for something outside your control: a host coming back, CI finishing, a deploy'
upstream: omp-unified-exec exec_command/monitor devices; agent/config.yml launch.enabled
---
# Waiting for an outside condition

- Do not loop with `bash` and `sleep`, and do not re-run a probe call after call.
- Start one quiet loop with `xd://exec_command` that prints only when it ends, for example 24 h:
  `(for i in $(seq 288); do probe >/dev/null 2>&1 && exit 0; sleep 300; done; exit 1) && echo READY || echo GAVE_UP`
- Then attach `xd://monitor` to that session without `condition`; it wakes you once when the loop ends.
- Failed checks print nothing; do not add a per-check marker, or every check wakes you.
- Read `xd://exec_command` and `xd://monitor` for their arguments before the first use.
