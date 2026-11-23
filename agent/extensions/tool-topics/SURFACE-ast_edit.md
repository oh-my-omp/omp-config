---
tool: ast_edit
upstream: pi-coding-agent@19.1.1 src/prompts/tools/ast-edit.md, src/tools/resolve.ts, src/tools/index.ts, omp://tools/ast-edit.md
---
Rewrites code by syntax shape: the same structural change at several sites or files. Give `paths` as code globs (`src/**/*.ts`). Previews first; finalize with `resolve`/`reject` (bash commands when `bash` and `tools.commands` are active, top-level tools otherwise). One-off edits stay `edit`.
