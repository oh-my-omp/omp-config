---
tool: eval
name: workflow
title: Program-driven model work over many items
when: before handling a list of values in hand where each item needs model judgment, extraction or transformation and code merges the results
upstream: pi-coding-agent@19.1.1 src/prompts/tools/eval-judge.md, src/tools/eval-doc-topics.ts
---
# Program-driven model work over many items

A JavaScript cell owns the item list and the merge; a model handles only each item's judgment. Start from values already in the cell, from an earlier tool result or a `tool.<name>()` bridge call; files are still acquired with `read`/`grep`/`glob`.

| Each item needs | Use | The cell gets |
|---|---|---|
| The same classification, yes/no or score question | `judgeBatch(states, questions)` | answers per key from `drain` |
| A tool-free extraction or rewrite | one `completion(prompt, { model: "default"\|"smol"\|"slow"\|"m<N>", schema })` per item | schema-parsed objects from `wait` |

Items that each need a subagent: `help://flow/eval`.

```js
const schema = { type: "object", additionalProperties: false, required: ["id", "label"],
  properties: { id: { type: "string" }, label: { type: "string" } } };
const handles = rows.map((r) => completion(`Classify this record.\nid: ${r.id}\ntext: ${r.text}`, { model: "smol", schema }));
const out = await wait(handles, { raiseErrors: false });
const failed = rows.filter((_, i) => out[i] instanceof Error);
const byLabel = Object.groupBy(out.filter((o) => !(o instanceof Error)), (o) => o.label);
```

- Put the item's own id in the prompt and in the schema, and merge on it.
- Send long lists in waves and `wait` each wave.
- `raiseErrors: false` keeps a failure in its slot; resend only the failed items.
- Results you only read, never compute on: `tool.task` (`help://task/batch`).
- Full signatures, handle methods and prelude APIs live in host-native topics: `help://eval/judge` (`completion`, `judge`, `judgeBatch`), `help://eval/helpers` (setup, `budget`, `@tool`), plus enabled preludes such as `help://eval/dsm` and `help://eval/ratchet`.
