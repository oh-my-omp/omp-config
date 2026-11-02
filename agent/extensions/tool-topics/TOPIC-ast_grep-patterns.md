---
tool: ast_grep
name: patterns
title: Writing a pattern
when: before writing `pat`, or when a pattern matched nothing or reported parse issues
upstream: pi-coding-agent@18.15.0 src/prompts/tools/ast-grep.md, omp://tools/ast-grep.md § Notes
---
# Writing a pattern

- `pat` is ONE AST pattern and must parse as a single node of the target language; unrelated patterns go in separate calls. Wrap a fragment that is not standalone: `class $_ { … }`.
- Metavariables: `$NAME` one node, bound; `$_` one node, unbound; `$$$NAME` zero or more, bound; `$$$` zero or more, unbound. `$$NAME` is invalid. Names are UPPERCASE and stand for a whole node: `prefix$VAR` fails.
- The same metavariable twice must match identical code: `$A == $A` matches `x == x`, not `x == y`.
- Each match lists its bindings on a `meta:` line.
- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- C++ expression-statement calls need a trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`.
- Declaration forms are distinct — `function foo`, method `foo()`, `const foo = () => {}`; search each form before concluding absence.
- Loosest existence check: a bare identifier such as `pat: "executeBash"` with a narrow `path`.
- Parse issues mean the query failed, not that nothing exists: fix the pattern or tighten `path`/`lang` before concluding "no matches".
