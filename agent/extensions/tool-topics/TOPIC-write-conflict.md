---
tool: write
name: conflict
title: Resolving merge conflicts
when: when a file has `<<<<<<<` conflict markers to resolve by picking a side or merging
upstream: pi-coding-agent@19.1.1 src/internal-urls/conflict-protocol.ts, src/tools/conflict-uri.ts, omp://tools/write.md § Merge-conflict resolution
---
# Resolving merge conflicts

1. Register the conflicts: `read <file>:conflicts` (or read a window that shows the markers). Each marker block gets a session-stable id `N`.
2. Resolve one block: `write conflict://N` with the replacement text. Before writing, registered ids are re-checked against live marker blocks: unchanged blocks keep their ids across line shifts, changed/vanished blocks are retired, and different blocks get fresh ids. Copied adjacent context that would duplicate lines outside the block is trimmed automatically with a receipt note.
3. Side tokens: a content line exactly `@ours`, `@theirs`, `@base` or `@both` expands to that recorded side (`@both` = ours then theirs; `@base` needs a diff3 base). Every other line is literal text.
4. All at once: `write conflict://*` with ordinary content applies the same replacement to every registered block; per-id directive content such as `1: @ours` / `2: @theirs` (one side token per line, no `;` needed, no repeated ids — even behind copied `LINE:` hashline prefixes) resolves only the listed ids.
- Bulk resolution is all-or-nothing per file and runs bottom-up; another file can still fail, and its ids stay retryable while resolved ids are invalidated.
- Stale ids, changed/vanished markers, malformed directives or a missing `@base` are errors: re-read `:conflicts` and retry. `conflict://N/ours` etc. are read-only views of one side.
