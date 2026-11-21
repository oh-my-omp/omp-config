# Changelog

## [Unreleased]

### Added

- Added `task` guidance for staged `steps` execution and its mutual exclusivity with `task`, gated on the `task.steps` setting
- Added `delete-guard` inspection of eval `sh` helper commands (also `globalThis.sh`, tagged templates and names bound to the helper) as posix shell scripts on every platform, blocking non-literal commands
- Added `sh` helper commands to `tool-policy-nag`'s terminal and open-ended detection when the helper is spelled under its own name
- Added `xd://read/urls` guidance for further read sub-paths, queries and limits when the read tool is available
- Added optional result-shaping guidance to the system prompt
- Warned once per process when the `input-polish` shortcut is also held by an omp keybinding, a reserved chord, or another extension, naming the holder while `input-polish` keeps the chord
- Added a host-import check to `bun run check` (`ci/host-imports.ts`): a value import under `agent/` whose specifier is not a built-in, a relative path or a key of the omp binary's module table (taken from the installed host's `collectBundledPiEntries()`) fails the check with its file and specifier

### Changed

- Gated every `task-split-check` and `task-completion-judge` model attempt on the session's spend cap (a refusal ends the check without trying the next model) and recorded each reply's usage in the calling session's ledger, its cost in the session's spend and a chat telemetry span
- Made `task-split-check` and `task-completion-judge` skip a model without credentials and move on to the next one
- Gated every `@<purpose>` prompted judgment attempt (`turn-judge`, `lang-nag`, `tool-policy-nag`, `watchdog-agent`) on the session's spend cap, adding each billed attempt's cost to the session's spend, its duration to the ledger entry and one judgment telemetry span; judgments through OMP's judge chain now pass the same cap
- Restricted `@<purpose>` prompted judge models to the session model's provider when `models.noJudge` or `models.offline` is set, reporting the judge inactive when none remain
- Moved `ast-top-level` onto OMP's tool-command partition for keeping `ast_grep` and `ast_edit` top-level, with the pin-failure warning now reporting that both stay bash tool commands
- Refreshed `bun.lock` to the `@oh-my-pi` 19.1.0 release and added the lockfile refresh to the after-upgrade steps in `docs/operations.md`
- Rewrote the `AGENTS.md` Imports rule to the module-table criterion `bun run check` enforces, dropping the condition that a host subpath must have been loaded in a real omp session
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

### Removed

- Removed `task` guidance for consulting a past session with `agent: "seance"` and the rule that isolated items cannot use it
- Removed the project agents `loop:scout`, `loop:worker`, `loop:worker-free`, `loop:guardian` and `loop:verifier` and their `.omp/config.yml` model bindings
- Removed the project agent `consult:carbon`, its model binding, and the `hard-decisions-go-to-carbon` rule that routed hard decisions to it

### Fixed

- Kept the `harness-restart` completion notice pending until OMP accepted it: a refused or failed send is now logged and re-sent on the next session start or switch instead of being marked consumed
- Made the system-prompt replacement rule for `xd://` device calls match the device sentence whether or not `xd://<tool>` is in backticks, so a template aligned with OMP's bundled one keeps the "Devices are not functions" replacement
- Fixed host-form `ask` results being read as unanswered: answers now come from the form's `answers[]` fields, folded onto one line with matching option notes appended
- Fixed timed-out `ask` submissions being counted as user decisions; a timeout now yields no answers
- Skipped rejected judge candidates: 401/402/403 and 451 rejections exclude the model for the process, while a 404 keeps the five-minute cooldown
- Pointed `install-plugins.sh` and the plugin docs at `oh-my-omp/omp-actual-terminal#release`, the terminal plugin's renamed repository; the old `omp-unified-exec` address returns 404, which failed the updater's apply

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
