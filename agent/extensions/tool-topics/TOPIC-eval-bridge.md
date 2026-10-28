---
tool: eval
name: bridge
title: Calling tools and reading outputs from a cell
when: before calling `tool.<name>()` or `output()` inside a cell, or relying on the cell timeout around them
upstream: pi-coding-agent@18.13.2 src/eval/js/tool-bridge.ts, src/eval/py/prelude.py, src/eval/bridge-timeout.ts, omp://tools/eval.md § Prelude helpers, § MCP structured results
---
# Calling tools and reading outputs from a cell

- `await tool.<name>(args)` returns a plain string when the tool returned only text, otherwise `{text, details, images?, hasError?}`. Check `hasError` before using the payload. MCP tools put server-structured data in `details.structuredContent` (Python: `result["details"].get("structuredContent")`); JSON-looking text is not parsed for you.
- `checkpoint`/`rewind` cannot be called through the bridge.
- `output(id, ...)` reads task/agent outputs: `format` `raw` (default), `stripped` (no ANSI) or `json` (metadata); `query=".key[0].field"` extracts from JSON output (not together with `offset`/`limit`). Several ids return one record per id. The Python helper reads artifact files itself; the JS helper goes through `read agent://<id>`.
- Prelude `read("artifact://<id>")` opens a spilled artifact; selectors such as `artifact://3:raw:5-9` go through the `read` tool.
- Timeout: compute, output and ordinary tool calls count against the cell deadline; waits on `agent()`, `completion()`, `judge`, package installs and bridged `tool.task`/`tool.wait` pause it and resume with a fresh window.
- Python and JS kernels are separate; subagents never share your kernel. `reset: true` recreates only the chosen language's kernel.
