---
tool: task
name: follow-up
title: Following up with agents that already ran
when: before giving more work to, messaging, or reading back an agent that already exists
upstream: pi-coding-agent@18.13.2 src/task/settings.ts, src/internal-urls/agent-protocol.ts, src/internal-urls/history-protocol.ts, omp://tools/task.md § Notes
---
# Following up with agents that already ran

- Prefer `write agent://<id>` over a new spawn for follow-up work: the agent already holds the context. A fresh spawn starts blank.
- Lifecycle: `running` → `idle` when its run ends (success or failure) → `parked` after about 7 minutes idle (`task.agentIdleTtlMs`, 420000 ms). A parked agent keeps its registry entry and transcript; messaging it revives it. `aborted` follows an explicit kill.
- Messaging: `write agent://<id>` with non-empty content to one agent; `write agent://all` broadcasts to visible live peers and is write-only. A message target cannot carry a `/<json-path>` suffix. The reply arrives as an incoming message; call `wait` only if you are blocked on it.
- Ids: the `name` you gave (or the generated AdjectiveNoun). Repeated names become `Name`, `Name-2`, …. A child's own children are `agent://<parent>.<child>`.
- Two read channels:
  - `agent://<id>` — the published final output (line selectors apply). While nothing is published yet it shows live/parked progress, status and latest text. After the agent starts a newer turn, the old output carries a superseded notice.
  - `history://<id>` — the read-only transcript, also for parked and disk-only agents; bare `history://` lists known ids with status, kind, parent and last activity.
- `agent://<id>/<json-path>` extracts one value from structured output (object keys, numeric array indexes); it fails when the output is not JSON.
