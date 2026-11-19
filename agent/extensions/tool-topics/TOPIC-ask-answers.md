---
tool: ask
name: answers
title: Reading the user's answers
when: before acting on an `ask` result that was submitted on a timeout, carries option notes, or leaves a field unanswered
upstream: pi-coding-agent@18.22.0 src/tools/ask.ts, src/prompts/tools/ask-result.md, pi-tui src/html-form/data.ts, omp://tools/ask.md § Outputs
---
# Reading the user's answers

- Submit: `User answers:` then the submitted form data as JSON, keyed by each control's `name` (`{ "store": "sqlite" }`); a multiple choice (checkboxes sharing one name, or `<select multiple>`) gives an array.
- Timeout: the first line is `No answer before the timeout; submitted the form's current values:` instead — those are the values the form opened with (`checked`/`selected`/`value`), not the user's answer; `details.timedOut` is `true`.
- Option notes: notes on chosen options follow the JSON under `Option notes:`, one per line as `- <question>: <option> [<name>=<value>] — <text>`.
- `details.answers[]`: one `{ name, question, answer }` per named control in form order; `answer` is the option's shown label (a multi-select joins labels with `, `), and an empty string for a field that submitted no value. `notes` and `timedOut` appear only when they exist.
- A user cancel aborts the tool call (`Ask tool was cancelled by the user`): stop and wait for the user instead of re-asking.
- A form with no named control returns an error result, `Error: the form has no named controls.` followed by which controls to add — your input error, not an answer.
