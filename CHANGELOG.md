# Changelog

## [Unreleased]

### Added

- Added a one-time TUI warning if the task-result guard failed to initialize

### Changed

- Updated `_shared/omomp-shared/compact-handoff.ts` (`COMPACT_HANDOFF_REVISION = 3`), `ci/compact-handoff.test.ts` and `docs/prompts-and-context` to the prefix-fact compaction prompt (`User Intent & Session Rulings`, `Decisions & Domain Dead Ends`, `Code Anchors & Verified Invocations`, `Landed Milestones & Executed Verifications`), host cut-boundary and live-handle exclusions, empty-state `inactiveClaim` support and live `delta-stream` evaluation at `before_agent_start` ([#484](https://github.com/oh-my-omp/omp-config/issues/484))

### Fixed

- Prevented non-snapshot task results from crashing the OMP TUI during replay, plain-terminal `/rewind` and `/copy` selectors, live updates, pending result handling, and Hub parsing by activating the guard before the first render in full and light modes
- Preserved valid task snapshots, interrupt-skipped details, and stored transcripts while keeping synthetic stop events available for auto-retry to clear their failure cards

## [1.5.0] - 2026-11-27

### Added

- Added daily failure tracking to the `omomp-check` workflow: a scheduled run, or a `workflow_dispatch` run with `report_issue` set, keeps one issue in this repository marked `<!-- omomp-upstream-check:v1:repo -->` through `oh-my-omp/shared`'s `report.ts`, opening it on a failure, updating it when the failure changes and closing it on the next passing run; push and pull-request runs only write the step summary and touch no issue

### Changed

- Changed watchdog observers to end their reply with a last line `STATUS: done`, `STATUS: nothing` or `STATUS: failed — <reason>`: only `done` and `nothing` advance the cursor, while `failed` (logged as `observer failed`) and a reply without a `STATUS` line keep the window for the next run, so a window whose `intent` command failed is no longer skipped
- Changed observer runs to refuse a `bash` command that already failed in the same run when it is issued again unchanged, because a failed write such as `intent decide` may still have landed; this stops one run from writing the same decision twice. The comparison ignores the observer's `env` export lines, and the `env` hook no longer prefixes a command that already starts with them, so a model copying the rewritten command neither doubles the lines nor slips past the refusal
- Changed the `omomp-check` workflow to run `oh-my-omp/shared`'s `deps.ts gate` as its Gate stage: production files under `agent/extensions/` and `agent/extensions-last/` fail on an `@oh-my-pi/*` import the omp binary cannot load, a named value the module it runs does not export, an import of another extension's directory, or a chained cast without `// SAFETY: <reason>`; `bun run check` no longer runs `ci/host-imports.ts`, which is removed, and the workflow checks out the `oh-my-omp/shared` branch with the name of the pull request's base branch (of the run's own branch outside pull requests) when shared has one, otherwise `main`
- Changed `omp-playbooks` from a required plugin to a commented-out optional entry of `install-plugins.sh`, and declared `omp-dispatch` the same way beside `omp-remote-build`: onboarding and `/update-omp` no longer install any of them on a new machine, while a machine that already has one keeps it and the updater still refreshes it

### Fixed

- Fixed watchdog observers being aborted when the session shuts down: a running observer now finishes while process exit waits for it (at most its 300 s), with `watchdog "<name>": waiting for the observer to finish` on the terminal, instead of being cut off and logged as `observer timed out`
- Fixed the observer log to tell a cancel from a timeout: a run canceled by compaction or a session switch logs `observer canceled (<cause>)`, and `observer timed out` is kept for the 300 s deadline
- Fixed `runHelperPrompt` discarding a helper run that had already returned when a cancel arrived afterwards, and missing a cancel that arrived while the helper session was being created, which let the run go on to the end
- Fixed skills missing from the sandbox container: `~/.claude/skills` and `~/.claude/CLAUDE.md` are copied with symbolic links resolved to their targets instead of as links that dangle in the container, and the `skills/` directory of every `extensions` root outside `~/.omp` is copied alongside its `rules/`
- Fixed the README sandbox example: the scenario path is `sandbox/scenarios/echo-hi.json` from the repo root, and the model is `futureppo-pool/gpt-6.2-sol` because `futureppo-pool/ernie-5.5-flash-preview` now answers 403
- The `request-recorder-helper` sandbox scenario's watchdog model is `futureppo-pool/gpt-6-luna` instead of `futureppo-pool/minimax-m3.1-flash`, which took 109 s for a one-tool `omp -p` run

## [1.4.0] - 2026-11-26

### Added

- Added the `rules/` directory of every `~/.omp/agent/config.yml` `extensions` directory outside `~/.omp` to the sandbox container, at the same path with symbolic links copied as their targets, and the host's `~/.omp/agent/rules`, which the `~/.omp/agent` copy no longer excludes
- Added observer watchdogs: `inject: none` in a `WATCHDOG-*.md` file runs its body as a background task with the file's `tools` and `model`, logs the one-line reply and never sends anything to the watched session; `delivery`, `maxPerContext`, `note`, `instructions` and `option.*` invalidate such a file, an observer run gets 300 s instead of 90 s, and a timed-out or failed run leaves the cursor so the next run covers the same work
- Added `env: [NAME=value, …]` to observer watchdogs: each `bash` command the observer runs is preceded by `export NAME='value'` lines from a `tool_call` hook in the observer's session, so a variable such as `INTENT_ACTOR=watchdog` is set even when the model's command leaves it out; `env` without `bash` in `tools`, with `eval` in `tools`, with a malformed, repeated or empty entry list, or on a file without `inject: none` invalidates the file

### Changed

- Changed unknown `help://<tool>/<topic>` requests to return an error listing the tool's available topics

### Removed

- Stopped `repo-rules` from scanning Claude Code's user rule directory `~/.claude/rules`: rule files there no longer reach OMP sessions as unscoped or path-scoped rules; user-level rules for OMP go in its native rule directories (`~/.omp/agent/rules` or an extension root's `rules/`)
- Removed `pi-pretty-codeblocks` from `install-plugins.sh`: the updater no longer installs or upgrades it, so its failed extension validation on omp 19.2 no longer stops an apply before the cutover; a machine that already has it keeps it installed, and `./plugin-audit.sh` lists it under `[卸载候选]`
- Stopped the sandbox from copying Claude Code's `~/.claude/rules` into the container; `~/.claude/skills` and `~/.claude/CLAUDE.md` are still copied, and `~/.claude/rules` reaches the container only when `~/.claude` is itself an `extensions` entry, as that root's `rules/`

### Fixed

- Fixed omp-config extensions failing to load on omp 19.2.0 after pi-tui exports were removed

## [1.3.0] - 2026-11-24

### Added

- Added a sandbox `prune` subcommand that tears down leftover runs from earlier builds while sparing sandboxes that are still active
- Added a repeatable `--plugin DIR` option to sandbox `hold` and `run` that copies the plugin into the container and links it with `omp plugin link`
- Added a `prompts` scenario field that sends several user messages in sequence, stopping at the first failed or unsuccessful turn
- Added a `prune-config` sandbox command that strips model roles, agent overrides and retry fallback chains referencing providers outside the target list and drops a missing `exec.initFile`
- Added an updater report note for each `install-plugins.sh` spec that is neither a GitHub source nor an npm name; apply and startup auto-update run no omp command for it
- Added `task` guidance for staged `steps` execution and its mutual exclusivity with `task`, gated on the `task.steps` setting
- Added `delete-guard` inspection of eval `sh` helper commands (also `globalThis.sh`, tagged templates and names bound to the helper) as posix shell scripts on every platform, blocking non-literal commands
- Added `sh` helper commands to `tool-policy-nag`'s terminal and open-ended detection when the helper is spelled under its own name
- Added `help://read/urls` guidance for further read sub-paths, queries and limits when the read tool is available
- Unified `tool-topics` onto OMP's native `help://` scheme (wrapping the built-in `help` handler to merge `omp-config` catalog, shared `omomp-shared/tool-hub` plugin topics, and native `docTopics()`), added `hiddenFromIndex` and error/result-driven `inject` rules (`onError`, `resultPattern`), and integrated `exec_command`/`term://` and `fork_task` seamlessly into `SURFACE-bash.md` and `SURFACE-task.md`
- Added automatic `tools.xdevDocs` → `tools.commandDocs` config migration and retirement of legacy `thinking-translator.json` and `extensions/{task-tool-trim,fork-task}` in `omp-config-update.ts`
- Added optional result-shaping guidance to the system prompt
- Warned once per process when the `input-polish` shortcut is also held by an omp keybinding, a reserved chord, or another extension, naming the holder while `input-polish` keeps the chord
- Added a host-import check to `bun run check` (`ci/host-imports.ts`): a value import under `agent/` whose specifier is not a built-in, a relative path or a key of the omp binary's module table (taken from the installed host's `collectBundledPiEntries()`) fails the check with its file and specifier
- Synced `compact-handoff.ts` from `oh-my-omp/shared@8f2c5e5` via `omomp-shared.json` and wired `repo-rules` (`StatefulHarnessHandoff`) plus `tool-policy-nag`, `turn-judge`, `watchdog-agent`, `lang-nag`, `isolation-nudge`, and `task-completion-judge` (`StatelessNoiseGuard` and `session_before_compact` cleanup / compaction-barrier guards) into the shared compaction handoff coordinator

### Changed

- Updated `tool-topics` surfaces and topics for `bash`, `task`, `ast_grep`, `ast_edit`, `eval`, `github`, `checkpoint`, and `debug` to `@oh-my-pi/pi-coding-agent@19.1.1`: replaced removed `artifact://` references with `local://<id>.log`, fixed `bash` URL redirect/reply and `eval` non-MCP timeout-pause docs, aligned `bash-output`, `ast_edit-apply`, `task-isolation`, and `task-results` `inject` patterns with real tool output text, reconciled `SURFACE-bash.md`, `SURFACE-task.md`, and `SURFACE-ast_edit.md` with `endTurn`, conditional `fork_task`, `m<N>`, mid-flight check suppression, and command/top-level `resolve`/`reject`, and aligned remaining topic docs with 19.1.1 capabilities and host-native `help://eval/*` topics.
- Aligned `tool-topics` `read`, `write`, `edit`, `find`, and `grep` surface and topic docs with OMP 19.1.1: removed all `artifact://` references in favor of `local://<id>.log`, restored native `help://read/sources` and `help://read/urls` pointers and `security://` in `SURFACE-read.md`, fixed binary metadata vs explicit analysis views, web selector caching, single-column PK `WITHOUT ROWID` SQLite writes, `read-failures` / `find-coverage` / `read-summaries` trigger regexes, and updated `upstream:` headers to `pi-coding-agent@19.1.1`
- Restored `{{intentGuidance}}` and compatible 19.1.1 workflow clauses in `agent/SYSTEM_TEMPLATE.md`, stripped the trailing space after `No TODO tracking, no progress updates.` in `REPLACE-SYSTEM-default.yml`, and aligned `agent/agents/README*.txt` and `docs/prompts-and-context*.md` with `reviewer.md` and `todo.enabled: true`
- Moved model-compaction rules from one-rule `COMPACTION-*.md` files into an ordered `rules` list in `model-compaction.json`; the updater and main-session startup merge existing rules in filename order and delete the source files
- Kept all rule files unchanged when `model-compaction.json` already exists or any `COMPACTION-*.md` file is invalid or app-managed, reporting the reason
- Validated `model-compaction.json` and each rule with strict schemas, skipping only invalid entries and naming them as `<file> rules[index]`; unreadable files or a root without a `rules` array are skipped
- Updated the shared copy of `todo-read.ts` to oh-my-omp/shared@e84938e.
- Renamed the installed plugins `omp-todo-more`, `omp-ask-more` and `omp-subagent-more` to `omp-todo-ng`, `omp-ask-ng` and `omp-subagent-ng`: `install-plugins.sh` specs and the updater's readiness checks point at the new repositories, and task-completion-judge names omp-todo-ng in its messages
- Simplified `tool-policy-nag`: the pty lane and the heuristic analyzers share one grammar-driven option parser, sudo/doas/run0 unwrapping and `-c` shell-string detection; the persisted nag state holds only the hit and reminder counts; the shell scanner is split into module-level steps
- Made `tool-policy-nag`'s `form` fallback under `detector: jev` count and remind only while the intent lane cannot run, so judged calls no longer use up its reminder budget
- Made `tool-policy-nag`'s untraced risk check count a step behind `timeout`/`env`/`nice`/`nohup`/`xargs` as the program it runs, count `sudo`/`doas`/`run0` together with the program they run, and stop counting shell keywords (`for`, `if`, `do`, `done`, `{`) as external programs
- Moved the `wt` and `wt_remove` call flow (queueing until the turn ends, two-call `confirm`, what invalidates `confirm`, cancellation) from the tool descriptions into native `help://wt/lifecycle` and `help://wt_remove/lifecycle` topics, and made `wt-tool` read worktree status, branch and HEAD through the native git binding instead of `git` subprocesses
- Made `user-prompt-inject` decide which root-session messages count as user requests and `ask` answers with one rule for both a root session in the same thread and one read from its transcript file, validate transcript records against OMP's message shapes, and read the transcript through a single file handle per model call
- Detected `repo-rules` single-file `cat`/`head`/`tail` reads in `bash` with OMP's own shell lexer (`tools/shell-tokenize`) instead of a private tokenizer, and found the repository root for rule scanning with OMP's `findRepoRoot`
- Made `model-compaction` refuse a rule whose `thresholdTokens` does not fit below the model's largest context window, deciding tier changes and fit with OMP's own `planModelCompactionPoint`, and name the rule as `<file> rules[index]` in refusal warnings
- Simplified `child-memory-warning`: process start times and footprints are exact numbers instead of split 64-bit halves, each scan builds fresh process and ownership indexes instead of reusing aliased buffers, the libproc reader is one class with named offsets, and the non-Darwin log line reads `disabled (darwin only)`
- Updated the shared copy of `compact-handoff.ts` to oh-my-omp/shared@db9dde4.
- Simplified `tool-topics`: inject rules keep one source form and are compiled in one place for both catalog and shared-hub rules, the `help://` wrapper lists native topics of every tool through OMP's own `help://<tool>` listing instead of probing `read`/`eval`, and failures reading native topics are logged instead of dropped silently
- Gated every `task-split-check` and `task-completion-judge` model attempt on the session's spend cap (a refusal ends the check without trying the next model) and recorded each reply's usage in the calling session's ledger, its cost in the session's spend and a chat telemetry span
- Made `task-split-check` and `task-completion-judge` skip a model without credentials and move on to the next one
- Scoped `task-split-check`'s repeat memory to the session that dispatched the call, so an identical assignment flagged in one session is checked again in another, and keyed it on the exact judge prompt
- Left `omp-remote-build` out of the sandbox's plugin copy: the container's `package.json` and `omp-plugins.lock.json` no longer list it, so the updater's `omp plugin upgrade` no longer fails the build on its import of `omp-unified-exec` source
- Gated every `@<purpose>` prompted judgment attempt (`turn-judge`, `lang-nag`, `tool-policy-nag`, `watchdog-agent`) on the session's spend cap, adding each billed attempt's cost to the session's spend, its duration to the ledger entry and one judgment telemetry span; judgments through OMP's judge chain now pass the same cap
- Restricted `@<purpose>` prompted judge models to the session model's provider when `models.noJudge` or `models.offline` is set, reporting the judge inactive when none remain
- Counted only the YAML boolean `true` under `completionJudge` or `splitCheck` (or their hyphenated spellings) for the completion judge and split check; quoted `"true"`, other key casing, nested keys and unparseable frontmatter no longer count
- Left agent definitions with unparseable frontmatter unchanged when adding `splitCheck: true`, reporting the parse error in the migration note instead of writing the key
- Wrote the user-report rule (`NEVER rerun checks to doubt them`) and the compiled-code rule (`NEVER add avoidable allocation`) directly into `SYSTEM_TEMPLATE.md`, and removed the two `REPLACE-SYSTEM-default.yml` rules that rewrote these lines of this repository's own template
- Moved `ast-top-level` onto OMP's tool-command partition for keeping `ast_grep` and `ast_edit` top-level, with the pin-failure warning telling a rejected pin write apart from a pin table OMP no longer honors and naming the tools that stay bash tool commands
- Refreshed `bun.lock` to the `@oh-my-pi` 19.1.0 release and added the lockfile refresh to the after-upgrade steps in `docs/operations.md`
- Refreshed `bun.lock` to the `@oh-my-pi` 19.1.1 release and updated all `// @upstream` markers across local extensions
- Synced `agent/config.yml` `bashInterceptor.patterns` `read` and `write` rules with OMP 19.1.1 so `cat > file` and `cat >> file` redirect to `write` with the append hint instead of `read`
- Rewrote the `AGENTS.md` Imports rule to the module-table criterion `bun run check` enforces, dropping the condition that a host subpath must have been loaded in a real omp session
- Made sandbox `run` and `matrix` exit nonzero unless every model result is `pass`, so `untested` results now fail the command
- Rewrote `baseUrl` in sandbox provider `models` and `modelOverrides` onto the local recorder port, sharing one target per upstream origin
- Created the sandbox bridge network only when `--target` is passed, falling back to the default bridge otherwise
- Pruned cache, usage and performance tables from agentdb snapshots while keeping `auth_credentials`, and exported recorder logs and captured requests as run evidence
- Updated the shared copy of `todo-read.ts` to oh-my-omp/shared@dcbf622.
- Updated the shared copies of `context-delta.ts`, `todo-read.ts` to oh-my-omp/shared@80068ad.
- Extended `isolation-nudge` to remind on steps-based task items, keying each run by all its steps joined in order instead of skipping the item
- Extended `task-split-check` to judge steps-based task items as one run using their steps joined in order
- Updated `grep` tool guidance for per-file caps of 10 matches across many files and 50 within one file, context shown only via `grep.contextBefore`/`grep.contextAfter`, and control characters stripped from match lines
- Updated `grep` tool guidance for binary files: directory and glob searches skip them and list up to five matching ones, while a file named directly as `path` is searched as text
- Updated `find` tool guidance so a deadline that cuts verification short returns the verified hits with a `partial:` notice and fails only when no hit was verified
- Updated `ask` tool guidance for answers returned as JSON keyed by control name with `details.answers[]`, timeout submissions marked `timedOut`, and the no-named-controls error
- Updated `bash`, `task` and `write` tool guidance: `proc://<id>/kill` writes require `content: ""`, jobs can report a `cancelled` state, and settled-job reports carry a `Delivery:` line
- Directed the agent to make file edits with the edit tool and never through sed/perl/python when shell tools are available
- Made the `wt` and `wt_remove` tools refuse calls while the session is in vibe mode, queueing nothing and returning an error that asks to exit vibe mode first
- Imported `TOOL_COMMAND_KEEP_TOP_LEVEL` and `isMountableAsToolCommand` from `@oh-my-pi/pi-coding-agent/tools/tool-commands` in `ast-top-level` and the internal URL router types from `@oh-my-pi/pi-coding-agent/internal-urls` in `tool-topics`, instead of host-internal file paths
- Documented in the `tool-topics` surfaces that `out://` is a write-only mid-turn reply channel (`read`) and that the shell runs in-process utilities ahead of PATH, handed back by `PI_DISABLE_UUTILS_BUILTINS` (`bash`)
- Made `system-prompt-replace` send the edited system prompt itself at every prompt instead of a reminder that quotes each original passage and its replacement; the reminder is sent only after a tool call in a run that skipped the prompt hook after OMP rebuilt its prompt
- Made `tool-topics` write each OMP tool's surface and `Topics` index into the system prompt in place of the native description at every prompt, instead of an `omp-config/tool-topics` reminder that was sent again after every compaction; the replaced descriptions no longer reach the model twice
- Passed the watched session's `sessionId` and `cwd` into `watchdog-agent`'s chat reviewer prompt and matched the tool-usage instruction to whether `tools` grants action tools beyond read-only inspection
- Aligned `agent/SYSTEM_TEMPLATE.md`, `agent/config.yml` (`tools.commandDocs: inline`), `REPLACE-SYSTEM-default.yml` and `extensions-last/README*.md` with OMP 19.1.0 tool commands (`{{toolCommandDocs}}`, `help://read/urls`, `help://eval/agents`, command form for `report_issue`) and removed the obsolete `xd://` device replacement rule
- Simplified `task-completion-judge`: tool-call arguments, results and the submission are serialized natively and cut to their limits (60% head + 40% tail) instead of streamed through a custom bounded JSON writer, the shared context is located in the joined system prompt, the worker's Todo list is read once per review, and the bounce decision is one exhaustive function
- Updated `tool-topics` to index and rewrite OMP 19.1.0 command-mounted tool sections (`## <tool>` / `<tool> — …` / `Usage:`) while skipping catalog-only entries without drift warnings, migrated `SURFACE-*`/`TOPIC-*` docs and `tool-policy-nag/pty.ts` from `xd://` to `help://` and command forms, and removed dead `xd://bash` device-write channel branches and their obsolete tests
- Changed `isolation-nudge` to classify writers from OMP's agent definitions (any agent not limited to read-only tools, including `dispatch-owner` and unknown agents) instead of matching `task:*`/`m<N>` names, so `mentor:default` and other tool-limited agents no longer count
- Changed `isolation-nudge` to detect isolation support from the `task` tool's `isolated` parameter instead of its description text
- Made `subagent-usage` reuse a full calibration that is already running instead of running a second full calibration after it
- Named the judged `reply` state field in `lang-nag`'s judge question, and simplified its detection to idle, running or mismatch with one settings reload for `session_start` and `session_switch`
- Restructured `watchdog-agent`: one session lifecycle (unloaded, active, closed) owns the per-session state, session entries are parsed with schemas in their own module, `/watchdog` handlers live with the command parser and draft prompts in their own module
- Restructured `turn-judge`: spec-file parsing moved to its own module, the main session and subagent paths are chosen by agent kind, the timeline and the skip-tool check walk the session separately, and timeline fitting serializes each kept entry once
- Split `omp-config-update.ts` into modules for files, paths and exclusions, the report shape, plugins, omomp settings migration, legacy migrations, the `omp-light` launcher and conflict adaptation; the entry script keeps its exports, owner lists and retirement lists, and the Todo and fork plugin prerequisites share one readiness check (an installed plugin missing a required file now reports `<plugin> is missing <file>`)

### Removed

- Removed `task` guidance for consulting a past session with `agent: "seance"` and the rule that isolated items cannot use it
- Removed the project agents `loop:scout`, `loop:worker`, `loop:worker-free`, `loop:guardian` and `loop:verifier` and their `.omp/config.yml` model bindings
- Removed the project agent `consult:carbon`, its model binding, and the `hard-decisions-go-to-carbon` rule that routed hard decisions to it
- Removed the `turn-judge` error that told `TURN-JUDGE-*.md` files to rename `maxChars` to `maxBytes`; a leftover `maxChars` key is now ignored like any other unknown key

### Fixed

- Fixed `tool-topics` cross-tool `inject[].tool` ownership (keeping local catalog injection rules out of the tool-filtered shared hub registration) and made `tool-topics/injection.ts` resolve hub topics directly and pass a session-backed `ResolveContext` (or skip safely when absent) when falling back to native `help://` topics
- Fixed `harness_restart` starting a new agent turn after the user interrupted the turn that queued it: the cancellation notice now waits hidden for the user's next turn
- Fixed `harness_restart` not telling the agent about a failed restart when recording the failure in the session threw
- Fixed `tool-policy-nag` risk and masked-failure reminders breaking their quoted command when it contains a run of three or more backticks
- Fixed `omomp-lang` logging that the launch environment overrides `omomp-lang.language` when an inherited `OMOMP_LANG` (for example in an `omp` started from an omp shell) names the configured language
- Fixed `lang-nag` judging code instead of prose when a reply ends with a fenced code block: fenced blocks are dropped before the last paragraph is taken
- Fixed `omp-config-autoupdate.exclude` entries not protecting the numbered `APPEND-SYSTEM-model-NN.md` targets when the updater splits a legacy `APPEND_SYSTEM_MODEL.md` on Windows, and made the updater's excluded-path safety check see move and split targets there
- Fixed `wt_remove` leaving the removed worktree registered as `prunable` in `git worktree list`, treating a subagent working in a worktree subdirectory whose name starts with `..` as outside the worktree, and a finished queued `wt` request resetting a newer request queued by the next session to idle
- Accepted a UTF-8 byte-order mark at the start of `APPEND-SYSTEM-*.md`, `PROMPT-INJECT-*.md`, `TURN-JUDGE-*.md`, `WATCHDOG-*.md` and `COMPACTION-*.md` files instead of rejecting them for missing frontmatter (`append-system-model` already did), and read their `enabled` flag through one shared check
- Stopped `child-memory-warning` from repeating the same sampling-failure warning every 2 s when the failure happens after a successful process snapshot, and described `child-memory-warning.thresholdGiB` as phys_footprint instead of resident memory
- Made `/subagent-usage on` and `recalibrate` warn when the calling session cannot be resolved instead of silently starting no calibration, and stopped `subagent-usage` from counting a dispatch whose resolved model has no `provider/` prefix under a truncated provider name
- Stopped `watchdog-agent` from injecting a chat reviewer reply that has neither `PASS` nor a `SEVERITY:` line; the reply is logged and the same work is reviewed again
- Made `watchdog-agent` abort running reviews on `session_start`, `session_branch` and `session_tree` as it already did on `session_switch`, instead of letting the discarded reviews run to their timeout
- Made `watchdog-agent` find the `WATCHDOG-*.md` files an `edit` touched from the edit result's paths, so the recognition status is appended in every edit mode and for both ends of a move
- Fixed `isolation-nudge` reminders quoting writers dispatched earlier in the same message with double backticks
- Fixed `isolation-nudge` carrying a `task` call blocked by another extension, or a message whose stream was cut off, into later messages' writer count: pending calls now reset at `turn_start` and all state resets at `session_start`/`session_switch`
- Registered the `repo-rules` compaction handoff under its real `omp-config/repo-rules` source and stopped its summary claim from calling root `AGENTS.md`/`CLAUDE.md` "non-root" or naming internal helper calls
- Kept the `omomp-changelog` marker entry of a package whose `omomp` declaration or `package.json` cannot be read, logging it and listing it under `/omomp-changelog`, instead of silently dropping it and losing that package's next What's New
- Showed the `omomp-changelog` What's New even when `seen.json` cannot be written, logging the failure and removing the temporary file
- Made `input-polish` try the next model when a rewrite comes back empty or drops or changes an attachment/paste placeholder, instead of failing on the first model
- Kept the `input-polish` preview box inside terminals narrower than 22 columns and sized it from the TUI's own terminal height
- Stopped a second `input-polish` session attach that raced the first from leaving an extra key handler subscribed
- Compared repo-rules context-file boundaries case-insensitively on Windows so home and repo-root paths match regardless of casing
- Cooled down `@<purpose>` prompted judge candidates in `_shared/judge.ts` for 5 minutes on gateway 502 `upstream_credentials_exhausted` rejections, matching OMP's `resolveJudge`
- Kept the user's enabled state and feature selection of installed plugins across updater applies and startup auto-update: a plugin whose declared spec is unchanged is refreshed with `omp plugin upgrade` instead of `omp install`, a plugin whose spec changed is reinstalled and disabled again if it was disabled, an npm plugin pinned to the recorded exact version is left as is, and a locally linked plugin is no longer installed over; a link made over an installed dependency, which the host's bun install replaces whenever any plugin is installed or upgraded, is linked again with its enable state and features restored
- Located the shared batch context for `task-completion-judge` by the host subagent template's `⁂ Context` heading instead of a `§ Context` marker the host no longer renders
- Judged `task-completion-judge` data yields whose `error` is a filler such as `unused`, `n/a` or `none`; the host treats these as successful results, but the judge skipped them as error yields
- Kept the `harness-restart` completion notice pending until OMP accepted it: a refused or failed send is now logged and re-sent on the next session start or switch instead of being marked consumed
- Made the system-prompt replacement rule for `xd://` device calls match the device sentence whether or not `xd://<tool>` is in backticks, so a template aligned with OMP's bundled one keeps the "Devices are not functions" replacement
- Fixed host-form `ask` results being read as unanswered: answers now come from the form's `answers[]` fields, folded onto one line with matching option notes appended
- Fixed timed-out `ask` submissions being counted as user decisions; a timeout now yields no answers
- Skipped rejected judge candidates: 401/402/403 and 451 rejections exclude the model for the process, while a 404 keeps the five-minute cooldown
- Pointed `install-plugins.sh` and the plugin docs at `oh-my-omp/omp-actual-terminal#release`, the terminal plugin's renamed repository; the old `omp-unified-exec` address returns 404, which failed the updater's apply
- Returned the final assistant turn's text ahead of accumulated streamed deltas in `_shared/helper-session.ts` so multi-turn tool-using watchdogs that narrate before a tool call still resolve a final `PASS` verdict cleanly
- Kept the host's `SYSTEM_TEMPLATE.md`, `APPEND_SYSTEM*.md`, `PERSONALITY.md`, `config-light.yml` and `omp-light.ts` out of the sandbox copy of `~/.omp/agent`, so the updater writes them from the working tree instead of keeping the host copy as an `unknown-base` conflict and sessions load the checkout's prompt template
- Made `omp-config-update` enumerate `agent/extensions/` directories absent from the upstream snapshot and remove their non-app-managed files along with empty extension directories (such as `task-tool-trim` and empty `fork-task`), while preserving app-managed, excluded, symlinked and top-level files

## [1.2.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

### Fixed

- Fixed `bun run check` failing on OMP 18.22.0 host types: the shared helper session no longer reads the removed `isTerminal` field of the session `agent_end` event, which OMP now emits once per run

## [1.2.0] - 2026-11-18

### Added

- Enabled the `lang-nag` extension in light mode

### Fixed

- Restricted `lang-nag` language detection to the run's terminal reply: interrupted, tool-stopped, errored and truncated runs are no longer judged, and earlier mid-run narration no longer stands in
- Fixed `model-compaction` thresholds being lost after a session was resumed or omp restarted: the rules are now applied on `session_start` and `session_switch` as well as on user prompts, so a resumed session driven only by agent-started turns (notices, continuations, IRC wakes) no longer compacts at OMP's default threshold

## [1.1.1] - 2026-11-16

### Changed

- Limited `loop:scout` slices to work that changes file content: a slice's `files` lists exactly the tracked files it changes, and acceptance runs, evidence collection, dependency or lockfile refreshes and repository checks are no longer returned as slices

## [1.1.0] - 2026-11-15

### Added

- Added a `loop:verifier` agent that executes one acceptance row needing a live interactive session, drives the program through a PTY, and yields a `pass`, `fail` or `blocked` verdict with the steps, readings and cleanup it observed
- Required `loop:verifier` to interrupt a session whose model has not answered within 30 seconds and restart it with the next model of the assignment's list, running each row step once without retrying
- Added a read-only `loop:scout` agent that splits an issue into dependency-ordered implementable slices, reports open points with the producer's `path:line` or `none`, and flags contract rows the acceptance commands never observe
- Required `loop:worker` to build a todo list before its first edit, use `ast_grep` for identifiers, edit only absolute paths inside the assigned checkout, and avoid shell deletion, sleeps and commands over five minutes
- Added `loop:worker` and `loop:worker-free` agents that implement a dispatched issue slice in a checkout and accept only a gate-tool pass on the last commit as proof of completion
- Added worker escalation of open points via `yield` help, with `decisions`, `followups`, `deviations` and `risks` reported on completion
- Added a read-only `loop:guardian` agent that opens one session per issue, rules on open contract points as `contract_decides`, `dismissed` or `ruled`, returns rulings as runtime input/output gate cases, and signs off at session end
- Bound the new loop agents in `agentModelOverrides`: `loop:worker` to `claude-haiku-5-5:high`, `loop:worker-free` to `devin/swe-2:high`, `loop:scout` to a `deepseek-v4.1-flash` chain ending in `claude-haiku-5-5`, `loop:guardian` to `claude-sonnet-5-5:high`, and `loop:verifier` to a `deepseek-v4.1-flash` chain from `opencode-go` to `commandcode`

### Changed

- Rebound `task:mid`, `task:low`, `task:free`, `discuss:steady` and `mentor:default` to `commandcode/deepseek/deepseek-v4.1-flash`, with `task:free` at low thinking and the others at high
- Removed the `openai-codex`, `bansos` and `opencode-go` fallback links and the `task` / `sonic` overrides from `task.agentModelOverrides`, leaving `discuss:divergent` on a single `anthropic/claude-opus-5-5:medium` binding
- Windows launcher installs now compile `omp-light.ts` into `omp-light.exe` with `bun build --compile`, rebuilding when the script changes and requiring `bun` on PATH; a leftover `omp-light.cmd` is removed

### Fixed

- Fixed spec-file discovery on Windows missing the home-directory boundary when the home path differed in letter case from the resolved cwd
- Fixed `~`-expanded cwd glob patterns failing to match on Windows by normalizing separators to `/`
- Fixed repo-rules `paths` patterns written as Windows absolute paths (`C:/…` or `C:\…`) never matching: absoluteness is now decided by `path.isAbsolute` and the pattern is normalized to `/` separators

## [1.0.3] - 2026-11-14

### Fixed

- The default system-prompt-replace rule that rewrites the eval prompt's `agent`/`workpool` line matches omp 18.20.0 again, which prints `xd://eval/agents` without backticks; the startup warning "found no target" for `REPLACE-SYSTEM-default.yml[6]` is gone

## [1.0.2] - 2026-11-12

### Changed

- Every updater apply now also runs `omp install` on each installed optional plugin, upgrading it and recording the spec declared in `install-plugins.sh` (an optional plugin installed from a bare URL moves to `#release`)
- Startup auto-update and `/omp-config-autoupdate run` now fetch the GitHub `release` branch instead of `main`, so a commit reaches machines with the next daily release
- omomp plugins are declared as `<url>#release` and follow each plugin's own daily release; an unchanged config commit now also refreshes `#release`-channel plugins, while npm entries and other pinned refs still wait for the next config commit

## [1.0.1] - 2026-11-12

### Changed

- omp-config is now an omomp release member: it is released daily at 02:00 GMT+9 from `## [Unreleased]` of this changelog, and the updater copies the changelog to `~/.omp/agent/extensions/_shared/CHANGELOG.md`, where the What's New of omomp-changelog reads it.
