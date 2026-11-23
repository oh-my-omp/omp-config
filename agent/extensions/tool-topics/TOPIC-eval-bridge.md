---
tool: eval
name: bridge
title: Calling tools and reading outputs from a cell
when: before calling `tool.<name>()` or `output()` inside a cell, or relying on the cell timeout around them
upstream: pi-coding-agent@19.1.1 src/eval/js/tool-bridge.ts, src/eval/tool-bridge-policy.ts, src/eval/shell-bridge.ts, src/eval/backend.ts, src/eval/py/prelude.py, src/eval/bridge-timeout.ts, omp://tools/eval.md § Prelude helpers, § MCP structured results
---
# Calling tools and reading outputs from a cell

- `await tool.<name>(args)` returns a plain string when the tool returned only text, otherwise `{text, details, images?, hasError?}`. Check `hasError` before using the payload. MCP tools put server-structured data in `details.structuredContent` (Python: `result["details"].get("structuredContent")`); JSON-looking text is not parsed for you. Unambiguous wire aliases such as `tool.apply_patch` (when `edit` runs in apply-patch mode) are accepted under the resolved tool's approval/enablement gates; bridged `tool.todo` calls commit phase updates so they persist across resume, rewind and fork.
- `checkpoint`, `rewind`, and `yield` (including aliases) cannot be called through `tool.<name>()` or via `sh()` inside a cell: call those tools directly.
- `output(id, ...)` reads task/agent outputs: `format` `raw` (default), `stripped` (no ANSI) or `json` (metadata); `query=".key[0].field"` extracts from JSON output (not together with `offset`/`limit`). Several ids return one record per id. The Python helper reads saved `<id>.md` output files itself; the JS helper goes through `read agent://<id>`.
- Prelude `read("local://<id>.log", offset?, limit?)` opens a spilled log directly through the injected `PI_EVAL_LOCAL_ROOTS` `local` root; other internal URLs delegate to the `read` tool, and read-tool selectors such as `local://3.log:raw:5-9` go through `tool.read`.
- Timeout: cell compute, output, status helpers and bridged MCP tool calls (`mcpServerName`) count against the cell deadline; all non-MCP omp session tools (`tool.bash`, `tool.read`, `tool.task`, `tool.wait`, …), plus `agent()`, `completion()`, `judge`/`judgeBatch`, package installs and browser/computer preludes pause the watchdog and resume with a fresh window.
- `tool.task` returns once the children are spawned (spawn text, ids in `details.progress`); the children's results arrive in your conversation, never in the cell.
- Python and JS kernels are separate; subagents never share your kernel. `reset: true` recreates only the chosen language's kernel.
- Host-native prelude references live at `help://eval/helpers`, `help://eval/judge`, `help://eval/agents`, plus enabled preludes such as `help://eval/dsm` and `help://eval/ratchet`.
