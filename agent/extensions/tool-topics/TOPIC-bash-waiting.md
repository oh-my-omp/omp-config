---
tool: bash
name: waiting
title: Waiting for an outside condition
when: 'before waiting for something outside your control: a host coming back, CI finishing, a deploy'
upstream: agent/config.yml launch.enabled; agent/extensions/tool-policy-nag (pty lane)
---
# Waiting for an outside condition

- Do not loop with `bash` and `sleep`, and do not re-probe call after call.
- Open-ended waits are refused by the host-tool PTY policy when its alternative is active.
xd://exec_command
