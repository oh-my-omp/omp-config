---
tool: write
name: conflict
title: Resolving merge conflicts
when: when a file has `<<<<<<<` conflict markers to resolve by picking a side or merging
upstream: pi-coding-agent@18.13.2 src/internal-urls/conflict-protocol.ts, omp://tools/write.md § Merge-conflict resolution
---
# Resolving merge conflicts

1. Register the conflicts: `read <file>:conflicts` (or read a window that shows the markers). Each marker block gets a session-stable id `N`.
2. Resolve one block: `write conflict://N` with the replacement text. Only that block is replaced, after it is revalidated against the file.
3. Side tokens: a content line exactly `@ours`, `@theirs`, `@base` or `@both` expands to that recorded side (`@both` = ours then theirs; `@base` needs a diff3 base). Every other line is literal text.
4. All at once: `write conflict://*` with ordinary content applies the same replacement to every registered block; directive content such as `1: @ours` / `2: @theirs` (one side token per line, no repeated ids) resolves only the listed ids.
- Bulk resolution is all-or-nothing per file and runs bottom-up; another file can still fail, and its ids stay retryable while resolved ids are invalidated.
- Stale ids, moved markers, malformed directives or a missing `@base` are errors: re-read `:conflicts` and retry. `conflict://N/ours` etc. are read-only views of one side.
