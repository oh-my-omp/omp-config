---
tool: read
name: selectors
title: Line selectors and paging
when: before reading several ranges at once, an exact raw slice, or paging a long file
upstream: pi-coding-agent@18.13.2 src/prompts/tools/read.md, pi-tui src/tools/line-ranges.ts, omp://tools/read.md § Selector grammar, § Local text files
---
# Line selectors and paging

- Forms (1-indexed, inclusive; `L` prefix optional): `:N` / `:N-` / `:N..` from line N on; `:A-B` / `:A..B`; `:A+C` (C lines from A); `:-N` last N lines.
- Lists: `:5-16,960-973`, `:19,59`, `:1-12,-15` — sorted and merged.
- `:raw` in either order with a range (`:2-4:raw`, `:raw:2-4`): exact text, no line prefixes, no summaries, no edit header. In raw mode a bare `:17:raw` is that one line; `:17-:raw` is open-ended.
- Non-raw single ranges add one line before and three after (plus enclosing block open/close lines). Use raw when you need exactly the selection.
- An open-ended read returns 300 lines; output stops at 3000 lines or ~50 KiB, whichever comes first. Follow the footer's continuation selector rather than assuming the whole range arrived. Huge files may say EOF was not scanned and give only `:N` to continue.
- Out-of-range selections do not fail: they suggest the valid start or last line. Line 0, non-positive counts and descending ranges are errors.
- If a file literally named `a:1` exists, that name wins over the selector.
- Reading the same unchanged range a third time yields a hint to narrow or move on.
