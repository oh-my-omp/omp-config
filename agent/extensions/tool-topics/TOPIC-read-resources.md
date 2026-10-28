---
tool: read
name: resources
title: Other internal resources
when: before reading `skill://`, `rule://`, `local://`, `cfg://`, `omp://`, `tool://`, `xd://`, `attachment://`, `conflict://`, `mcp://` or `memory://`
upstream: pi-coding-agent@18.13.2 src/internal-urls/*-protocol.ts, omp://tools/read.md § Internal URLs; agent/extensions/_shared/tool-topics.ts
---
# Other internal resources

- `skill://<name>` — the skill's instructions; `skill://<name>/<path>` a file beside it. Unknown names list the available skills.
- `rule://<name>` — a rule body without frontmatter.
- `local://` — the session's shared scratch root (also visible to subagents); `local://<name>.md` a file, `local://dir/` a directory.
- `cfg://` — OMP settings tree, `cfg://<ns>/<key>` value/type/default/source. Only when the user asks about settings.
- `omp://` — bundled harness docs; only when asked about the harness.
- `tool://` — tools with topics; `tool://<tool>` its topic list; `tool://<tool>/<topic>` one topic.
- `xd://` — mounted devices; `xd://<device>` its docs and schema; `xd://<device>/<topic>` one doc topic. Reading never runs a device (that is `write xd://<device>`).
- `attachment://<N>` — an image attached to this session; supports `?q=<question>`.
- `<file>:conflicts` lists a file's merge-conflict blocks as `#N Lx-Ly`; `conflict://N` reads one block, `conflict://N/ours|theirs|base|both` one side (resolve with `write conflict://N`).
- `mcp://<resource-uri>` — an MCP server resource; unknown URIs list what servers advertise.
- `memory://root` — project memory summary (when a memory backend is on); `security://` and `vault://` are disabled in this setup.
