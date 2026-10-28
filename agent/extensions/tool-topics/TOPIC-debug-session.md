---
tool: debug
name: session
title: Launching, stepping and inspecting
when: before launching or attaching a debugger, or when a step timed out or inspection says there is no frame
upstream: pi-coding-agent@18.13.2 src/tools/debug.ts, src/dap/{config,session}.ts, omp://tools/debug.md § Flow, § Errors, § Limits & Caps
---
# Launching, stepping and inspecting

- Adapter: `adapter` wins; otherwise `launch` picks by file extension and project markers among installed ones (`gdb`, `lldb-dap`, `codelldb`, `debugpy`, `dlv`, `js-debug-adapter`, `netcoredbg`, `kotlin-debug-adapter`, `rdbg`, `php-debug-adapter`, `bash-debug-adapter`, `dart-debug-adapter`, `flutter-debug-adapter`, `elixir-ls-debugger`). A directory `program` needs a directory-capable adapter (e.g. `dlv` on a Go package). No adapter → the error lists installed ones (`pip install debugpy` for Python).
- `attach` needs `pid` or `port` (+`host`); a port prefers `debugpy`.
- One root session at a time: `terminate` before launching another. Idle sessions are cleaned after 10 minutes.
- Breakpoints: `file` + `line`, or `function` (wins over file/line); `condition` for conditional ones. Set them before `continue`.
- `continue` / `step_*` wait for the next stop or exit. Past `timeout` (default 30 s, 5–300) they return `details.timedOut: true, state: running` — not an error: `pause` to interrupt, or wait again.
- Inspect: `threads` → `stack_trace` (`levels` limits frames) → `scopes` (`frame_id`, default current frame) → `variables` (`variable_ref` or `scope_id`). `evaluate` takes an expression or a raw debugger command (`context` defaults to `repl`).
- `output` returns the program's and adapter's output (capped at 128 KiB, oldest dropped). `sessions` lists root and child sessions.
- `No active stack frame. Run stack_trace first or supply frame_id.` → call `stack_trace` or pass `frame_id`.
