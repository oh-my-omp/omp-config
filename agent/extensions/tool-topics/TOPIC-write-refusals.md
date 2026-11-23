---
tool: write
name: refusals
title: Why a write was refused
when: after a write was refused, or before overwriting a file you only read in part
upstream: pi-coding-agent@19.1.1 src/tools/write.ts, src/tools/plan-mode-guard.ts, omp://tools/write.md § Flow, § Errors
hiddenFromIndex: true
inject:
  - id: write-refusals-error
    tool: write
    onError: true
---
# Why a write was refused

- Truncated source: content ending with a read-truncation notice is refused when shorter than the current file; content ending with a column-cap truncation notice (`…` cut lines) is refused at any length. Re-read omitted or cut ranges (use `:raw` for long lines), or change the part with `edit`.
- Generated files (protoc, sqlc, swagger … headers) are protected: change the generator input instead.
- Held-open files (e.g. live SQLite databases / `-shm`), special files (FIFO, socket, device) and URL targets that resolve to a directory are refused.
- A URI-looking path with an unknown or misspelled scheme fails instead of creating a file; prefix `./` when you really want such a filename.
- A missing `;`-joined list of read selectors (`a:1-10;b:2-20`) is refused regardless of content; a missing single selector-shaped name (`a.ts:10-20`) with empty content is refused as a mistyped read.
- Plan mode: allows targets whose `spec.write.scope` is `coordination`, `reply` or `sandbox` (e.g. `agent://`, `out://`, `local://`) or whose `cancels()` predicate matches (e.g. `proc://<id>/kill`); other writes are refused.
- Plain text writes strip copied hashline prefixes (`[path#TAG]` + sequential `LINE:`) automatically (verbatim handler payloads are untouched) and preserve the replaced file's CRLF line endings and UTF-8 BOM. After a successful write, the returned `[path#TAG]` has no seen-line record: read the lines before an anchored `edit`. A file starting with `#!` (not `#![`) may be made executable; the result says so.
