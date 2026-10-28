---
tool: bash
name: policy
title: Blocked commands and approval
when: after a command returned `Blocked:` or was refused, or before running a destructive command
upstream: pi-coding-agent@18.13.2 src/tools/bash.ts, src/tools/bash-interceptor.ts, src/exec/settings.ts; agent/config.yml bashInterceptor
---
# Blocked commands and approval

- `Blocked: <message>` means the command matched a routing rule and never ran. Redo the work with the tool the message names. Routes in this setup:
  - `cat`/`head`/`tail`/`less`/`more` on files (not `tail -f`) → `read`
  - `grep`/`rg`/`ag`/`ack` → `grep`
  - in-place `sed -i`/`perl -i`/`awk -i inplace` → `edit`
  - in-place `sed -i`/`perl -i`/`awk -i` → `edit`
  - `echo`/`printf`/`cat <<` redirected into a file → `write`
- Routing checks each `&&`/`||`/`;`/`|` segment; a stage reading piped stdin (`… | grep x`) is not routed.
- Approval is separate from routing: high-risk commands (recursive deletes of root paths, `sudo rm`, disk/filesystem destruction, fetch-to-shell such as `curl … | sh`, shutdown/PID 1 control, fork bombs) always require human approval and may be refused. Ask before running destructive commands at all.
