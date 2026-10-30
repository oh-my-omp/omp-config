---
tool: bash
name: environment
title: Environment and terminals
when: 'before relying on environment variables or a project `.envrc`, or before setting `pty: true`'
upstream: pi-coding-agent@18.13.2 src/tools/bash.ts, src/tools/bash-pty-selection.ts, src/exec/bash-executor.ts, src/exec/settings.ts
---
# Environment and terminals

- There is no `env` parameter: put `NAME=value command` in `command`.
- Every command gets `PI_SESSION_ID` and `PI_SESSION_FILE` (empty when the session is not persisted).
- An allowed `.envrc` (direnv/devenv) of the project is loaded before the command (`bash.direnv: auto`, up to 30 s on a cold load); an `.envrc` that is not allowed never runs. Values you set in the command win over direnv's.
- `pty: true` runs in a real terminal shown as an overlay the user can type into; Esc in the overlay kills it. It needs a UI: headless, the call falls back to a plain run and says `pty requested but unavailable`. PTY calls run one at a time. It exempts nothing: a passthrough, terminal or open-ended command is refused with or without it where `xd://exec_command` is mounted, which is where a REPL, TUI, password prompt or process you must drive belongs.
