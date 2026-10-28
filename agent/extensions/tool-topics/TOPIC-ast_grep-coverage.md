---
tool: ast_grep
name: coverage
title: Scopes, paging and incomplete results
when: before concluding there are no matches, or when a result mentions the limit, parse issues or skipped languages
upstream: pi-coding-agent@18.13.2 src/tools/ast-grep.ts, src/utils/grammars.ts, omp://tools/ast-grep.md § Limits & Caps, § Errors, § Notes
---
# Scopes, paging and incomplete results

- `path`: file, directory, glob, internal URL or `;`-list. Unlike `grep`, `*.ts` matches only direct children; use `**/*.ts` to recurse. An empty `path` string is an error (omit it for `.`). `node_modules` is skipped unless the glob names it; hidden files are included; gitignore applies.
- Several paths: missing ones are silently dropped when any other exists — the result does not list them.
- Internal URLs (`local://*.md`, `omp://…`) and web URLs (fetched first) can be searched; line selectors do not bound the search.
- 50 matches per page, ordered by path then position; `Result limit reached` → `skip: 50`, `100`, … or narrow `path`.
- `No matches found` plus parse issues is not absence: fix the pattern or `lang`. Files with syntax errors are still searched. A language whose pattern failed to compile is skipped while others still report matches.
- `Skipped <lang> files: grammar could not be downloaded` means those files were not searched at all; failed downloads back off for 5 minutes.
- In hashline mode match lines carry `[path#TAG]` / `LINE` anchors usable by `edit`; immutable URLs carry none.
