---
tool: read
name: runtime
title: Agents, jobs, logs and transcripts
when: before reading `agent://`, `history://`, `proc://` or `local://<id>.log`
upstream: pi-coding-agent@19.1.1 src/internal-urls/{agent,history,proc,local}-protocol.ts, src/prompts/internal-urls/proc.md, omp://tools/read.md § Internal URLs
inject:
  - id: read-runtime
    tool: read
    parameter: path
    pattern: '^(?:(?:agent|history|proc)://|local://\d+\.log)'
---
# Agents, jobs, logs and transcripts

- `agent://<id>` — the agent's latest published output (line selectors apply); before anything is published it shows status and progress, and while a newer turn runs the previous output carries a superseded banner. Nested agents use dots: `agent://Parent.Child`. `agent://<id>/<key>/<index>` extracts a value from JSON output (strings as text, others as JSON, missing → `null`); it needs published valid JSON. `agent://all` cannot be read. With `task.crossInstance` enabled, `agent://peers` lists other omp instances in this project, `agent://<pid>` reads another instance's progress, and `agent://<pid>/<id>` reads its subagent's output.
- `history://` lists registered and persisted subagents; `history://<id>` is the read-only transcript: exact wording, tool arguments and raw errors. With `compaction.experimentalContextManagement` enabled, `history://current/full` exposes the caller's complete current branch (original text, tool outputs, entry IDs, compaction boundaries; page with `:raw:1-200`; queries/fragments/extra paths are rejected; bare `history://current` still names an agent called `current`).
- `proc://` lists your jobs, running agents and services; `proc://<id>` shows status and output without consuming delivery. `proc://<id>/streams` lists a bash job's `|` pipe stages and redirected output files (`> log`), and `proc://<id>/streams/<n>` returns what crossed pipe or file n, including data a `| tail` or `| grep` hid: never rerun the command for it. Reading `/kill` or `/mode` changes nothing.
- `local://<id>.log` — spilled full output (including `[raw output: local://<id>.log]`): an ordinary file at the session's `local://` root, readable via the filesystem pipeline at any size with `:N-M` or `:raw:N-M`.
- An unbounded `:raw` of a resource over 50 KiB is refused; bound it (`:raw:1-3000`).
