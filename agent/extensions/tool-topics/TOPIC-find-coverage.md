---
tool: find
name: coverage
title: What a find search covers
when: before concluding behavior is absent, when hits look thin, or before searching a large tree or hidden files
upstream: pi-coding-agent@18.13.2 src/tools/jfind/{index,cascade,tree,keywords}.ts, omp://tools/find.md § Flow, § Outputs, § Limits & Caps
---
# What a find search covers

- Skipped entirely: hidden files, gitignored paths, build-output directories, lockfiles, binaries, credential files, empty files. To search a hidden file, pass it alone as `path`.
- Funnel: every eligible file is pre-ranked by keywords (from `query` plus `grep_keywords`; quoted phrases count as one term), the best 128 by filename are judged, at most 20 files are read (4 MB each) and only verified passages scoring ≥ 0.20 are returned. Good `grep_keywords` (identifiers, error strings) decide which files get read.
- The whole call has 20 s; on expiry it fails with `find timed out after 20.0s`: scope `path` to a subsystem.
- Coverage: `complete`; `partial` (`F of R` judge requests failed — unjudged files may still match); `unavailable` (all failed — an error; use `grep`, never read it as absence).
- `no hits for "…" (τ 0.20)` only means no verified passage reached the threshold. Rephrase, widen `path`, or `grep` before concluding absence.
- Each hit shows up to three `path:start-end p snippet` ranges; `truncated` means not every line of that file was judged. Read the ranges to confirm.
- `path` is one file or directory (host or internal URL such as `omp://`, `skill://<name>`, `local://`); `ssh://` needs exec approval; line selectors are refused.
