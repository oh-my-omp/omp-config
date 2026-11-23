---
tool: eval
name: magics
title: Python magics and shell escapes
when: before using a `%` magic other than `%load`/`%pip`, `%%` cell magics, or `!cmd` in Python
upstream: pi-coding-agent@19.1.1 src/eval/py/runner.py, src/eval/input.ts, src/eval/executor-base.ts, src/eval/js/context-manager.ts, omp://tools/eval.md § Side effects and cancellation
---
# Python magics and shell escapes

- `!cmd` runs a shell command (stdin closed) and returns a list of output lines with `.returncode`, `.n` (joined by newlines) and `.s` (joined by spaces): `files = !git diff --name-only`.
- `%run path [args]` executes a script as `__main__` with `sys.argv` set and keeps its globals; `%load path` (standalone cell) defines it without the `__main__` guard.
- `%cd [path]` (home when omitted), `%pwd`, `%ls`; `%env` (all / `KEY` / `KEY=VALUE`), `%set_env KEY VALUE`.
- `%time expr`, `%timeit expr`; `%who`, `%whos` list the namespace; `%reset` clears it without restarting the kernel (`reset: true` recreates the kernel).
- Cell magics must start the cell: `%%capture [name]` captures stdout/stderr, `%%timeit`, `%%bash` runs the body in bash, `%%writefile path`.
- Setup commands (`%load`, `%pip`, `%bun add`, `%environment managed|project`) must be standalone cells; `%pip` is Python only, `%bun add` JavaScript only.
- Unknown magics fail with `UsageError: … magic function … not found`.
- Runtime lifecycle: JavaScript runs in an isolated subprocess with a Bun Worker fallback (never on the host thread if both fail to start). If a retained Python kernel or JS worker dies between cells (crash, kill, OOM, or destructive cancel/timeout), the next cell starts a fresh runtime and opens with `Kernel restarted: the previous … is dead; state is unavailable.` (`reset: true` does not emit that notice).
- The tool-routing rules still apply: files you author go through `write`/`edit`, reading files through `read`, not through magics or `!cat`.
