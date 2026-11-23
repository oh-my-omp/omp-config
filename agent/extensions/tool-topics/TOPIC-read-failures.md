---
tool: read
name: failures
title: Missing paths, binaries and partial results
when: when a read failed, found nothing, returned a notice instead of content, or seems to show the wrong file
upstream: pi-coding-agent@19.1.1 src/tools/read.ts, src/tools/output-meta.ts, omp://tools/read.md § Flow, § Errors, § Outputs
hiddenFromIndex: true
inject:
  - id: read-failures-error
    tool: read
    onError: true
  - id: read-failures-notice
    tool: read
    resultPattern: '(?:\[Cannot read binary (?:file|archive entry)|… \d+ more|truncated|local://\d+\.log)'
---
# Missing paths, binaries and partial results

- Missing-path recovery: unique workspace suffix match (the output starts with the actual path read — check it), approved-plan alias recovery (a cwd-root filename matching the active `local://` plan basename), macOS screenshot/NFD/curly-quote variants, and guarded `;`-delimited path list recovery (read part by part, though callers should issue one `read` per path). Ambiguous or unmatched paths fail.
- `file:10:5` (line:column) fails with `Invalid line selector ':10:5'` and suggests `:10` (or `:10-20` when ascending).
- Relative paths resolve against the session cwd; `~` expands; bare `/` means the session cwd.
- Directories: a tree two levels deep, newest first with sizes and ages; each child shows at most 12 entries — `… N more` means read that child. `:N-M` slices the listing.
- Binary files return `[Cannot read binary file …]`; `:raw` forces the bytes as text. HEIC/AVIF/BMP/TIFF are decoded/transcoded as images instead of returning a binary error. Devices, FIFOs and sockets are refused.
- Some refusals are successful results with explanatory text (binary members, failed document conversion, HTTP errors, an unbounded raw read that is too large). Check the body before treating the read as content.
- Reading the same unchanged range 3 times triggers a repeat-read hint to narrow or move on.
- Truncated output names its continuation (`:N`) or spills full output to `local://<id>.log` (including `[raw output: local://<id>.log]`); follow it instead of rereading from the start.
