---
name: read-subagent-transcript-before-reporting
description: "Read a subagent's transcript before telling the user what that subagent did or is doing"
condition: "(验收者|子代理|subagent|owner|reviewer|Owner|Acceptance|Review)[^\\n]{0,80}(在跑|正在|已通过|已经通过|跑完|完成|还没|写了|实现)"
question: "Does the reply say what a subagent did or is doing (its progress, rows passed, code written, current activity) based only on status lines, without quoting or citing that subagent's transcript or output read through history://<id> or agent://<id>?"
scope: "text"
---

Before you tell the user what a subagent did or is doing, read its actual work with `read history://<id>` (for a finished or running agent) or `agent://<id>`. Check the commands it ran, the files it changed, and whether its run matches the assignment. This matters most when the user challenges the subagent's work. The progress line from `wait` (`stage: …`, `~55%`) is the subagent's own label, not evidence. Report only what the transcript shows, cite it, and say plainly what you have not checked. If the transcript shows the subagent going off course (for example running e2e against code that does not exist), stop it first with `proc://<id>/kill`, then report.