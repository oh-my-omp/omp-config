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
- With `omp-actual-terminal` active, `bash` with `pty: true` starts a model-driven PTY terminal registered as a `bash` job (`bg_N`), and non-PTY `bash` refuses passthrough, terminal-dependent or open-ended commands.
- For PTY sessions and interactive/open-ended commands, read `help://bash/terminal`.
