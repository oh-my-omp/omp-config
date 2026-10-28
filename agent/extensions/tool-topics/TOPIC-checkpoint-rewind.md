---
tool: checkpoint
name: rewind
title: What rewind keeps and drops
when: before starting a checkpoint you will later rewind, or before writing the rewind report
upstream: pi-coding-agent@18.13.2 src/tools/checkpoint.ts, src/session/agent-session.ts, omp://tools/checkpoint.md, omp://tools/rewind.md
---
# What rewind keeps and drops

- Rewind trims conversation context only. Files you edited, commands you ran, processes and artifacts stay as they are: it is not a git or filesystem rollback.
- After `rewind`, everything since the checkpoint leaves your context except the report; the next turn sees the report once. Write it self-contained: findings, decisive evidence (paths, lines, outputs), what remains open.
- The replacement happens when the current assistant turn ends; `Rewind requested.` only acknowledges it. Tool calls made in the same batch as `rewind` stay visible.
- One checkpoint at a time; no nesting (`Checkpoint already active.`). A finished checkpoint cannot be rewound again — start a new one for further exploration.
- An empty or whitespace report is refused. `rewind` without an active checkpoint fails.
- An open checkpoint survives resume and reload; you still owe its rewind before yielding.
- Subagents get these tools only when their definition lists `checkpoint` or `rewind`.
