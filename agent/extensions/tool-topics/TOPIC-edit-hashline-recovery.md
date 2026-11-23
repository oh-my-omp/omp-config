---
tool: edit
name: hashline-recovery
title: Recovering from a rejected hashline edit
when: (hashline mode) after an edit was rejected, reported no change, or landed only partly
upstream: pi-coding-agent@19.1.1 omp://tools/edit.md § Block anchors, § Limits and validation, § Output and side effects, § Common failures; src/edit/index.ts
hiddenFromIndex: true
inject:
  - id: edit-hashline-error
    tool: edit
    onError: true
---
# Recovering from a rejected hashline edit

- All sections are parsed and checked before anything is written; a syntax, anchor or no-op failure writes nothing. Writes then land in order, so an OS write failure can leave earlier files changed: re-read before resending.
- The error names its `details.errorKind` class. Fix by class:
  - `missing_tag` / `header_only` (no tag, bare `[file#]`, `#AUTO`, `#????`, header without ops): copy the current tag the reply gives.
  - `stale_tag` / `unknown_tag` / `other_file_tag`: the file changed or the tag belongs elsewhere. Use the header and context the reply returns, or re-read. A stale tag is recovered automatically only when the change is provably safe.
  - `unseen_lines`: you anchored lines you never saw (elided `…`, collapsed ranges, outside the read window, column-cut long lines). Rows shown in the mismatch reply count as seen; read the rest first. When no snapshot is retained (new process or evicted snapshot), only anchors on lines longer than `min(512, tools.outputMaxColumns)` are rejected.
  - `out_of_range` / `ambiguous_boundary`, overlapping or reversed ranges: recompute against the original snapshot numbering; conflicting overlaps fail while exact repeated replacement ranges coalesce to the later body with a warning — author one final-content hunk per range.
  - `no_change`: the body equals the file. A third identical no-op in a row is an error; in a multi-section call any no-op section rejects the batch.
  - `parse`: a stray unified-diff line (`@@`, `-old`), a body under `CUT`/`REM`/`MV` or a register paste, or an empty body under `PUT …:`.
  - Other failure classes: `file_not_found`, `no_match`, `invalid_utf8`, `plan_mode`, `unresolved_url`, `io`, `write_failed`, `apply`.
- A block op (`N*`) on a single-line node, a closer or an inner statement fails; use an explicit range. In Rust, anchoring the first outer attribute (`#[...]`) or outer doc comment (`///`, `/** */`) of an item resolves through the item; a later attribute/doc comment or orphan one is rejected. `PUT >N*:` that finds no block degrades to `PUT >N:` with a warning.
- An edit that breaks the file's syntax is applied anyway with a warning (or an additional repair note when `edit.autoRepair.enabled` repairs it): re-read and verify the region.
- Generated files (protoc, sqlc, swagger output …) are refused. FIFOs, sockets and devices are refused. Line selectors are not edit targets.
