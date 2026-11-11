---
name: no-todo-block
description: "Never BLOCK todo items or phases; keep the current item active and later items pending"
condition: ["BLOCK (PHASE )?\\\\", "(?:^|\\n)BLOCK (PHASE )?\""]
scope: ["tool:_todo", "tool:todo"]
---

Do not use `BLOCK` in todo documents, either on single items or on whole phases. The user forbids blocking anything.

- A serial gate is not a blocker. Items that come later stay `pending`, and the item you are working on stays `in_progress`.
- Waiting on a subagent is not a blocker either. Keep the current item active and do the work you can reach: read the subagent's `history://<id>`, steer it, verify its results, prepare the next brief, and fix issue contracts.
- When the todo pointer auto-advances to the wrong item, `START` the item you are actually working on. Do not block the other items to stop it.
- When an item runs over budget, say why and set an honest new budget with `ESTIMATE`. Do not freeze its clock with `BLOCK`.