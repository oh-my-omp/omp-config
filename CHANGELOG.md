# Changelog

## [Unreleased]

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
