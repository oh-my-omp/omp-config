---
tool: read
upstream: pi-coding-agent@19.1.1 src/prompts/tools/read.md, src/prompts/tools/read-sources.md, src/tools/read.ts, src/internal-urls/router.ts, src/internal-urls/out-protocol.ts
---
`read` is an almost universal reading tool: files/directories, archives, structured data, documents/notebooks, images/video, web pages and remote/internal resources.
Pass one `path`. Common selectors: `file:20-60` (lines), `file:-20` (tail), `file:raw` (exact text without edit anchors). Repeat the selector on every paged call; follow returned omissions and continuation hints. Before anchored edits, read non-raw and copy the returned `[FILENAME#TAG]` snapshot header; never invent anchors.
Supports `http://`, `https://`, `file://`, and all protocols listed in `# Internal URLs`: built-in schemes (`skill://`, `rule://`, `memory://`, `agent://`, `history://`, `local://`, `proc://`, `cfg://`, `ssh://`, `security://`, `vault://`, `issue://`, `pr://`, `mr://`, `mcp://`, `omp://`, `help://`, `attachment://`, `conflict://`; `out://` is built-in write-only), active extension/plugin schemes (such as `term://`, `session://`, `peer://`, `playbook://`, `dispatch://`), and MCP-advertised schemes.
Built-in references: read `help://read/sources` for concise selectors across SQLite, archives, JSON queries, executables, video, SVG `:img`, merge conflicts, and `write` archive/SQLite targets; read `help://read/urls` for internal-URL sub-paths, queries and limits.
`out://` is not readable: it is the mid-turn reply channel — write Markdown to it (`write out://`, or `cmd > out://` in bash) to show the user a reply without ending the turn, up to 64 KiB, in the interactive TUI only (print, RPC and ACP sessions, and subagents, refuse it).
Use `read` for static web content; use a browser when interaction or rendered page state is required.
