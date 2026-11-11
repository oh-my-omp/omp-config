---
name: wait-over-five-minutes-is-an-alarm
description: "Treat any subagent or job pending more than five minutes as an alarm: inspect, diagnose and report before waiting again"
condition: "\"i\"\\s*:\\s*\""
scope: "tool:wait"
---

Five minutes of waiting on anything (subagent, job, CI, service) is an alarm, not a normal state.

Before this `wait`:
1. Work out how long the item has been pending since you dispatched it or last saw it make progress. Use the dispatch time and the earlier `wait` notices (`No job finished within 5m`, the elapsed time on the agent line).
2. If it has been pending longer than 5 minutes, do not wait again yet:
   - Read `history://<id>` (or `proc://<id>`) and find the last real step: which command, what result, and when.
   - Name the cause. It may be slow but legitimate work (a container building, a long e2e run), or it may be a loop, polling, sleeping, an error retry, a pending question to you, or work outside the assignment.
   - Act on the cause: steer with `write agent://<id>`, answer its contract question, or stop it with `proc://<id>/kill` and re-dispatch a narrower brief.
   - Tell the user in one short `out://` note what is slow, why (cite the transcript line), and what you did.
3. Never chain waits whose windows add up to more than 5 minutes without doing step 2 between them. Choose a wait only when the transcript shows on-assignment progress since your last check.