---
tool: github
name: pull-requests
title: Creating, checking out and pushing PRs
when: before `pr_create`, `pr_checkout` or `pr_push`
upstream: pi-coding-agent@18.13.2 src/tools/gh-pr-checkout.ts, omp://tools/github.md § Modes / Variants
---
# Creating, checking out and pushing PRs

- `pr_create`: give `title` (or `fill: true`, which excludes `title` and `body`). `body` is Markdown; omitted or empty means no body (never opens an editor). `base`/`head` pick branches (`head` defaults to the current one); `draft`, and `reviewer`/`assignee`/`label` as string arrays. The result has the URL, state, base/head and labels but not the body: read `pr://<N>` to see it.
- `pr_checkout`: `pr` is a number, branch name or PR URL, or an array of them for a batch; omitted = the PR of the current branch. Each PR gets its own git worktree (under `~/.omp/wt` unless configured) on branch `pr-<number>`; your working tree is untouched. An existing matching worktree is reused (`reused`); a stale `pr-<number>` branch without a worktree needs `force: true`. Cross-repository PRs get a `fork-<owner>` remote. Batches report failures per PR.
- `pr_push`: only for a branch made by `pr_checkout` (it records where the PR head lives). Pushes the current branch, or `branch`, to the PR's head ref with git directly; `forceWithLease: true` after a rebase. `repo` is ignored.
- Use these for the remote and git side; read PRs with `pr://<N>`, `pr://<N>/diff`, `pr://<N>/diff/<i>`.
