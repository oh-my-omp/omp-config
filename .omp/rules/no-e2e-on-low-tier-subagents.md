---
name: no-e2e-on-low-tier-subagents
description: "Never hand e2e/acceptance runs in real omp or the sandbox to task:free1 or task:low subagents"
condition: ["\"agent\"\\s*:\\s*\"task:(?:free1|low)\"[\\s\\S]{0,4000}?(?:e2e|sandbox|验收|exec_command|omp --model|PTY)", "(?:e2e|sandbox|验收|exec_command|omp --model|PTY)[\\s\\S]{0,4000}?\"agent\"\\s*:\\s*\"task:(?:free1|low)\""]
scope: "tool:task"
---

Do not dispatch e2e tests or independent acceptance to `task:free1` or `task:low`. Acceptance here means driving real omp in the OrbStack sandbox, PTY sessions, `omp --model …` runs, or the issue's acceptance rows. Those models are too weak for it: they repeat empty polls, misread terminal state, and report passes from their own labels.

- Give e2e and acceptance runs to at least `task:mid`. Use `task:high` when the user has allowed it in this conversation.
- This rule overrides delivering-issues, which assigns acceptance to `task:free1`. Keep the brief, the isolation and the fresh-per-round requirement; only raise the tier.
- `task:free1` and `task:low` stay acceptable for read-only work that runs no real omp session, such as code review without e2e or probes over settled facts.
- Before reporting what an acceptance agent found, read its `history://<id>` and cite it.