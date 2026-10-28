---
tool: write
name: refusals
title: Why a write was refused
when: after a write was refused, or before overwriting a file you only read in part
upstream: pi-coding-agent@18.13.2 src/tools/write.ts, src/tools/plan-mode-guard.ts, omp://tools/write.md § Flow, § Errors
---
# Why a write was refused

- Truncated source: content that ends with a read-truncation notice and is shorter than the current file is refused, so a partial read never replaces a whole file. Read the omitted range, or change the part with `edit`.
- Generated files (protoc, sqlc, swagger … headers) are protected: change the generator input instead.
- Special files (FIFO, socket, device) and URL targets that resolve to a directory are refused.
- A URI-looking path with an unknown scheme or a misspelled `xd://` fails instead of creating a file; prefix `./` when you really want such a filename.
- A selector-shaped name (`a.ts:10-20`, `a:1;b:2`) with empty content is refused as a mistyped read.
- Plan mode: only the local plan sandbox is writable. Device-only sessions: only `xd://` devices, coordination URLs and the sandbox.
- After a successful write, the returned `[path#TAG]` has no seen-line record: read the lines before an anchored `edit`. A file starting with a `#!` shebang may be made executable; the result says so.
