# Repository Guidelines

`omp-config` holds the reviewable inputs of the user's Oh My Pi (`omp`)
configuration: harness config, prompt templates, subagent definitions, local
extensions, the plugin list, and the tooling that moves them between this repo
and a machine's `~/.omp/agent`. Runtime state, plugin state, credentials and
installed plugins never enter the repo.

Behavior is described where it lives; read the matching one before changing it:

|What|Where|
|---|---|
|Design, prompts, subagents, extensions, plugins, sync and maintenance|`README.md`, `docs/*.md`|
|One extension's events, tools, files and failure policy|its code under `agent/extensions/<name>/`|
|What repo → machine writes, deletes and never touches|`agent/extensions/omp-config-autoupdate/omp-config-update.ts`|
|Slash-command contracts (`/onboard-omp`, `/update-omp`, `/sync-omp-config`, `/migrate-omp-keys`)|`.omp/commands/*.md`|
|Subagent authoring traps|`agent/agents/README.txt`|
|Extension load order|`agent/extensions-last/README.md`|
|Configuration check (CI)|`ci/README.md`|
|Sandbox for real sessions with this machine's config and credentials|`sandbox/README.md`|

## Rules

- **Two one-way directions.** Repo → machine is the updater (`/update-omp`
  applies the working tree; the opt-in startup auto-update applies GitHub
  `release`). Machine → repo is `/sync-omp-config`, which never writes the
  machine. Adding or removing a managed file or an `omp.settings` key, or
  moving a path between the updater's owner lists, changes the updater's
  `managedPlain` / `STRUCTURED` / `LOCAL_*` / `SEED_*` or the manifest
  `agent/extensions/_shared/package.json`,
  `.omp/commands/sync-omp-config.md` and the docs pages together.
- **Updater compatibility.** Older machines import `applySnapshot(options)` from
  the fetched clone at `agent/extensions/omp-config-autoupdate/omp-config-update.ts`;
  keep both the signature and the path compatible, and only add report fields.
- **Machine customizations survive updates.** Outside code (`*.ts`), the
  updater never overwrites a managed item the machine changed since its base:
  it merges or reports a conflict for adaptation. Keep that invariant.
- **Machine-owned state stays on the machine:** host-only files and keys, the
  updater's `LOCAL_*` and `SEED_*` paths, machine entries of `config.yml`
  `extensions`, the base record `.omp-config-base/`, and plugin state under
  `~/.omp`.
- **App-managed files** (`// @orca-managed-pi-extension` or `marker: _otty`)
  are never overwritten; the marker, not the filename, decides. Never write the
  contiguous Otty marker literal in the updater: it would skip updating itself.
- **Never commit** runtime state or anything credential-bearing (databases,
  locks, sessions, caches, logs, `models.yml`, `node_modules/`),
  including files `.gitignore` misses. `bun.lock` is committed: the
  `omomp-check` workflow installs with `bun install --frozen-lockfile`.
- **Load order.** `extensions-last/system-prompt-replace/index.ts` stays the
  last `config.yml` `extensions` entry and outside `extensions/`. Order inside
  `extensions/` is unspecified, so filename prefixes cannot order hooks.
- **Prompt ownership.** Wording of this repository's prompt input files
  (`SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM*.md`) is changed in
  those files; `system-prompt-replace` rules match only text OMP owns. Only
  `tool-topics` and `system-prompt-replace` rewrite the system prompt OMP
  builds, as the `systemPrompt` of their `before_agent_start` result; no other
  extension returns `systemPrompt`, and no hook edits tool definitions or
  changes the system prompt in `before_provider_request`. A `registerTool`
  under a built-in tool's name only takes over that whole tool. Every other
  customization reaches the model as the extension's delta stream from
  `_shared/omomp-shared/context-delta.ts`.
- **Subagents.** Model bindings live only in `config.yml`
  `task.agentModelOverrides`; agent `.md` files carry no `model` field.
  Non-agent notes in `agent/agents/` are `.txt`, because every `.md` there is
  parsed as an agent.
- **Commits and releases.** Commit with lgit: `git add`, then
  `uvx --from lgit-cli lgit`. Its entries go under `## [Unreleased]` of the
  repo-root `CHANGELOG.md`, which covers every file of the repo, including
  `install-plugins.sh`. A PR never changes the version in
  `agent/extensions/_shared/package.json` and never adds a version section;
  the release workflow does both.
- **Docs.** `README.md` and each `docs/<topic>.md` have a `*.zh-CN.md` twin
  with aligned sections, tables and anchors; change both. A behavior change
  updates the page that describes it. Docs and commands never state
  how many items a set has (extensions, plugins, subagents, files, options,
  categories); name the items or point to the file that lists them. This file
  carries rules only, never a description of what the code does.
- **After an OMP upgrade**, follow `docs/operations.md#upgrade-and-maintenance-notes`.

## Code conventions

Extensions live in `agent/extensions/<name>/` (`extensions-last/` for the
last-loaded one). `bun run check` enforces format, lint and types; the rest is
review.

- **Layout:** one kebab-case directory per extension, named after its id.
  `index.ts` default-exports a camelCase factory named after the directory. Other `*.ts`
  files are its private modules, one level deep; no `.ts` sits directly under
  `extensions/` or `extensions-last/`. Export only the default unless a sibling
  imports a name; no test seams. The updater script is the exception: its
  exports are a contract.
- **Sharing:** no cross-extension imports. Code used by two or more extensions
  lives in `_shared/`, imported by relative path with `.ts`. `_shared` holds
  mechanics; retries, timeouts, wording and failure-to-null rules stay in the
  caller. `_shared/omomp-shared/` holds the byte-identical copies of
  `oh-my-omp/shared` files declared in `omomp-shared.json`; they are never
  edited here (change them in shared; a sync PR refreshes the copies) and are
  imported like any other `_shared` module.
- **Config and files:** an extension's settings are `<extension>.<key>` keys
  of the `omp-config` plugin manifest (`_shared/package.json`), read through
  `_shared/plugin-settings.ts` (`defineSettings` / `readSettings` /
  `writeSetting`). List data that describes another object lives with that
  object: an agent's flags in its frontmatter, a topic's `inject` rules in the
  `TOPIC-*.md` frontmatter, a rules file of its own (`model-compaction.json`). Files
  an extension owns sit beside it and are read via `import.meta.dir`, never
  via `getAgentDir()`.
- **Models:** an extension that picks its own model uses the OMP role
  `@<extension>` through `roleModels` and lists the role in `config.yml`
  `modelTags`; an unbound role falls back to the host `default` role chain —
  no `fallbackRole`. Judgments that return only answer probabilities go
  through `openJudge`; a verdict that must carry a written reason back to
  the agent (`task-completion-judge`, `task-split-check`) is a completion
  over `roleModels`. Extensions add no other LLM fallback of their own.
  One-shot calls use `runHelperPrompt`; any other `createAgentSession`
  passes `taskDepth: 1`, or its `dispose()` releases every idle subagent.
- **Types:** strict, `noUncheckedIndexedAccess`, no `any`. Parse external input
  (files, tool parameters, session entries, `unknown` payloads, child output)
  once at the boundary with `z` from `@oh-my-pi/pi-coding-agent` or a type
  guard. `as` only for host types no runtime check can verify.
- **State:** variants are a discriminated union on `kind` with an exhaustive
  `switch` and a `never` arm; booleans never encode exclusive states.
- **Errors:** expected failures are result unions. Hooks and tools never throw
  into omp: catch at the boundary and
  `pi.logger.warn(message, { error: errorText(error) })`.
- **Session facts:** main vs sub is `ctx.agent.kind`. Every
  `pi.sendUserMessage` an extension sends on its own behalf passes
  `attribution: "agent"`. Only `context` fires on every model call (IRC wakes
  included); `before_agent_start` does not.
- **Tool registration:** tools register in the factory before any `await`.
  A tool that serves only some sessions registers
  `defaultInactive` and is activated on `session_start` / `session_switch`,
  never in `before_agent_start`. Every active-set change goes through
  `_shared/omomp-shared/active-tools.ts`, which lists tools in canonical order: built-in tools in registry order first, all others sorted by name.
- **Imports:** a value import (`import`, `export … from`, a dynamic
  `import()` with a literal specifier) names a Node/Bun built-in, a relative
  path, or a key of the omp binary's module table, the set the installed
  host's `collectBundledPiEntries()` returns; `bun run check` fails on any
  other. `tsc` resolves from `node_modules/` and passes specifiers the binary
  cannot load. An `import type` may name any type of a host dependency
  (`@babel/types` for omp's Babel parser, `@oh-my-pi/pi-wire`): it is erased
  before omp loads the module. Native bindings load only after a platform
  guard.
- **Code copied from OMP:** what the host exports under a module-table key is
  imported, never copied; only host code the binary cannot load is copied.
  A copy is wrapped in
  `// @upstream <verbatim|adapted> <package>@<version> <src path>#<symbol>` …
  `// @upstream-end`, where `<version>` is the host release it was last
  compared against; an `adapted` copy states on the line after the marker
  what differs from the host and why. Copies are re-compared after OMP
  upgrades.
- **Comments** are warnings only: what must not be done and what breaks if it
  is. No descriptions of behavior or design rationale. `@upstream` markers
  are not comments under this rule.
- **Size and format:** a function over ~150 lines is split into named
  module-level functions. Format with `bun run format` only.

## Commands

```bash
bun install          # dev dependencies (types only; runtime uses the copies inside omp)
bun run check        # biome check . && tsc --noEmit && bun ci/host-imports.ts
bun run test         # bun test --isolate ci
bun run format       # biome check --write .
bun ci/check.ts      # configuration check in a throwaway HOME (exit 0 clean, 1 diagnostics, 2 free model unavailable)
./plugin-audit.sh    # install-plugins.sh vs `omp plugin list`
```

Slash commands: `README.md#commands`.

## Validating a change

1. `bun run check` and `bun run test` pass; every changed YAML/JSON parses
   (`Bun.YAML.parse` / `JSON.parse`).
2. Extension, prompt or tool-topic changes are verified in the OrbStack
   sandbox (`sandbox/README.md`), never on this machine's `~/.omp`: start
   `bun sandbox/sandbox.ts hold` in a `bash` (`pty: true`) terminal, prepare the
   workspace under `/work` with `docker exec` before omp starts, then drive
   `docker exec -it -w /work omp-sandbox-<run> omp --model …` through
   `bash` (`pty: true`), trigger the changed path and observe its output and side
   effects. Quit omp and stop the holder with Ctrl-C.
3. Inside the sandbox: `omp config list --json`, `omp plugin list --json`;
   on the host: `git status --short`.

Without runtime verification, say so; a clean parse or `cmp` is not proof.
