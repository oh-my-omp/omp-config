---
tool: bash
name: urls
title: Internal URLs in commands
when: before using `scheme://` paths (`local://`, `skill://`, `proc://`, `out://` …) in a command or as `cwd`
upstream: pi-coding-agent@19.1.1 src/internal-urls/url-filesystem.ts, src/internal-urls/out-protocol.ts, src/tools/bash.ts, omp://tools/bash.md § Inputs, § Side Effects, § Errors
---
# Internal URLs in commands

- `scheme://…` paths work for shell builtins/coreutils, redirects and globs through the embedded shell's filesystem, e.g. `ls local://`, `cp local://12.log local://out.txt`, `wc -l skill://km/SKILL.md`.
- A bare `skill://<name>` is the skill's directory; its instructions are `skill://<name>/SKILL.md`.
- Rendered resources (`history://`, `omp://`, `issue://`, `pr://` …) are read-only. File-backed `local://` is writable within your approval tier.
- Handler-written URLs (`: > proc://<id>/kill`, `echo hi > agent://<id>`, `cfg://`, `ssh://`) accept shell redirects (`>`) via write-only sinks: on close, UTF-8 bytes reach the scheme handler as one write and any answer or refusal is appended as a notice (a refusal fails close and exits non-zero). Appends (`>>`) are refused except on contentless channels (`proc://`, `out://`, `agent://`).
- Foreground runs can stream replies to the user via `> out://` up to 64 KiB (larger replies fail with `EFBIG` and are dropped; backgrounded jobs cannot write `out://`).
- `cwd` may be an internal URL directory (native `pty: true` without `omp-actual-terminal` needs a host directory).
- Failures come back as errno-style command errors: `ENOENT` missing entry, `EROFS` immutable scheme, non-write mutation (`rm`/`mkdir`) on a handler-owned scheme, or unavailable `out://`, `EINVAL` append to a replace-only handler URL or non-UTF-8 payload, `EFBIG` oversize `out://` reply, `EACCES` approval, containment or read on a write-only sink, `EXDEV` rename/link across schemes.
