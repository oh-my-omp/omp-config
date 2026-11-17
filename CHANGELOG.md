# Changelog

## [Unreleased]

### Added

- Added `xd://read/urls` guidance for further read sub-paths, queries and limits when the read tool is available
- Added optional result-shaping guidance to the system prompt
- Enabled the `lang-nag` extension in light mode

### Changed

- Directed the agent to make file edits with the edit tool and never through sed/perl/python when shell tools are available

### Fixed

- Extended the system-prompt replacement rule to match backtick-quoted `xd://<tool>` references
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

- Fixed host-form `ask` results being read as unanswered: answers now come from the form's `answers[]` fields, folded onto one line with matching option notes appended
- Fixed timed-out `ask` submissions being counted as user decisions; a timeout now yields no answers
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
