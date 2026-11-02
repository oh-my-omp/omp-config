---
tool: ast_edit
name: patterns
title: Writing rewrite ops
when: before writing `ops` or choosing `paths`, or when a rewrite matched nothing, fewer sites than expected, or reported parse issues
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-edit.md, omp://tools/ast-edit.md § Inputs, § Notes
---
# Writing rewrite ops

- Each op is `{ "pat": …, "out": … }`. `pat` matches AST structure, not text, and must parse as a single node; wrap a fragment that is not standalone: `class $_ { … }`.
- Metavariables: `$NAME` one node, `$_` one node unbound, `$$$NAME` zero or more. `$$NAME` is invalid. Names are UPPERCASE and stand for a whole node: `prefix$VAR` fails. The same metavariable twice must match identical code: `$A == $A` matches `x == x`, not `x == y`.
- Captures from `pat` (`$A`, `$$$ARGS`) substitute into `out` one to one: no splitting or merging captures.
- A member chain in `pat` is matched whole from its leftmost name: `pi.logger.warn($A)` does not rewrite `monitor.pi.logger.warn(x)`. To cover any receiver, capture it: `{"pat":"$R.logger.warn($A)","out":"$R.logger.warn($A, {})"}`.
- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- Delete with an empty `out`: `{"pat":"console.log($$$)","out":""}`.
- `paths` must select only code files: give globs such as `src/**/*.ts`. Every file under a bare directory is parsed in its own language, and Markdown paragraphs can match a code pattern: `pi.logger.warn($A)` → `pi.logger.warn($A, {})` over a directory with `.md` files staged whole prose paragraphs replaced by `pi.logger.warn(, {})`. Check every staged file before resolving; reject a proposal that touches a file you did not mean.
- Parse issues mean a malformed rewrite, not a clean no-op.
