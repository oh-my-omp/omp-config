# Changelog

## [Unreleased]

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
