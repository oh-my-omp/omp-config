---
tool: find
name: coverage
title: What a find search covers
when: before concluding behavior is absent, when hits look thin, or before searching a large tree or hidden files
upstream: pi-coding-agent@18.22.0 src/tools/jfind/{index,cascade,tree,keywords}.ts, omp://tools/find.md § Outputs, § Flow, § Limits & Caps, § Errors
---
# What a find search covers

- Skipped entirely: hidden files, gitignored paths, build-output directories, lockfiles, binaries, credential files, empty files. To search a hidden file, pass it alone as `path`.
- Funnel: every eligible file is pre-ranked by keywords (from `query` plus `grep_keywords`; quoted phrases count as one term), the best 128 by filename are judged, at most 20 files are read (4 MB each) and only verified passages scoring ≥ 0.20 are returned. Good `grep_keywords` (identifiers, error strings) decide which files get read.
- The whole call has 20 s. When the deadline cuts verification short with at least one hit above the threshold, the call returns those hits and appends `partial: timed out after 20.0s with N of M passages verified; unverified files may still match`. The hits are verified evidence; the files left unverified may still match, so narrow `path` (or search them with `grep`) before concluding absence instead of re-running the same broad search.
- When the deadline fires with no hit above the threshold — nothing verified yet, or every verified passage below it — the call fails instead: `find timed out after 20.0s at "<phase>", before any hit was verified`, where `<phase>` is the last progress message (`lexical scan`, `filename ranking 64/128`, `verifying N passages in M files`). Narrow `path` to a smaller tree, or use `grep`; do not read the failure as absence.
- Coverage: `complete`; `partial` (`F of R` judge requests failed, or the deadline cut verification short — files not yet judged or verified may still match); `unavailable` (all failed — an error; use `grep`, never read it as absence).
- `no hits for "…" (τ 0.20)` only means no verified passage reached the threshold. Rephrase, widen `path`, or `grep` before concluding absence.
- Each hit shows up to three `path:start-end p snippet` ranges; `truncated` means not every line of that file was judged. Read the ranges to confirm.
- `path` is one file or directory (host or internal URL such as `omp://`, `skill://<name>`, `local://`); `ssh://` needs exec approval; line selectors are refused.
