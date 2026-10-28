---
tool: wait
name: replies
title: Waiting for a peer's reply
when: before waiting for an answer to a message you sent with `write agent://<id>`
upstream: pi-coding-agent@18.13.2 src/tools/wait.ts, src/irc/bus.ts, omp://tools/wait.md
---
# Waiting for a peer's reply

- `wait` blocks for a reply only to a **direct** message you sent this run (`write agent://<id>`). A broadcast to `agent://all` creates no reply obligation; send a direct message when you need the answer.
- The reply counts when that peer messages you back, or when a job of that peer that you own settles (a spawn job, or a turn your message woke).
- Any incoming message ends the wait, not only the answer you asked for; read it, then call `wait` again if you are still blocked.
- The wait is kept alive only by peers that are still running or still hold your question for their turn; an idle peer does not keep it blocked.
- When every asked peer finished without answering, the result says so and names them ("finished its turn without replying"). Ask again or finish without the answer.
- When the asked peer can only answer after you finish (it is waiting on your result, e.g. it spawned you inline), the result says so instead of deadlocking. Finish without the answer.
- After the 30-minute cap a reply-only wait returns "Wait limit reached with no reply". Ask again or finish without it.
- A received message arrives as `[<message-id>] <sender> (reply to <id>): <body>`; the sender is in that text and in `details.waited`, not in `details.from` (which is you).
