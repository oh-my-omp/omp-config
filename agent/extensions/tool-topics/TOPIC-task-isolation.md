---
tool: task
name: isolation
title: Isolated workers
when: 'before setting `isolated: true`, or after an isolated item failed to start or merge'
upstream: pi-coding-agent@19.1.1 src/task/settings.ts, src/task/worktree.ts, src/task/isolation-runner.ts, omp://tools/task.md § Modes / Variants, § Errors
hiddenFromIndex: true
inject:
  - id: task-isolation-result
    tool: task
    resultPattern: '(?:isolated|worktree|cherry-pick|patch artifact|uncommitted baseline|ovnfs|core\.bare)'
---
# Isolated workers

- `isolated: true` gives the item its own checkout; omitted or `false` runs in yours. Each item sets it independently.
- Backend (`isolation.backend`, default `auto`): when the `ovnfs` binary (`ovnfs.path` or `ovnfs` on `PATH`) is found, `auto` runs each isolated subagent in an `ovnfs` copy-on-write checkout with no fallback (if `ovnfs` fails, the isolated task fails); otherwise the native isolation PAL picks the best available backend (`apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`).
- This setup (`task.isolation.merge: branch`, `apply` on): the child's commits land on a task branch and are cherry-picked onto your branch with their messages when it succeeds. Nested repositories get separate patch artifacts. With `apply` off, changes would be retained, not applied.
- Requirements: the cwd must be a Git work tree (pure Jujutsu needs a colocated Git; bare repositories with `core.bare=true` are refused — start the session in a linked work tree); each repository's uncommitted baseline must stay under 1 GiB. Violations fail before the child starts.
- Not allowed together with plan mode.
- Give isolated children repository-relative paths, and tell them which uncommitted changes in your checkout already exist: they start from a snapshot of it.
- An isolated agent kept alive (idle/parked) keeps its workspace; its final patch/branch state is captured when it is released.
- On setup or capture failure the item fails; preserved patches/recovery artifacts may remain for manual salvage.
