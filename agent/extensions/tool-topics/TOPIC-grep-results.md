---
tool: grep
name: results
title: Result caps, paging and anchors
when: before concluding something is absent, or when a result mentions caps, `skip`, `N+`, or cut lines
upstream: pi-coding-agent@18.13.2 src/tools/grep.ts, pi-tui src/tools/grep.ts, omp://tools/grep.md § Outputs, § Limits & Caps
---
# Result caps, paging and anchors

- Pages hold at most 20 matching files; follow `Use skip=N for the next page`. `No more results` means `skip` is past the end.
- Per file: 20 matches when searching many files, 200 when searching one. For more, narrow `path` or give the file a line range.
- Discovery stops at 2000 matches; a file count shown as `N+` is a lower bound, not a total.
- Each match shows 1 line before and 3 after. Lines longer than 512 bytes are cut around the match and marked `[col N]`; read the line to see it whole.
- The whole output stops at ~50 KiB with a notice.
- Searches time out after 30 s: narrow the path or pattern, or select files with `glob` first.
- Files that could not be opened are skipped with a warning; check warnings and counts before treating a search as exhaustive.
- In hashline mode file headers carry `[path#TAG]` and match rows real line numbers: they are valid anchors for `edit` (only lines actually shown count as seen).
