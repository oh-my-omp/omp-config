---
tool: read
name: runtime
title: Agents, jobs, artifacts and transcripts
when: before reading `agent://`, `history://`, `proc://` or `artifact://`
upstream: pi-coding-agent@18.13.2 src/internal-urls/{agent,history,proc,artifact}-protocol.ts, src/prompts/internal-urls/proc.md, omp://tools/read.md § Internal URLs
---
# Agents, jobs, artifacts and transcripts

- `agent://<id>` — the agent's latest published output (line selectors apply); before anything is published it shows status and progress. Nested agents use dots: `agent://Parent.Child`. `agent://<id>/<key>/<index>` extracts a value from JSON output (strings as text, others as JSON, missing → `null`); it needs published valid JSON. `agent://all` cannot be read.
- `history://` lists registered and persisted subagents; `history://<id>` is the read-only transcript. For "what did we already do" prefer `ctx`; use history for exact wording, tool arguments or raw errors.
- `proc://` lists your jobs, running agents and services; `proc://<id>` shows status and output without consuming delivery. `proc://<id>/streams` lists a bash job's pipes and `proc://<id>/streams/<n>` returns what crossed pipe n, including data a `| tail` or `| grep` hid: never rerun the command for it. Reading `/kill` or `/mode` changes nothing.
- `artifact://<id>` — spilled full output; page it with `:N-M` or `:raw:N-M` (any size).
- An unbounded `:raw` of a resource over 50 KiB is refused; bound it (`:raw:1-3000`).
