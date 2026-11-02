---
tool: ast_edit
name: patterns
title: Writing rewrite ops
when: before writing `ops`, or when a rewrite matched nothing or reported parse issues
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-edit.md, omp://tools/ast-edit.md § Inputs, § Notes
---
# Writing rewrite ops

- Each op is `{ "pat": …, "out": … }`. `pat` matches AST structure, not text, and must parse as a single node; wrap a fragment that is not standalone: `class $_ { … }`.
- Metavariables: `$NAME` one node, `$_` one node unbound, `$$$NAME` zero or more. `$$NAME` is invalid. Names are UPPERCASE and stand for a whole node: `prefix$VAR` fails. The same metavariable twice must match identical code: `$A == $A` matches `x == x`, not `x == y`.
- Captures from `pat` (`$A`, `$$$ARGS`) substitute into `out` one to one: no splitting or merging captures.
- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- Delete with an empty `out`: `{"pat":"console.log($$$)","out":""}`.
- Mixed-language `paths` are fine: each file is parsed in its own language, and a pattern only rewrites files it parses in.
- Parse issues mean a malformed rewrite, not a clean no-op.
