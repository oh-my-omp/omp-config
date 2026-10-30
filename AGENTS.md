# Repository Guidelines

`omp-config` holds the reviewable inputs of the user's Oh My Pi (`omp`)
configuration: harness config, prompt templates, subagent definitions, local
extensions, the plugin list, and the tooling that moves them between this repo
and a machine's `~/.omp/agent` (plus `~/.pi/agent`). Runtime state, credentials
and installed plugins never enter the repo.

Behavior is described where it lives; read the matching one before changing it:

|What|Where|
|---|---|
|Design, prompts, subagents, extensions, plugins, sync and maintenance|`README.md`, `docs/*.md`|
|One extension's events, tools, files and failure policy|header comment of its `index.ts`|
|What repo → machine writes, deletes and never touches|header of `agent/extensions/omp-config-autoupdate/omp-config-update.ts`|
|Slash-command contracts (`/update-omp`, `/sync-omp-config`, `/migrate-omp-keys`)|`.omp/commands/*.md`|
|Subagent authoring traps|`agent/agents/README.txt`|
|Extension load order|`agent/extensions-last/README.md`|
|Configuration check (CI)|`ci/README.md`|
|Sandbox for real sessions with this machine's config and credentials|`sandbox/README.md`|

## Rules

- **Two one-way directions.** Repo → machine is the updater (`/update-omp`
  applies the working tree; the opt-in startup auto-update applies GitHub
  `main`). Machine → repo is `/sync-omp-config`, which never writes the
  machine. Adding or removing a managed file or `omomp.yml` section changes the
  updater's `managedPlain` / `STRUCTURED`, `.omp/commands/sync-omp-config.md`
  and the docs pages together.
- **Updater compatibility.** Older machines import `applySnapshot(options)` from
  the fetched clone at `agent/extensions/omp-config-autoupdate/omp-config-update.ts`;
  keep both the signature and the path compatible.
- **Machine-owned state stays on the machine:** host-only files and keys,
  `LOCAL_CONFIG_FIELDS` of `config.yml`, machine entries of `config.yml`
  `extensions`, and the machine-local `omomp.yml` sections (`doc-polish`,
  `model-compaction`, `omp-config-autoupdate`).
- **App-managed files** (`// @orca-managed-pi-extension` or `marker: _otty`)
  are never overwritten; the marker, not the filename, decides. Never write the
  contiguous Otty marker literal in the updater: it would skip updating itself.
- **Never commit** runtime state or anything credential-bearing (databases,
  locks, sessions, caches, logs, `models.yml`, `commandcode-models.json`,
  `node_modules/`, `bun.lock`), including files `.gitignore` misses.
- **Load order.** `extensions-last/system-prompt-replace/index.ts` stays the
  last `config.yml` `extensions` entry and outside `extensions/`. Order inside
  `extensions/` is unspecified, so filename prefixes cannot order hooks.
- **Subagents.** Model bindings live only in `config.yml`
  `task.agentModelOverrides`; agent `.md` files carry no `model` field.
  Non-agent notes in `agent/agents/` are `.txt`, because every `.md` there is
  parsed as an agent.
- **Docs.** `README.md` and each `docs/<topic>.md` have a `*.zh-CN.md` twin
  with aligned sections, tables and anchors; change both. A behavior change
  updates the page or header that describes it. This file carries rules only,
  never a description of what the code does.
- **After an OMP upgrade**, follow `docs/operations.md#upgrade-and-maintenance-notes`.

## Code conventions

Extensions live in `agent/extensions/<name>/` (`extensions-last/` for the
last-loaded one). `bun run check` enforces format, lint and types; the rest is
review.

- **Layout:** one kebab-case directory per extension, named after its id.
  `index.ts` starts with a header comment (behavior; events, tools and commands
  registered; files read and written; main or sub scope; failure policy) and
  default-exports a camelCase factory named after the directory. Other `*.ts`
  files are its private modules, one level deep; no `.ts` sits directly under
  `extensions/` or `extensions-last/`. Export only the default unless a sibling
  imports a name; no test seams. The updater script is the exception: its
  exports are a contract.
- **Sharing:** no cross-extension imports. Code used by two or more extensions
  lives in `_shared/`, imported by relative path with `.ts`. `_shared` holds
  mechanics; retries, timeouts, wording and failure-to-null rules stay in the
  caller.
- **Config and files:** settings are `omomp.yml` sections
  (`defineOmompSection` / `loadOmompSection` / `writeOmompSection`). Files an
  extension owns sit beside it and are read via `import.meta.dir`, never via
  `getAgentDir()`.
- **Models:** an extension that picks its own model uses the OMP role
  `@<extension>` through `roleModels`, with an optional `fallbackRole` in its
  section, and lists the role in `config.yml` `modelTags`. Judgments go through
  `openJudge`; extensions add no LLM fallback of their own. One-shot calls use
  `runHelperPrompt`; any other `createAgentSession` passes `taskDepth: 1`, or
  its `dispose()` releases every idle subagent.
- **Types:** strict, `noUncheckedIndexedAccess`, no `any`. Parse external input
  (files, tool parameters, session entries, `unknown` payloads, child output)
  once at the boundary with `z` from `@oh-my-pi/pi-coding-agent` or a type
  guard. `as` only for host types no runtime check can verify, with a one-line
  reason.
- **State:** variants are a discriminated union on `kind` with an exhaustive
  `switch` and a `never` arm; booleans never encode exclusive states.
- **Errors:** expected failures are result unions. Hooks and tools never throw
  into omp: catch at the boundary and
  `pi.logger.warn(message, { error: errorText(error) })`. An empty `catch {}`
  names the expected failure in a comment.
- **Session facts:** main vs sub is `ctx.agent.kind`. Every
  `pi.sendUserMessage` an extension sends on its own behalf passes
  `attribution: "agent"`. Only `context` fires on every model call (IRC wakes
  included); `before_agent_start` does not.
- **Imports:** host package roots (`pi-agent-core`, `pi-ai`, `pi-catalog`,
  `pi-coding-agent`, `pi-natives`, `pi-tui`, `pi-utils`), Node/Bun built-ins
  and relative paths. A host subpath is used only if an extension already loads
  it in a real omp session: `tsc` resolves from `node_modules/` and passes
  subpaths the omp binary does not map. Native bindings load only after a
  platform guard.
- **Code copied from OMP** is wrapped in
  `// @upstream <verbatim|adapted> <package>@<version> <src path>#<symbol>` …
  `// @upstream-end` and re-compared after OMP upgrades.
- **Size and format:** a function over ~150 lines is split into named
  module-level functions. Format with `bun run format` only.

## Commands

```bash
bun install          # dev dependencies (types only; runtime uses the copies inside omp)
bun run check        # biome check . && tsc --noEmit
bun run test         # bun test ci
bun run format       # biome check --write .
bun ci/check.ts      # configuration check in a throwaway HOME (exit 0 clean, 1 diagnostics, 2 free model unavailable)
./plugin-audit.sh    # install-plugins.sh vs `omp plugin list`
```

Slash commands: `README.md#commands`.

## Validating a change

1. `bun run check` and `bun run test` pass; every changed YAML/JSON parses
   (`Bun.YAML.parse` / `JSON.parse`).
2. Extension, prompt or tool-topic changes: apply with `/update-omp`, restart
   `omp`, trigger the changed path in a real session and observe its output and
   side effects. When each item takes effect is in the ownership table of
   `docs/operations.md`.
3. `omp config list --json`, `omp plugin list --json`, `git status --short`.

Without runtime verification, say so; a clean parse or `cmp` is not proof.
