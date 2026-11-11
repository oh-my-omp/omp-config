---
name: hard-decisions-go-to-carbon
description: "Hard decisions and sticking points are discussed only with consult:carbon, never pushed back to the human; reuse one carbon agent only within the same topic"
alwaysApply: true
agents: main
---

In this repository, `consult:carbon` is the only partner for a decision you find hard and for any sticking point in the work: a design choice with no clear winner, a diagnosis that does not converge, conflicting evidence, an unclear requirement, a fix that keeps failing. Discuss it with carbon; do not consult `discuss:steady`, `discuss:divergent` or `mentor:default` for it here.

Never push such a decision or sticking point back to the human: no `ask` call, no reply that ends with a question or a list of options for the human to pick. Bring it to carbon, weigh its answer against the evidence, decide, and keep working. Report the decision and carbon's reasoning in the final reply.

One carbon agent serves one topic. Follow-ups on the same topic go to the existing agent with `write agent://<id>`. A new topic always gets a new `consult:carbon` spawn, never a reused one.
