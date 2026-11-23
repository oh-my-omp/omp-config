---
tool: debug
name: low-level
title: Memory, disassembly, data breakpoints and adapters
when: before data or instruction breakpoints, disassembly, memory reads/writes, modules, custom DAP requests, or configuring an adapter
upstream: pi-coding-agent@19.1.1 src/tools/debug.ts, src/dap/{types,config}.ts, src/utils/config-file-sources.ts, omp://tools/debug.md § Action-specific requirements, § Modes / Variants
---
# Memory, disassembly, data breakpoints and adapters

- These need the adapter to advertise the capability; otherwise `Current adapter does not support …`.
- Data breakpoints: `data_breakpoint_info` with `name` (and `frame_id`/`scope_id`) returns a `data_id`; then `set_data_breakpoint` with `data_id`, `access_type` (`read`/`write`/`readWrite`), optional `condition`/`hit_condition`; `remove_data_breakpoint` by `data_id`.
- Instruction breakpoints: `set_instruction_breakpoint` / `remove_instruction_breakpoint` with `instruction_reference` (+`offset`).
- `disassemble`: `instruction_count` required; `memory_reference` or the current stop location; `instruction_offset`, `resolve_symbols`.
- `read_memory`: `memory_reference` + `count` → base64 data and unreadable byte count. `write_memory`: `memory_reference` + base64 `data` (`allow_partial`).
- `modules` (`start_module`, `module_count`), `loaded_sources`.
- `custom_request`: any DAP request `command` with `arguments`.
- Custom or overriding adapters: `dap.json` / `.dap.json` / `dap.yaml` / `.dap.yaml` / `dap.yml` / `.dap.yml` searched in cwd, project config dirs (`.omp/`, `.claude/`, `.codex/`, `.gemini/`), user config dirs (`~/.omp/agent/`, Claude's config dir via `CLAUDE_CONFIG_DIR` or `~/.claude/`, `~/.codex/`, `~/.gemini/`), plugin roots, then `~` (merged lowest to highest priority). Each adapter: `command`, optional `args`, `languages`, `fileTypes`, `rootMarkers`, `launchDefaults`, `attachDefaults` (including `skipAttachRequest: true` to skip DAP `attach`), `connectMode` (`stdio` default, `socket`, `tcp` with `${port}` in args), `acceptsDirectoryProgram`.
