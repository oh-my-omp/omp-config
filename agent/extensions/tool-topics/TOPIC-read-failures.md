---
tool: read
name: failures
title: Missing paths, binaries and partial results
when: when a read failed, found nothing, returned a notice instead of content, or seems to show the wrong file
upstream: pi-coding-agent@18.13.2 src/tools/read.ts, omp://tools/read.md § Flow, § Errors, § Outputs
---
# Missing paths, binaries and partial results

- A missing path is retried as a unique suffix match in the workspace; when that succeeds the output starts with the path it actually read (check it). Ambiguous or no match is an error. macOS screenshot names and Unicode/apostrophe variants are also recovered.
- Relative paths resolve against the session cwd; `~` expands; bare `/` means the session cwd.
- Directories: a tree two levels deep, newest first with sizes and ages; each child shows at most 12 entries — `… N more` means read that child. `:N-M` slices the listing.
- Binary files return a notice; `:raw` forces the bytes as text. Devices, FIFOs and sockets are refused.
- Some refusals are successful results with explanatory text (binary members, failed document conversion, HTTP errors, an unbounded raw read that is too large). Check the body before treating the read as content.
- Truncated output names its continuation (`:N`) or an `artifact://` with the rest; follow it instead of rereading from the start.
