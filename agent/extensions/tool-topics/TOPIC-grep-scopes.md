---
tool: grep
name: scopes
title: What `path` can search
when: before excluding paths, or searching archives, internal URLs, web pages or remote `ssh://` directories
upstream: pi-coding-agent@18.13.2 src/tools/grep.ts, src/tools/path-utils.ts, omp://tools/grep.md § Inputs, § Modes / Variants
---
# What `path` can search

- Several scopes: `src;tests;docs/*.md`. Missing entries are skipped with a warning (`details.missingPaths`); only when all are missing is it an error.
- Exclusions: an entry starting with `!` that is not an existing path excludes a glob or directory from the walk: `src;!**/*.test.ts;!vendor`. Only exclusions = search `.` minus them. A file you name explicitly is never excluded.
- Globs: `*.ts` any depth, `dir/*.ts` direct children, `dir/**/*.ts` recursive. An existing path containing glob characters is taken literally.
- One file plus lines: `src/app.ts:50-100` (also `:5-10,20-30`, `:N+K`) limits matches to those lines; not allowed on a directory or glob.
- Archives: `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md` search UTF-8 members; binary members are skipped.
- Internal URLs: `skill://<name>`, `local://`, `artifact://<id>`, `history://<id>`, `omp://`, and URL globs like `local://notes/**/*.md`, `omp://**/*.md`. Hits keep their URL; `:raw` searches a resource's raw text.
- Web: `https://…` is fetched and searched (absolute line ranges only, no `:-N`). Other schemes (`ftp://`, `ws://`): `read` first.
- `ssh://host/dir` searches remote files (1 MiB per file).
- `gitignore: false` also searches ignored files. Dotfiles are always included.
