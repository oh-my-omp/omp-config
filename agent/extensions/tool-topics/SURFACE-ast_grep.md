---
tool: ast_grep
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-grep.md, omp://tools/ast-grep.md
---
Finds code by syntax shape (calls with their arguments, declarations, imports, multi-line constructs) where `grep` would need fragile regex. Literals and plain text stay `grep`.
