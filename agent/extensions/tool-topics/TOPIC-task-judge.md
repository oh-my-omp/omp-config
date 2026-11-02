---
tool: task
name: judge
title: Let an eval judge read text for you
when: before reading long or many texts (subagent reports, transcripts, search results) only to answer a fixed question about each, or to sort them into classes
upstream: pi-coding-agent@18.13.2 src/prompts/tools/eval-judge.md, src/eval/js/shared/prelude.txt § output
---
# Let an eval judge read text for you

An eval `judge()` reads the text you pass and answers fixed questions with probabilities; only the answers enter your context. Use it in place of reading when the reading only serves a decision: which reports matter, what each one is about, which class each item belongs to. Read in full only what the answers point you to.

```js
const recs = await output(...agentIds);   // [{ id, content }]: pass content, not the record
const b = await judgeBatch(Object.fromEntries(recs.map((r) => [r.id, r.content])), {
  topic: { type: "choice", instructions: "What is this report mainly about?",
    criteria: { lifecycle: "creation, dispatch, closing", results: "how results are delivered or read" } },
  blocker: { type: "bool", instructions: "Does this report name something that blocks the work?" },
}, { intent: "Screening reports" });
for await (const [id, item] of b.drainIter({ timeout: 60 }))
  if (item.ok && item.answers.blocker.bool > 0.5) print(id, item.answers.topic.choice);
await b.close();
```

- One text: `await judge(text, questions)`. Many texts: `judgeBatch`, the same questions over each.
- The judge sees only the state you pass, no files, history or tools. Text comes from values already in the cell: `output(ids)` for agent outputs, bridge results such as `tool.session_query`; files still go through `read`.
- Derive the labels from the decision you have to make. `bool` is a probability of yes, and the threshold is yours.
- An answer sorts and prioritizes; it is not evidence. Read what you act on.
- Assignment splitting, parallel-writer isolation and `task:*` completion are already judged when you dispatch and when a worker yields; do not judge them again.
- Merging many per-item answers in code: `tool://eval/workflow`. Signatures, `score`, images and batch draining: `xd://eval/judge`.
