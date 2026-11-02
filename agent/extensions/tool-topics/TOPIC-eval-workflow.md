---
tool: eval
name: workflow
title: Program-driven model work over many items
when: before handling a list of values in hand where each item needs model judgment, extraction or transformation and code merges the results
upstream: pi-coding-agent@18.13.2 src/prompts/tools/eval-agents.md, src/prompts/tools/eval-judge.md, src/task/workpool.ts, src/task/workpool-yield.ts
---
# Program-driven model work over many items

The cell owns the item list and the merge; a model handles only each item's judgment. Start from values already in the cell, from an earlier tool result or a bridge such as `tool.session_query`; files are still acquired with `read`/`grep`/`glob`.

| Each item needs | Use | The cell gets |
|---|---|---|
| The same classification, yes/no or score question | `judgeBatch(states, questions)` | answers per key from `drain` |
| A tool-free extraction or rewrite | one `completion(prompt, { model: "smol", schema })` per item | schema-parsed objects from `wait` |
| A subagent's tools (read, run, fetch) and typed output | one `agent(prompt, { agent, schema })` per item | schema-parsed objects from `wait` |
| Independent subagent work whose outcome is prose for you | `workpool(agent, { name, context })` | text only: the aggregate arrives in your conversation; `peek()` returns text snapshots, not typed records |

```js
const schema = { type: "object", additionalProperties: false, required: ["id", "label"],
  properties: { id: { type: "string" }, label: { type: "string" } } };
const handles = rows.map((r) => completion(`Classify this record.\nid: ${r.id}\ntext: ${r.text}`, { model: "smol", schema }));
const out = await wait(handles, { raiseErrors: false });
const failed = rows.filter((_, i) => out[i] instanceof Error);
const byLabel = Object.groupBy(out.filter((o) => !(o instanceof Error)), (o) => o.label);
```

- Put the item's own id in the prompt and in the schema, and merge on it.
- Send long lists in waves and `wait` each wave: every `agent()` handle is a running background job.
- `raiseErrors: false` (Python `raise_errors=False`) keeps a failure in its slot; resend only the failed items.
- `agent` takes a predefined agent and runs on that agent's bound model: choose it as for `task`. Without `schema`, `.wait()` returns text.
- Results you only read, never compute on: `tool.task` (`tool://task/batch`).
- Signatures and handle methods: `xd://eval/judge`, `xd://eval/agents`.
