---
tool: task
name: follow-up
title: Following up with agents that already ran
when: before giving more work to, messaging, or reading back an agent that already exists
upstream: pi-coding-agent@19.1.1 src/task/settings.ts, src/registry/agent-lifecycle.ts, src/prompts/tools/task-follow-up.md, src/internal-urls/agent-protocol.ts, src/internal-urls/history-protocol.ts, omp://tools/task.md § Flow, § Notes
---
# Following up with agents that already ran

- Prefer `write agent://<id>` over a new spawn for follow-up work: the agent already holds the context. A fresh spawn starts blank.
- Lifecycle: `running` → `idle` when its run ends (success or failure) → `parked` after about 7 minutes idle (`task.agentIdleTtlMs`, 420000 ms). A parked agent keeps its registry entry and transcript; messaging it revives it. An explicit kill sets `aborted` (writing a kill tombstone); messaging it or reviving it from the Agent Hub reopens its transcript as a fresh `parked` generation and revives it, unless it has no resumable session contract, ran isolated, or its workspace is gone.
- Isolated runs: follow-up notices report isolated agents as non-resumable and non-messageable (read `history://<id>` for their transcript).
- Messaging: `write agent://<id>` with non-empty content to one agent; `write agent://all` broadcasts to visible live peers and is write-only. Only the main agent can broadcast: a subagent's `agent://all` write fails, so it messages each agent by id. A message target cannot carry a `/<json-path>` suffix. The reply arrives as an incoming message; when blocked on it, end your turn in `endTurn` sessions or call `wait` otherwise.
- Ids: the `name` you gave (or the generated AdjectiveNoun). Repeated names become `Name`, `Name-2`, …. A child's own children are `agent://<parent>.<child>`.
- Two read channels:
  - `agent://<id>` — the published final output (line selectors apply). While nothing is published yet it shows live/parked progress, status and latest text. After the agent starts a newer turn, the old output carries a superseded notice.
  - `history://<id>` — the read-only transcript, also for parked and disk-only agents; bare `history://` lists known ids with status, kind, parent and last activity.
- `agent://<id>/<json-path>` extracts one value from structured output (object keys, numeric array indexes); it fails when the output is not JSON.
