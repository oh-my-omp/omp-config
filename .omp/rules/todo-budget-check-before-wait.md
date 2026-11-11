---
name: todo-budget-check-before-wait
description: "Before blocking on a wait, check the active todo item's time budget and act on overtime instead of waiting blindly"
condition: "\"i\"\\s*:\\s*\"Waiting for"
scope: "tool:wait"
---

Todo time budgets are binding signals, not decoration. Before a `wait` call:

- Check the active todo item's elapsed time against its estimate.
- **Over budget:** stop the bare wait. Say what caused the overrun, reconsider the approach, then run `ESTIMATE "<title>" <minutes>` with an honest new budget. Do this once per overrun.
- **Waiting on a subagent or an external service:** `BLOCK` the item with a reason so its clock pauses. `UNBLOCK` it when the result arrives.
- **Side work that is not the active item** (rewriting other issues, contract edits): put it in its own todo item, `START` it, and give it its own estimate. Do not let it run on the active item's clock.
- **Back-to-back waits:** never chain them without updating the todo first.