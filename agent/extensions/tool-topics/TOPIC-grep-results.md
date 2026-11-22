---
tool: grep
name: results
title: Result caps, paging and anchors
when: before concluding something is absent, or when a result mentions caps, `skip`, `N+`, or cut lines
upstream: pi-coding-agent@18.22.0 src/tools/grep.ts, pi-utils src/sanitize-text.ts, crates/pi-walker/src/grep/scan.rs, pi-tui src/tools/grouped-file-output.ts, omp://tools/grep.md § Outputs, § Modes / Variants, § Limits & Caps
hiddenFromIndex: true
inject:
  - id: grep-results-error
    tool: grep
    onError: true
  - id: grep-results-capped
    tool: grep
    resultPattern: '(?:Use skip=|\[col \d+\]|Binary files also match|No matches in text files|truncated|\d+\+ files)'
---
# Result caps, paging and anchors

- Pages hold at most 20 matching files; follow `Use skip=N for the next page`. `No more results` means `skip` is past the end.
- Per file: 10 matches when searching many files, 50 when searching one. For more, narrow `path` or give the file a line range.
- Discovery stops at 2000 matches; a file count shown as `N+` is a lower bound, not a total.
- Results show matching lines only; `grep.contextBefore` and `grep.contextAfter` add surrounding context (both default to none). Lines longer than 512 bytes are cut around the match and marked `[col N]`; read the line to see it whole.
- The whole output stops at ~50 KiB with a notice.
- Searches time out after 30 s: narrow the path or pattern, or select files with `glob` first.
- Files that could not be opened are skipped with a warning; check warnings and counts before treating a search as exhaustive.
- A file named directly as `path` is searched as text even when it is binary, NUL bytes and all; its matches print like any other file's.
- A directory or glob search skips files that look binary (a NUL byte in the first 64 KiB) and appends the ones whose content matches: ``Binary files also match (name one as `path` to search it as text): …`` lists up to five of them. When they are the only hits, the result says `No matches in text files`, not `No matches found`. Name one as `path` to search it as text.
- Match and context lines arrive with NUL bytes, ANSI escape sequences and other control characters stripped.
- In hashline mode file headers carry `[path#TAG]` and match rows real line numbers: they are valid anchors for `edit` (only lines actually shown count as seen).
