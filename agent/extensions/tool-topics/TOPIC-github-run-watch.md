---
tool: github
name: run-watch
title: Watching GitHub Actions
when: before waiting for CI with `run_watch`, or when reading its failure report
upstream: pi-coding-agent@19.1.1 src/tools/gh-run-watch.ts, omp://tools/github.md § Outputs, § Modes / Variants > run_watch
---
# Watching GitHub Actions

- Two modes: `run` (a run id or full run URL) watches one run; without it, every run for a commit is watched — the remote head of `branch` if given, otherwise your local branch's HEAD (the checkout must be that repository).
- It polls every 3 s for the first minute, then every 15 s, and streams progress. A single completed run returns at once; commit mode confirms once more before reporting success, so success means every run stayed green.
- If no run appears for the commit within 90 s it gives up (push first, or the workflow did not trigger).
- On the first failed job it waits 5 s, refetches so parallel failures are included, then returns: the last `tail` lines (default 15, max 200) of each failed job inline and saved logs as `local://<id>.log`, labelled `Full failed-job logs` (every failed job captured completely), `Partial failed-job logs` (some missing or truncated), or `Failed-job log diagnostics` (no log content available). Read `local://<id>.log` instead of rerunning.
- Success: `success`, `neutral`, `skipped`. Failure: `failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`.
- Rate limits back off and retry up to five times; other API errors fail the watch.
