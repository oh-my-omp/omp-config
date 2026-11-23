---
tool: ast_edit
name: apply
title: Previewing, applying and failures
when: before resolving or rejecting an `ast_edit` proposal, or when it reported parse issues, overlaps or a stale preview
upstream: pi-coding-agent@19.1.1 src/tools/ast-edit.ts, src/tools/resolve.ts, src/tools/index.ts, src/prompts/tools/lsp.md, omp://tools/ast-edit.md § Outputs, § Errors, § Notes
hiddenFromIndex: true
inject:
  - id: ast-edit-apply-error
    tool: ast_edit
    onError: true
  - id: ast-edit-apply-preview
    tool: ast_edit
    resultPattern: '(?:Staged as a proposal|Parse issues(?:\s*\(\d+\s*\/\s*\d+\))?:|Limit reached; narrow paths\.)'
---
# Previewing, applying and failures

- The call itself only previews (starting with `Staged as a proposal — files NOT modified yet`): each replacement shows its first line before/after, cut at 120 characters. Check them before resolving.
- Apply: invoke `resolve <one-sentence reason>` as a bash command when `bash` is active and `tools.commands` is on, or call the top-level `resolve` tool otherwise. It reruns the same rewrite on the current files; if the replacement or per-file counts differ from the preview it fails as stale instead of claiming success. Success: `Applied N replacements in M files.` with fresh `[path#TAG]` headers for later edits.
- Discard: invoke `reject <reason>` (as a bash command or top-level `reject` tool, matching `resolve`). After a failed apply the proposal stays pending: fix and retry, or reject it.
- Rules are applied as a set, not in `ops` order; don't build cascades. Overlapping edits from different rules abort the apply ("Overlapping replacements detected"); the preview does not catch this.
- Files with syntax errors are skipped, not partly rewritten. Pattern compile failures render under `Parse issues:` while other rules continue; all rules failing is a zero-replacement result, not absence. A path with no supported source files is an error.
- Rewrites whose output still matches the pattern will match again next time: not idempotent.
- `paths`: files, directories, globs, `local://` targets; web and read-only URLs are refused. Up to 1000 files per target by default (configurable via `PI_MAX_AST_FILES`); `node_modules` only when the glob names it.
- When `lsp` is enabled and a server is available, use `lsp` `rename`/`rename_file` rather than `ast_edit` for cross-file symbol renames (`lsp` is disabled in this setup's `config.yml`).
