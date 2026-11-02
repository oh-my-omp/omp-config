---
tool: task
name: judge
title: Let an eval judge read many short texts for you
when: before reading many short texts (titles, rows, findings, summaries) only to answer a fixed question about each, or to sort them into classes
upstream: pi-coding-agent@18.13.2 src/prompts/tools/eval-judge.md, src/judgment/index.ts
---
# Let an eval judge read many short texts for you

`judgeBatch` asks the same fixed questions of every text and returns probabilities; only the answers you keep enter your context. Use it in place of reading when the reading only serves a sort or a filter: which items belong to which class, which ones need a closer look. Read in full only what the answers point you to.

```js
const rows = (await tool.session_query({ action: "sessions", limit: 150 })).details.rows;
const b = await judgeBatch(Object.fromEntries(rows.map((r) => [r.sid, r.title ?? ""])), {
  kind: { type: "choice", instructions: "What kind of work does this session title describe?",
    criteria: { coding: "writing or fixing code", infrastructure: "machines, deploys, networks, CI", other: "anything else" } },
}, { intent: "Classifying session titles" });
const byKind = {};
for await (const [sid, item] of b.drainIter({ timeout: 120 }))
  if (item.ok) (byKind[item.answers.kind.choice] ??= []).push(sid);
await b.close();
```

- Keep each text short: a title, a row, one finding, a summary. The judge model has a small context; a long text goes to `completion(…, { schema })` or `agent(…, { schema })` (`tool://eval/workflow`), or is cut down to the part the question needs.
- The judge sees only the text you pass, no files, history or tools. Texts come from values already in the cell, such as bridge results (`tool.session_query`); `output(ids)` returns `{ id, content }` records, so pass `content`. Files still go through `read`.
- Derive the labels from the decision you have to make. `bool` is a probability of yes, and the threshold is yours.
- An answer sorts and filters; it is not evidence. Read what you act on.
- Assignment splitting, parallel-writer isolation and `task:*` completion are already judged when you dispatch and when a worker yields; do not judge them again.
- One text: `await judge(text, questions)`. Signatures, `score`, images and batch draining: `xd://eval/judge`.
