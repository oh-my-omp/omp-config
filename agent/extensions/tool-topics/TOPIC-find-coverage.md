---
tool: find
name: coverage
title: What a find search covers
when: before concluding behavior is absent, when hits look thin, or before searching a large tree or hidden files
upstream: pi-coding-agent@19.1.1 src/tools/jfind/{index,cascade,tree,keywords}.ts, omp://tools/find.md § Outputs, § Flow, § Limits & Caps, § Errors
hiddenFromIndex: true
inject:
  - id: find-coverage-error
    tool: find
    onError: true
  - id: find-coverage-partial
    tool: find
    resultPattern: '(?:partial:|no hits for|truncated|unavailable|before any passage was verified|no eligible files|find is disabled)'
---
# What a find search covers

- Skipped entirely: hidden files, gitignored paths, build-output directories, lockfiles, binaries, credential files (committed templates `.env.example`, `.env.sample`, `.env.template`, `.env.dist` are NOT excluded), and empty files. To search a hidden file, pass it alone as `path`.
- Funnel: every eligible file is pre-ranked by keywords (from `query` plus `grep_keywords`; quoted phrases count as one term); when Spotlight is active it ranks all candidates (otherwise the judge ranks the top 128 by filename); at most 20 files are read (4 MB each), cut into up to 24 windows/file @ 8 KB, sketched and filtered at 0.45 cutoff (up to 40 passages verified), and only verified passages scoring ≥ `find.hitThreshold` (default `τ = 0.20`; scores below ~0.4 are weak evidence) are returned. Good `grep_keywords` (identifiers, error strings) decide which files get read.
- The whole call has 20 s:
  - Deadline during verification with passages verified (`timeout.passages > 0`): returns verified hits and appends `partial: timed out after 20.0s with V of P passages verified; unverified files may still match` (plus `lexicalFallback` literal keyword matches when `hits.length === 0`). Narrow `path` or use `grep` before concluding absence.
  - Deadline before any passage was verified (`timeout.passages === 0`): returns a non-error notice `find timed out after 20.0s at "<phase>", before any passage was verified. This is not evidence of absence; narrow path, or use grep` along with `unranked literal keyword matches` (`lexicalFallback`) when available.
  - Deadline before any file was judged: throws `find timed out after 20.0s at "<phase>", before any file was judged`.
- Coverage: `complete`; `partial` (`F of R` judge requests failed, or the deadline cut verification short — unjudged/unverified files may still match); `unavailable` (all judge requests failed — returns an error notice plus `lexicalFallback` literal matches when available; use `grep`, never read it as absence).
- `no hits for "…" (τ 0.20)` only means no verified passage reached the threshold. Rephrase, widen `path`, or `grep` before concluding absence.
- Each hit shows up to three `path:start-end p snippet` ranges; `truncated` means not every line of that file was judged. Read the ranges to confirm.
- `path` is one file or directory (host or internal URL such as `omp://`, `skill://<name>`, `local://`); `ssh://` needs exec approval. `http(s)://` URLs, `;`-delimited path lists, and line selectors (`:start-end`) are rejected.
