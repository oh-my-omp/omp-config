---
tool: grep
name: scopes
title: What `path` can search
when: before excluding paths, or searching archives, internal URLs, web pages or remote `ssh://` directories
upstream: pi-coding-agent@19.1.1 src/tools/grep.ts, src/tools/path-utils.ts, omp://tools/grep.md § Inputs, § Modes / Variants
inject:
  - id: grep-scopes
    tool: grep
    parameter: path
    pattern: '(^|;)!|://|\.(zip|jar|whl|tar|tgz|gz|zst):'
---
# What `path` can search

- Several scopes: `src;tests;docs/*.md` (`;` splits unconditionally; comma splits when at least one part resolves, whitespace splits only when every part resolves, and existing literal paths with delimiters stay intact). Missing entries are skipped with a warning (`details.missingPaths`); only when all are missing is it an error.
- Exclusions: an entry starting with `!` that is not an existing path excludes a glob or directory from the walk: `!**/*.test.ts` or `!*.test.ts` matches at any depth, `!vendor` drops that folder anywhere, while `!src/legacy` / `!./gen` (containing `/`) are cwd-anchored relative to cwd only. Only exclusions = search `.` minus them. A file you name explicitly is never excluded.
- Globs: `*.ts` any depth, `dir/*.ts` direct children, `dir/**/*.ts` recursive. An existing path containing glob characters is taken literally.
- One file plus lines: `src/app.ts:50-100` (also `:5-10,20-30`, `:N+K`) limits matches to those lines; not allowed on a directory or glob.
- Archives: `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md` search UTF-8 members; binary members are skipped.
- Internal URLs: `skill://<name>`, `local://`, `local://<id>.log`, `history://<id>`, `omp://`, and URL globs like `local://notes/**/*.md`, `omp://**/*.md`. Hits keep their URL; `:raw` and `:conflicts` search a resource whole (and may combine with line ranges).
- Web: `https://…` is fetched and searched (absolute line ranges only, no `:-N`). Other schemes (`ftp://`, `ws://`): `read` first.
- `ssh://host/dir` searches remote files (1 MiB per file; directory listings above 1 MiB are refused rather than silently truncated).
- `gitignore: false` also searches ignored files. Dotfiles are always included.
