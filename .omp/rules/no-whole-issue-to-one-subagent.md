---
name: no-whole-issue-to-one-subagent
description: "Never hand an entire large issue to a single subagent and then sit idle waiting for it"
condition: ["实现整个 issue", "只交付 https?://github\\.com/[^/]+/[^/]+/issues/\\d+", "核心代码由你亲自写"]
scope: "tool:task"
---

Do not dispatch a whole large issue (implementation, tests, e2e, PR, evidence) to one subagent and then just `wait`.

- Split the issue into concrete, bounded slices with clear acceptance per slice (e.g. module A, module B, docs, a specific e2e row group), each small enough to check when it returns.
- Keep ownership of the core yourself: settle the design and interfaces, read and verify each slice's diff and outputs as soon as it lands, integrate, and decide the next slice.
- While any subagent runs, do reachable work in parallel: read its `history://<id>`, steer it with `write agent://<id>`, review what it already produced, prepare the next slice, fix contracts. Never chain bare `wait` calls.
- Report progress only from what you verified (diffs, command output, transcripts), not from the subagent's self-reported status.