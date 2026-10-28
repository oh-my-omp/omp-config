---
tool: ask
name: answers
title: Reading the user's answers
when: before acting on an `ask` result that has notes, images, a custom answer, no selection, or a chat redirect
upstream: pi-coding-agent@18.13.2 src/tools/ask.ts, pi-tui src/overlays/ask-dialog.ts, omp://tools/ask.md § Modes / Variants, § Outputs
---
# Reading the user's answers

- One question: `User selected: …`, `User provided custom input: …`, `User added note [on <option>]: …` — several can appear together; a user may pick options and type their own answer too.
- Several questions: `User answers:` then one line per id (`id: [a, b]`, custom answers quoted, `+` joins choices and custom text, `(note …)` appended). `details.results[]` has `selectedOptions`, `customInput`, `note`, `noteOption` per id.
- `User did not select any options` (or `id: []`) is a real answer: the user chose none. `id: (cancelled)` means that question was left unanswered.
- `User chose to chat about this instead of answering.` is not a choice: discuss the questions with the user before deciding.
- Answers may carry pasted images, shown as `[Image #N, WxH]` and readable as `attachment://N` (with `?q=<question>` for a vision answer).
- Cancelling the dialog aborts the tool call (`Ask tool was cancelled by the user`): stop and wait for the user instead of re-asking.
- `Error: question ids must be unique` / `option labels must be unique` are your input errors, not answers.
