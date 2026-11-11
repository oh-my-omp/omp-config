---
name: no-blind-wait-on-subagents
description: "Before each wait on a running subagent, read its transcript to confirm it is making real progress"
condition: "\"i\"\\s*:\\s*\"[^\"]*(Waiting|waiting|等待)"
scope: "tool:wait"
---

Do not call `wait` again and again while a subagent runs. Every wait leaves it unwatched, and in this session a subagent spun idle for about half an hour behind repeated waits.

Before each `wait`:
1. Read `history://<id>` to see what the subagent has actually done since your last check: the commands it ran, the files it changed, and the tool results it got. Do not rely on the `stage: …` or `~NN%` progress label; the subagent writes that label itself.
2. Act on what the transcript shows:
   - If it is repeating the same call, polling, sleeping, stuck on an error, or doing work outside its assignment, steer it with `write agent://<id>`, or stop it with `proc://<id>/kill` and dispatch a corrected brief.
   - If it is blocked waiting for a contract decision from you, make the decision now.
3. Call `wait` only after the transcript shows real, on-assignment progress and you have no other reachable work. Between waits, do that reachable work: verify, prepare the next brief, or update issue contracts.

When you tell the user about a subagent's progress, cite its transcript, not the status line.