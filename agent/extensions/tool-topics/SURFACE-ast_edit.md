---
tool: ast_edit
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-edit.md, omp://tools/ast-edit.md
---
Rewrites code by syntax shape: the same structural change at several sites or files. Give `paths` as code globs (`src/**/*.ts`). Previews first; applies on `xd://resolve`. One-off edits stay `edit`.
