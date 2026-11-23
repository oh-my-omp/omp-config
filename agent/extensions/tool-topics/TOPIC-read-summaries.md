---
tool: read
name: summaries
title: Summarized code reads
when: when a code read came back with elided `…` bodies, or before editing lines you have not seen in full
upstream: pi-coding-agent@19.1.1 src/prompts/tools/read.md, src/tools/read-summary.ts, src/tools/settings.ts, omp://tools/read.md § Local text files
hiddenFromIndex: true
inject:
  - id: read-summaries-folded
    tool: read
    resultPattern: '(?:\{ … \}|elided|omitted|folded|structural summary)'
---
# Summarized code reads

- A bare read of a code file of 100+ lines returns a structural summary: declarations kept, long bodies (≥4 lines) and block comments (≥6 lines) folded to `…` / `{ … }`, with BFS unfolding up to `read.summarize.unfoldUntil` (default 50 visible lines) under the hard ceiling `read.summarize.unfoldLimit` (default 100 lines). The footer lists the elided line ranges.
- Never infer what a folded body contains, and never edit lines you only saw folded: read the footer-named range (`file:120-180`) first.
- Any explicit selector or `:raw` returns the lines verbatim. Markdown and `.txt` are not summarized; files over 2 MiB or 20,000 lines are not summarized either.
- Hashline headers (`[path#TAG]`) and `LINE:` positions come only from non-raw reads of editable files; archive members, generated views and query outputs never carry them.
