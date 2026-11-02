---
tool: ast_grep
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-grep.md, omp://tools/ast-grep.md
---
Finds code by syntax shape (calls with their arguments, declarations, imports) where `grep` needs fragile regex; a bare string with no shape constraint stays `grep`. Path: a code glob (`src/**/*.ts`).
