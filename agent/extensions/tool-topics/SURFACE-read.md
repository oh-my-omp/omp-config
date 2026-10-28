---
tool: read
upstream: pi-coding-agent@18.13.2 src/prompts/tools/read.md, src/tools/read.ts
---
`read` is an almost universal reading tool: files/directories, archives, structured data, documents/notebooks, images/video, web pages and remote/internal resources.
Pass one `path`. Common selectors: `file:20-60` (lines), `file:-20` (tail), `file:raw` (exact text without edit anchors). Repeat the selector on every paged call; follow returned omissions and continuation hints. Before anchored edits, read non-raw and copy the returned `[FILENAME#TAG]` snapshot header; never invent anchors.
Supported URLs: `http://`, `https://`, `file://`, `ssh://`, `skill://`, `rule://`, `agent://`, `history://`, `artifact://`, `local://`, `proc://`, `cfg://`, `issue://`, `pr://`, `mr://`, `mcp://`, `memory://`, `omp://`, `tool://`, `xd://`, `attachment://`, `conflict://`, `security://`, `vault://`; MCP may advertise additional schemes.
Use `read` for static web content; use a browser when interaction or rendered page state is required.
