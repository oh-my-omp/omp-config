---
tool: glob
name: patterns
title: Pattern forms
when: before listing only directories, controlling recursion, or listing internal-URL or remote trees
upstream: pi-coding-agent@18.13.2 src/tools/glob.ts, src/tools/path-utils.ts, omp://tools/glob.md § Inputs, § Modes / Variants
---
# Pattern forms

- Recursion: a bare `*.ts` searches all depths; `src/*.ts` only direct children of `src`; `src/**/*.ts` all descendants. A plain directory path lists everything under it; an exact file path returns just that file.
- Directories only: end the glob with `/` — `packages/*/` (directory symlinks included). Without it files and directories both come back.
- Braces: `src/**/*.{ts,tsx}`; semicolons inside braces do not split.
- Several scopes: `src/**/*.ts;test/**/*.ts`. Missing entries are skipped (`Skipped missing paths: …`); all missing is an error.
- Internal URLs: `local://*.md` (one level), `local://**/*.md`, `omp://tools/*.md`, `skill://<name>/**`, `memory://root/**/*.md`; several all-URL scopes may be joined with `;`. URL globs never recurse implicitly.
- Remote: `ssh://host/dir/**/*.log` walks without a mount (needs exec approval; listings over 1 MiB are refused).
- `hidden: false` drops dotfiles; `gitignore: false` includes ignored entries (ignored dotfiles need this even though `hidden` defaults to true).
- `/` means the session cwd, never the filesystem root.
