---
tool: read
name: summaries
title: Summarized code reads
when: when a code read came back with elided `…` bodies, or before editing lines you have not seen in full
upstream: pi-coding-agent@18.13.2 src/prompts/tools/read.md, omp://tools/read.md § Local text files
---
# Summarized code reads

- A bare read of a code file of 100+ lines returns a structural summary: declarations kept, long bodies (≥4 lines) and block comments (≥6 lines) folded to `…` / `{ … }`. The footer lists the omitted line ranges.
- Never infer what a folded body contains, and never edit lines you only saw folded: read the footer-named range (`file:120-180`) first.
- Any explicit selector or `:raw` returns the lines verbatim. Markdown and `.txt` are not summarized; files over 2 MiB or 20,000 lines are not summarized either.
- Hashline headers (`[path#TAG]`) and `LINE:` positions come only from non-raw reads of editable files; archive members, generated views and query outputs never carry them.
