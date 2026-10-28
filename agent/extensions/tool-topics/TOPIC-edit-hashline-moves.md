---
tool: edit
name: hashline-moves
title: Moving code, files and registers
when: (hashline mode) before moving code between places or files, renaming or deleting a file with `edit`
upstream: pi-coding-agent@18.13.2 omp://tools/edit.md § Canonical patch language, § Output and side effects; src/edit/index.ts
---
# Moving code, files and registers

- One call may hold sections for several files; operations run top to bottom across sections, so a `CUT` in one file can feed a `PUT` in a later section.
- Anonymous register: starts empty in every call, holds the last unambiguous `CUT`; paste it with a bodyless `PUT <N`, `PUT >N`, `PUT >$` or `PUT >N*`.
- Named register (`@name`, letters/digits/`_`/`-`): `CUT N.=M @name`, then `PUT <N @name`, `PUT >N @name`, `PUT >$ @name`, or over a range/block `PUT N.=M @name` / `PUT N* @name` (the name is required there). Named registers persist for the session across calls and are published only once their writes land; pasting does not consume them.
- `REM`: delete the section's file (no body). `MV DEST`: after the section's edits, write the result to `DEST` and delete the source; quote destinations with spaces. Missing parent directories are created; an existing `DEST` is overwritten, so choose it deliberately.
- Several sections for the same path merge against the original numbering; register operations that would become ambiguous through that interleaving are rejected.
- File-backed internal URLs (`local://…`) are editable; `agent://`, `proc://` and read-only schemes are not (use `write`).
