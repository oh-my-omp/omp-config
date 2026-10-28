---
tool: grep
name: regex
title: Pattern syntax
when: before using lookaround, backreferences, multiline patterns, or patterns containing braces or parentheses
upstream: pi-coding-agent@18.13.2 src/tools/grep.ts, omp://tools/grep.md § Flow, § Notes
---
# Pattern syntax

- Write Rust regex. Lookaround (`(?=…)`, `(?<!…)`) and backreferences (`\1`) work too: such patterns run on PCRE2 automatically.
- Multiline: put a real newline or the two characters `\n` in `pattern`; otherwise matching is per line. Multiline search of a single named file over 4 MiB only covers its first 4 MiB (the result says so).
- Braces that cannot be a quantifier are literal (`{foo}`); `a{2,4}` stays a quantifier. A group syntax both engines reject is retried with escaped parentheses, then as a literal string; only a remaining failure reports `Invalid regex: …`.
- Leading/trailing spaces in `pattern` are kept and matched. An all-whitespace pattern is an error.
- `case: false` for case-insensitive; default is case-sensitive.
