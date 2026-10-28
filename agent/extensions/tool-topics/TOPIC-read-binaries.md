---
tool: read
name: binaries
title: Executables and profiler reports
when: before inspecting a compiled executable, an IDA database, a macOS `sample` report or a `.cpuprofile`
upstream: pi-coding-agent@18.13.2 src/tools/read-binary.ts, src/prompts/tools/read.md, omp://tools/read.md § Executables and IDA databases, § Profiler reports
---
# Executables and profiler reports

- With IDA installed, an ELF/PE/Mach-O binary (also extensionless) or IDA database reads as an overview plus function list. Views: `bin:<function|0xaddr>` pseudocode, `bin:<function>:asm`, `bin:imports`, `bin:exports`, `bin:strings`, `bin:xrefs:<function|0xaddr>`; line selectors may follow (`bin:main:10-40`). `bin:@x86_64:main` picks a slice of a universal Mach-O. First use builds an IDA database; each view has 120 s. `:raw` skips the views. Without IDA a binary returns a notice; `:raw` forces the bytes as text.
- A whole macOS `*.sample.txt` report or V8 `.cpuprofile` (≤ 32 MiB) returns a hot-path summary (self time, samples). Explicit line selectors read the original report instead.
