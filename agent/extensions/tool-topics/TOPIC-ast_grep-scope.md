---
tool: ast_grep
name: scope
title: Path, language and results
when: before choosing `path` or `lang`, or when a result says the limit was reached
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-grep.md, omp://tools/ast-grep.md § Flow, § Limits, § Notes
---
# Path, language and results

- Keep each call to one language and a narrow `path`; avoid repo-root scans. `path` takes files, directories, globs and internal URLs; several as `src; tests`.
- The language is inferred per file from its extension; `.cu` and `.cuh` infer as C++. Set `lang` only when inference is ambiguous (`cpp` for `.h`): it forces that grammar on every file in scope, so other files under a directory (such as `.md`) come back as parse issues. Select the files with a glob instead.
- Globs: `dir/*.ts` matches direct children only; `dir/**/*.ts` recurses. This differs from `grep`, where `*.ts` matches at any depth.
- Directory scans respect `.gitignore`, include hidden files, and skip `node_modules` unless the glob names it.
- Results are capped per call. "Result limit reached" → narrow `path` or page with `skip`.
