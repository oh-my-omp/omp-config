# omp Test Sandbox

[中文](README.zh-CN.md)

`sandbox/` builds a throwaway Linux container on the local OrbStack in which real `omp` sessions run with a copy of this machine's `~/.omp` configuration and credentials and the omp-config working tree under test. Changes that must not be tried on the host, such as a deletion guard that might fail to block `rm -rf "$X"/…`, are exercised here: when the change misbehaves only the container is affected, and the container, network and the credential copy inside them are removed when the run ends.

The sandbox runs on macOS with OrbStack (or another Docker engine) and needs `bun`, `git` and `tar` on the host. It is not used by CI: credentials never enter the public repository's CI.

## Commands

```bash
bun sandbox/sandbox.ts hold [--target] [--repo DIR]                          # build, keep until SIGINT/SIGTERM, remove
bun sandbox/sandbox.ts run [--target] [--repo DIR] SCENARIO_JSON MODEL...   # build, run the scenario per model, remove
bun sandbox/sandbox.ts matrix RUN SCENARIO_JSON MODEL...                     # run a scenario inside a held sandbox
bun sandbox/sandbox.ts down RUN                                              # remove a run whose holder was killed
```

- `--repo` defaults to the checkout that contains `sandbox/`. `--target` adds the ssh target.
- `hold` prints the run id and the commands that attach to it, then waits. Interactive sessions use `docker exec -it -w /work omp-sandbox-<run> omp --model <provider>/<model>`; an agent drives that command through `exec_command`. Stop the holder with Ctrl-C or SIGTERM and let it exit: teardown takes a few seconds. For a holder running in an `exec_command` session, send Ctrl-C (`write_stdin` with `\u0003`), not `kill_session`, which escalates to SIGKILL after 2 s and cuts the teardown short.
- `run` exits 0 when every model passes or is untested, 1 otherwise. `matrix` exits the same way.
- `down` is only for a holder that died without its `finally` (SIGKILL, a crashed host). It removes every resource labelled with the run.

## What a run contains

| Resource | Contents |
|---|---|
| Network `omp-sandbox-<run>-net` | Created first and removed last. A user-defined bridge, so containers reach the internet and each other by name. |
| Container `omp-sandbox-<run>` | `oven/bun:latest` linux/arm64 (pulled each run, no pinned version), `--init`, `HOME` equal to the host's home path so absolute paths in the copied config stay valid. Extra packages: `git`, `openssh-client`, `python3`, `zsh`, `jq`, `sqlite3`, `procps`. No published port, volume, bind mount or docker socket. |
| Container `omp-sandbox-<run>-target` (`--target`) | `debian:stable-slim` with `openssh-server` and `python3`. The sandbox generates an ed25519 key per run under `$HOME/.ssh`, the target trusts it for `root`, and `/etc/ssh/ssh_config.d/omp-sandbox-target.conf` in the sandbox names the target `target`: `ssh target …` (ssh reads `~/.ssh` from the passwd home, `/root`, not from `$HOME`). |

All three carry the label `omp-sandbox.run=<run>`; teardown finds them by that label.

Contents enter the sandbox as tar streams or stdin pipes into `docker exec`; nothing credential-bearing is staged on the host disk:

- `~/.omp/agent`, without `sessions/`, `blobs/`, `terminal-sessions/`, `custom-session-files/`, `predict/`, `cache/`, `history.db*`, lock files and `agent.db*`. `~/.omp/logs` is not copied.
- `agent.db`: SQLite's serialization of a read-only connection to the host database. It is taken inside one read transaction, so it includes WAL frames not yet checkpointed. The image is marked as a rollback-journal database (header bytes 18–19), written into the container byte for byte, switched back to WAL there, and checked with `integrity_check`. The host then reads the container's copy back and compares every field of every row of every table with its snapshot in memory; the build fails on any difference. Only table names, row counts and "every field equal" are printed, never values or digests.
- `~/.omp/plugins`, without `node_modules/` (built for macOS); `bun install` in the container installs the same locked versions for Linux.
- `~/.claude/rules`, `~/.claude/skills` and `~/.claude/CLAUDE.md`, those that exist.
- The working tree at `/repo`: tracked and untracked files, uncommitted changes included, ignored files excluded.

Then the container installs the latest `@oh-my-pi/pi-coding-agent` and runs the `/repo` updater (`omp-config-update.ts apply --source /repo`), so the extensions in the container's agent directory come from the working tree, not from what the host last applied.

### Credentials

The credential copy is used as it is: nothing is rewritten, refreshed or filtered, and model bindings stay as configured on the host. A model whose calls fail in the sandbox is recorded as untested; the sandbox does not investigate why. A provider that rotates refresh tokens may invalidate the host's copy when a session in the sandbox refreshes it; the sandbox does not guard against this.

## Scenarios and the RPC driver

`matrix` and `run` copy the scenario into the container and run `sandbox/driver.ts` there once per model, each in a fresh `omp --mode rpc --no-ui --model <model>` session with its own working directory under `/runs/`. A scenario file is JSON:

| Field | Meaning |
|---|---|
| `name` | `[a-z0-9][a-z0-9._-]*`; names the evidence files |
| `init` | sh command the driver runs before the session (not through the agent), exit 0 required; it runs again before every model |
| `prompt` | the single user message |
| `finalAssertion` | sh command run after the session; exit 0 passes |
| `calls.expect` | matchers that must appear in this order among the tool calls (a subsequence) |
| `calls.forbid` | matchers no tool call may satisfy |
| `replyIncludes` | literal strings the last assistant reply must contain |

A matcher is `{ "tool", "isError"?, "inputPattern"?, "resultIncludes"? }`: `inputPattern` is a regular expression over the call's JSON input, `resultIncludes` a literal in its result text. The driver checks what the scenario declares and attaches no meaning of its own. [`scenarios/echo-hi.json`](scenarios/echo-hi.json) is the smallest example.

Each run of a scenario for a model ends in one of four results:

| Result | When |
|---|---|
| `pass` | Every assertion held |
| `fail` | The session completed and an assertion did not hold |
| `untested` | omp does not know the model (`Model "…" not found`), or every assistant reply failed at the provider and no tool ran |
| `harness-error` | `init` failed, omp exited before its ready frame for another reason, the prompt was rejected, the session hit the 600 s limit, omp exited nonzero, or omp reported no session file |

Evidence lands in `/tmp/omp-sandbox-<run>/evidence/<provider>_<model>/` as `<name>.driver.json` (result, every tool call with its input, `isError` and the first 400 characters of its result, the final-assertion output, the last reply), `<name>.events.jsonl` (every RPC frame) and `<name>.session.jsonl` (the session file omp reported). The host copies exactly these three files per model; `agent.db` and `models.yml` never leave the container. Events and session files contain whatever the model saw, so a scenario must not read credential files.

## Lifecycle and the ledger

The OrbStack ledger is the directory `~/Ext/work/orbstack/`; sandbox runs have their own file there, `omp-sandbox.md`. `hold` and `run` write the run's row (state 进行中) before creating anything and refuse to start when the ledger directory is missing. The build, the scenario or the wait for a signal run inside `try`; the `finally` removes the run's containers and network, prints `docker ps -a` and `docker network ls` filtered by `name=omp-sandbox-<run>`, and rewrites the same row with the result: 已完成、已清理 with the removal and the empty listings, or 清理失败 with what is left (the command then exits 1). `down` rewrites the row the same way.

A SIGKILLed holder leaves the row at 进行中 and its resources in place; `down <run>` removes them.

## Rules

- The container isolates the host's files, not remote services: sessions run with real credentials and outbound network access. Do not write scenarios that act on remote systems or accounts they must not change.
- One run, one sandbox: runs are not reused. The run id is the build time in base 36.
- Keep `sandbox/*.ts` self-contained: `/sandbox` in the container holds a copy of this directory, and `driver.ts` and `db.ts` run there with Bun alone.
