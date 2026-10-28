---
tool: ast_grep
name: patterns
title: Pattern cookbook and languages
when: before writing a pattern for imports, calls on a receiver, arrows, JSON members, or a less common language
upstream: pi-coding-agent@18.13.2 src/tools/ast-grep.ts, src/prompts/tools/ast-grep.md, omp://tools/ast-grep.md § Inputs
---
# Pattern cookbook and languages

- Calls with any arguments: `console.log($$$)`. Any method on a receiver: `logger.$_($$$ARGS)`.
- Named imports: `import { $$$IMPORTS } from "react"`.
- Arrow constants: `const $NAME = ($$$ARGS) => $BODY`. Annotated TS functions: `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- JSON members: `"version": $V` works as a fragment.
- Each match is followed by `meta: NAME=value, …` with the captured metavariables — use it instead of re-reading.
- `$$$X` stops at the first node after which the rest of the pattern can match.
- `lang` forces one language for every file (use for ambiguous `.h` → `cpp`). Languages: astro, bash, c, cmake, cpp, csharp, dart, clojure, css, diff, dockerfile, emacs-lisp, elixir, erlang, fortran, go, graphql, haskell, hcl, html, ini, java, javascript, json, just, julia, kotlin, lua, make, markdown, nix, objc, ocaml, odin, php, powershell, protobuf, python, r, regex, ruby, rust, scala, solidity, sql, starlark, svelte, swift, toml, tlaplus, tsx, typescript, verilog, vue, xml, yaml, zig. Rarer grammars download on first use.
