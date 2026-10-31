---
tool: bash
upstream: pi-coding-agent@18.14.0 src/prompts/tools/bash.md, src/tools/bash.ts; agent/extensions/delete-guard; agent/extensions/tool-policy-nag (pty lane)
---
Runs command text synchronously in OMP's embedded POSIX shell (brush), not /bin/bash: the call waits for the command and returns its output. It is the default way to run a command. Write POSIX shell and do not switch shells inside a call (`bash -c`, `zsh -c`, `pwsh -Command`). Keep each call to one cohesive operation; chain only dependent steps with `&&`.
Use it for real programs and short pipelines: builds, tests, git, package managers, CLIs, probes, filters over a program's output. Reading, listing and searching files → `read`/`glob`/`grep`; file content you author → `write`/`edit`; inline Python/JS or computation needing language semantics → `eval`.
Passthrough commands (another machine, container, user or shell), terminal-dependent commands, and open-ended waits are refused here when the PTY alternative is active (`pty: true` does not exempt them).
xd://exec_command
Delete files with the `delete` tool when the session has it, never from bash: deletion commands (`rm`, `unlink`, `rmdir`, `shred`, `find -delete`) and commands whose name or nested script is not literal are refused before they run.
Set `cwd` instead of `cd`. Shell variables may persist between calls, but overlapping calls run in isolated one-shot shells, so make every command self-contained. Pipes, `$(…)` and redirecting a program's output (`2>&1`, `>/dev/null`) are ordinary shell. Internal URIs work as file paths for builtins/coreutils, redirects and globs.
Do not add `head`/`tail` just to shorten output: stdout and stderr arrive merged, long output keeps its head and tail, and the result links an `artifact://<id>` when the full capture is available.
`timeout` is the deadline in seconds from call start: default 300; positive values are clamped to 1–3600. Size it to the command. A call still running after 60 s may continue as background job `bg_N` whose result arrives once, as a follow-up: never poll it.
