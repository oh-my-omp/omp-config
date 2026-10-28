---
tool: bash
name: urls
title: Internal URLs in commands
when: before using `scheme://` paths (`local://`, `skill://`, `artifact://` …) in a command or as `cwd`
upstream: pi-coding-agent@18.13.2 src/internal-urls/url-filesystem.ts, src/tools/bash.ts, omp://tools/bash.md § Inputs, § Side Effects, § Errors
---
# Internal URLs in commands

- `scheme://…` paths work for shell builtins/coreutils, redirects and globs through the embedded shell's filesystem, e.g. `ls local://`, `cp artifact://12 local://out.txt`, `wc -l skill://km/SKILL.md`.
- A bare `skill://<name>` is the skill's directory; its instructions are `skill://<name>/SKILL.md`.
- Rendered resources (`agent://`, `history://`, `omp://`, `issue://` …) are read-only. File-backed `local://` is writable within your approval tier. Resources whose writes have their own meaning (`agent://` messages, `proc://` stdin, `cfg://`) are written with the `write` tool, not the shell.
- `cwd` may be an internal URL only for plain commands: not with `pty: true`, which needs a host directory.
- Failures come back as errno-style command errors: `ENOENT` missing entry, `EROFS` read-only or handler-owned target, `EACCES` approval or containment, `EXDEV` rename/link across schemes.
