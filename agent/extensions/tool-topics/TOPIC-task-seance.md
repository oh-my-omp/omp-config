---
tool: task
name: seance
title: Consulting a past session
when: 'before asking a historical session a question with `agent: "seance"`'
upstream: pi-coding-agent@18.13.2 src/task/seance.ts, src/prompts/tools/seance-task-guidance.md, omp://tools/task.md § Seance
---
# Consulting a past session

- Item shape: `{ agent: "seance", sourceSession: "<id-or-path>", task, solutionSpace, model? }`; `sourceSession` and `model` go on the item, never at the top level.
- `sourceSession`: a path (contains `/` or `\`, or ends `.jsonl`; relative to your cwd) or a session id / id prefix (case-insensitive). Ids are searched in your own artifact tree first (direct child transcripts), then the project's sessions. An ambiguous prefix fails; give more characters or the path.
- `model`: a selector or list of selectors. Omitted, the source's saved active-branch model is reused; when it has none or it is unavailable, `model` is required.
- The consult is read-only: it gets a copy of the transcript and only `read`, `grep`, `glob`; no workspace context files, skills, rules, extensions, MCP or messaging. `history://` inside it resolves only against the source's own artifact tree. The source session is never changed.
- Not combinable with `isolated`, plan mode, or a custom agent named `seance`.
- Preflight errors: source not found, invalid or empty session file, ambiguous selector, no usable model.
