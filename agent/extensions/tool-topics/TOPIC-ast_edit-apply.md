---
tool: ast_edit
name: apply
title: Previewing, applying and failures
when: before resolving or rejecting an `ast_edit` proposal, or when it reported parse issues, overlaps or a stale preview
upstream: pi-coding-agent@18.13.2 src/tools/ast-edit.ts, src/tools/resolve.ts, omp://tools/ast-edit.md § Outputs, § Errors, § Notes
---
# Previewing, applying and failures

- The call itself only previews (`applied: false`): each replacement shows its first line before/after, cut at 120 characters. Check them before resolving.
- Apply: write a one-sentence reason to `xd://resolve`. It reruns the same rewrite on the current files; if the replacement or per-file counts differ from the preview it fails as stale instead of claiming success. Success: `Applied N replacements in M files.` with fresh `[path#TAG]` headers for later edits.
- Discard: write a reason to `xd://reject`. After a failed apply the proposal stays pending: fix and retry, or reject it.
- Rules are applied as a set, not in `ops` order; don't build cascades. Overlapping edits from different rules abort the apply ("Overlapping replacements detected"); the preview does not catch this.
- Files with syntax errors are skipped, not partly rewritten. Pattern compile failures become `parseErrors` while other rules continue; all rules failing is a zero-replacement result, not absence. A path with no supported source files is an error.
- Rewrites whose output still matches the pattern will match again next time: not idempotent.
- `paths`: files, directories, globs, `local://` targets; web and read-only URLs are refused. Up to 1000 files per target; `node_modules` only when the glob names it.
