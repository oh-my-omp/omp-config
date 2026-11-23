---
tool: read
name: binaries
title: Executables, disassembler databases and profiler reports
when: before inspecting a compiled executable, a disassembler database (`.i64`/`.idb`/`.bndb`), a macOS `sample` report or a `.cpuprofile`
upstream: pi-coding-agent@19.1.1 src/tools/read-binary.ts, src/prompts/tools/read-sources.md, omp://tools/read.md § Executables and disassembler databases, § Profiler reports
---
# Executables, disassembler databases and profiler reports

- Bare reads of ELF/PE/Mach-O executables (including extensionless files) and disassembler databases (IDA `.i64`/`.idb`, Binary Ninja `.bndb`) return **on-disk metadata only**: they never open or build an analysis database or download a backend. Line selectors page the metadata; `:raw` bypasses this path and reads raw bytes as text. `.bndb` is a SQLite file on disk yet always takes this binary/disassembler route, not the SQLite route.
- Analysis views are explicit opt-in: `bin:overview` (function list), `bin:<func|0xaddr>` (pseudocode), `bin:<func>:asm`, `bin:imports`, `bin:exports`, `bin:strings`, `bin:xrefs:<func|0xaddr>`; line selectors may follow (`bin:main:10-40`). Reserved view names win over same-named functions (use `0xaddr` instead).
- Universal Mach-O defaults to the host-architecture slice; `bin:@<arch>` selects another slice's metadata and `bin:@x86_64:main` analyzes it.
- Backends (`disassembler.backend`): `ida`, `ghidra`, or `binja`. Opening an analysis view uses the selected backend and may auto-provision Ghidra on first analysis; `.i64`/`.idb` analysis requires `ida` and `.bndb` analysis requires `binja`. Views fail when no backend resolves. For edits and Python scripting over a binary, read `help://eval/dsm`.
- A whole macOS `*.sample.txt` report or V8 `.cpuprofile` (≤ 32 MiB) returns a hot-path summary (self time, samples). Explicit line selectors or `:raw` read the original report instead.
