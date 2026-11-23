# omp Test Sandbox

[中文](README.zh-CN.md)

`sandbox/` builds a throwaway Linux container on the local OrbStack in which real `omp` sessions run with a copy of this machine's `~/.omp` configuration and the credentials of the providers the recorder covers, and the omp-config working tree under test. Changes that must not be tried on the host, such as a deletion guard that might fail to block `rm -rf "$X"/…`, are exercised here: when the change misbehaves only the container is affected, and the container, network and the credential copy inside them are removed when the run ends.

The sandbox runs on macOS with OrbStack (or another Docker engine) and needs `bun`, `git` and `tar` on the host. It is not used by CI: credentials never enter the public repository's CI.

## Commands

```bash
bun sandbox/sandbox.ts hold [--target] [--repo DIR] [--plugin DIR]...                          # build, keep until SIGINT/SIGTERM/SIGHUP, remove
bun sandbox/sandbox.ts run [--target] [--repo DIR] [--plugin DIR]... SCENARIO_JSON MODEL...   # build, run the scenario per model, remove
bun sandbox/sandbox.ts matrix RUN SCENARIO_JSON MODEL...                                      # run a scenario inside a held sandbox
bun sandbox/sandbox.ts cache RUN                                                              # export the prompt-cache report of a held sandbox now
bun sandbox/sandbox.ts down RUN                                                               # remove a run whose holder was killed
bun sandbox/sandbox.ts prune                                                                  # remove stale runs while leaving running sandboxes alone
```

- `--repo` defaults to the checkout that contains `sandbox/`. `--target` adds the ssh target and a user-defined bridge network for it. `--plugin DIR` (repeatable) copies a local plugin directory into `/plugins/<basename>`, runs `bun install` there when `package.json` is present, and links it with `omp plugin link`.
- `hold` prints the run id and the commands that attach to it, then waits. Prepare the session's workspace before omp starts: files, repositories and other fixtures go under `/work` through `docker exec omp-sandbox-<run> sh -c '…'`. Interactive sessions use `docker exec -it -w /work omp-sandbox-<run> omp --model <provider>/<model>`; an agent drives that command through `bash` (`pty: true`). Stop the holder with Ctrl-C, SIGTERM or SIGHUP and let it exit: teardown takes a few seconds. For a holder running in a `bash` (`pty: true`) terminal, send Ctrl-C (`write_stdin` with `\u0003`), not `kill_session`, which escalates to SIGKILL after 2 s and cuts the teardown short.
- `run` exits 0 only when every model passes (`pass`), 1 otherwise (including `untested`). `matrix` exits the same way. `cache` exits 0 when the report reached the host, 1 otherwise.
- `down` is for a single holder that died without its `finally` (SIGKILL, a crashed host); it removes every resource labelled with the run. `prune` collects exited containers, leftover networks and stale ledger rows in state `进行中`, skips every run currently running in Docker, removes the rest, and marks them `已清理（prune）` in the ledger.

## What a run contains

| Resource | Contents |
|---|---|
| Network `omp-sandbox-<run>-net` (`--target`) | Created only when `--target` is passed (first created, last removed). A user-defined bridge, so the sandbox and ssh target reach the internet and each other by name. Without `--target`, the container uses Docker's default `bridge` network. |
| Container `omp-sandbox-<run>` | `oven/bun:latest` linux/arm64 (pulled each run, no pinned version), `--init`, `HOME` equal to the host's home path so absolute paths in the copied config stay valid. Extra packages: `git`, `openssh-client`, `python3`, `zsh`, `jq`, `sqlite3`, `procps`. No published port, volume, bind mount or docker socket. |
| Container `omp-sandbox-<run>-target` (`--target`) | `debian:stable-slim` with `openssh-server` and `python3`. The sandbox generates an ed25519 key per run under `$HOME/.ssh`, the target trusts it for `root`, and `/etc/ssh/ssh_config.d/omp-sandbox-target.conf` in the sandbox names the target `target`: `ssh target …` (ssh reads `~/.ssh` from the passwd home, `/root`, not from `$HOME`). |

These resources carry the label `omp-sandbox.run=<run>`; teardown finds them by that label.

Contents enter the sandbox as tar streams or stdin pipes into `docker exec`; nothing credential-bearing is staged on the host disk:

- `~/.omp/agent`, without `sessions/`, `blobs/`, `terminal-sessions/`, `custom-session-files/`, `predict/`, `cache/`, `history.db*`, `agent.db*`, `models.db*`, `transcripts.db*`, `skill-descriptions.db*`, `models.yml.bak*`, `rules/`, `mcp.json*`, `extensions/`, `extensions-last/`, `agents/`, the updater-managed plain files `SYSTEM_TEMPLATE.md`, `APPEND_SYSTEM*.md`, `PERSONALITY.md`, `config-light.yml` and `omp-light.ts`, `.omp-config-base/files` and lock files. `~/.omp/logs` is not copied. When `.omp-config-base/state.json` exists in the copy, its `unknownPlain` list is cleared while `structured` is kept; with no host copy and no recorded base, the updater writes every plain managed file from `/repo` while still 3-way merging `config.yml`.
- `agent.db`: SQLite's serialization of a read-only connection to the host database, taken inside a read transaction so it includes WAL frames not yet checkpointed. An in-memory writable copy clears the history and cache tables listed in `PRUNED_TABLES` (`cache`, `client_usage`, `command_usage`, `model_perf`, `model_usage`, `usage_cost_history`, `usage_history`), compacts the image, marks it as a rollback-journal database (header bytes 18–19), writes it into the container byte for byte, switches it back to WAL there, and checks it with `integrity_check`. The host then reads the container's copy back and compares every field of every row of every table with its pruned snapshot in memory; the build fails on any difference. Only table names, row counts and "every field equal" are printed, never values or digests. After that comparison the container's copy alone loses its `auth_credentials` rows whose provider has no recorder target (see Credentials); the host database is untouched.
- `~/.omp/plugins`, including its lockfile but without `node_modules/` (built for macOS) and without `omp-remote-build`, which the container's copies of `package.json` and `omp-plugins.lock.json` no longer list; `bun install` in the container installs the locked versions for Linux, and if that install fails, removes `bun.lock` inside the container and retries `bun install`.
- `~/.claude/rules`, `~/.claude/skills` and `~/.claude/CLAUDE.md`, those that exist.
- The working tree at `/repo`: tracked and untracked files, uncommitted changes included, ignored files excluded, initialized as a `main` git repository with a `sandbox` commit inside the container.
- Each `--plugin DIR`: its non-ignored git files (or tar without `node_modules` and `.git` if not a git checkout) under `/plugins/<basename>`.

Then the container installs the latest `@oh-my-pi/pi-coding-agent`, runs the `/repo` updater (`omp-config-update.ts apply --source /repo` — it links the `omp-config` plugin and moves the copied omomp values into its settings), switches the startup auto-update off in those settings (`sandbox/autoupdate-off.ts` sets `omp-config-autoupdate.enabled` to `false` through `omp plugin config set` and prints the value read back), and installs/links any `--plugin` directories. The extensions, subagents, prompt templates and light-mode files in the container's agent directory therefore come from the working tree, not from what the host last applied, and stay so across every omp start in the sandbox: the copied host switch would otherwise apply GitHub `release` over them at the first start. The host's own settings are not touched.

### Credentials

The credential copy is used as it is: `apiKey` and every other field of `models.yml` stay as they are on the host. The container's copy alone is adjusted so traffic stays inside the recorder: provider and model-level `baseUrl` values in `models.yml` point at the recorder below; `auth_credentials` rows of every provider without a recorder target are deleted from the container's `agent.db` (the build checks that every remaining row's provider has a target and fails otherwise); and after the updater finishes merging `config.yml`, `recorder.ts prune-config` strips unrecorded providers and dangling `@<role>` references from `modelRoles`, `task.agentModelOverrides` and `retry.fallbackChains` (keeping recorded providers, surviving `@<role>` references and bare selectors) and removes `exec.initFile` when the file does not exist in the container. A provider without a `baseUrl` therefore has no credentials in the sandbox and its models are recorded as untested. A model whose calls fail in the sandbox is recorded as untested; the sandbox does not investigate why. A provider that rotates refresh tokens may invalidate the host's copy when a session in the sandbox refreshes it; the sandbox does not guard against this.

### Model request recorder

Every model request of every omp session in the container passes through a recorder that runs inside the container (`sandbox/recorder.ts`, started by `sandbox.ts` after the copy of `~/.omp/agent`). `setup` rewrites each provider's top-level `baseUrl` as well as any model-level `baseUrl` in `models[]` or `modelOverrides` to a loopback URL (`http://127.0.0.1:9400`, `9401`, …) in the container's `models.yml`, reusing the provider's port when a model shares its upstream origin and allocating a new target for a distinct origin, and writes the mapping to `/sandbox/recorder-targets.json`. It re-parses the rewritten file and fails the build unless every provider, `models[]` entry and `modelOverrides` entry equals its original in all fields except `baseUrl`. Providers without any `baseUrl` are not changed.

`serve` listens on each port. For each request it first appends one line to the evidence file, then forwards the request to the recorded upstream with its method, path, query, headers and body unchanged, and streams the response back. The evidence line is `{"seq", "provider", "tools", "body"}`: `tools` lists each `tools[]` entry's `name`, or its `function.name`, and is `[]` when the body has no `tools`. Request headers are never recorded, since they carry credentials. If the line cannot be written the request gets a 500 and is not forwarded, so no request reaches the provider unrecorded.

The driver names the current scenario's `<name>.requests.jsonl` to the recorder for the length of a session through `/sandbox/.requests-sink`, and clears the pointer afterwards; requests made outside a driver session (`hold`, interactive `omp`) go to `/evidence/interactive.requests.jsonl` in the container. Before teardown, `hold` and `run` export `/evidence/interactive.requests.jsonl`, `/evidence/recorder.log` and `~/.omp/logs` (whichever exist) to `/tmp/omp-sandbox-<run>/evidence/` on the host. The driver refuses to start a session when `/sandbox/recorder.ready` is missing.

Helper sessions created inside an extension (for example `runHelperPrompt`, which does not go through RPC) use the same providers and so appear in the same file. The `seq` numbers count every request the recorder received, so a gap means a request was not recorded.

## Scenarios and the RPC driver

`matrix` and `run` copy the scenario into the container and run `sandbox/driver.ts` there once per model, each in a fresh `omp --mode rpc --no-ui --model <model>` session with its own working directory `/runs/<provider>_<model>/<name>-<ms>`. The scenario's `init` and `finalAssertion` run in that same directory, so `init` can prepare the session's workspace (a git repository, files) and `finalAssertion` can inspect what the session left there. A scenario file is JSON:

| Field | Meaning |
|---|---|
| `name` | `[a-z0-9][a-z0-9._-]*`; names the evidence files |
| `init` | sh command the driver runs in the session's working directory before the session (not through the agent), exit 0 required; it runs again before every model |
| `prompt` / `prompts` | either a single user message string (`prompt`) or a non-empty list of user messages (`prompts`) sent sequentially after each completed turn |
| `finalAssertion` | sh command run in the session's working directory after the session; exit 0 passes |
| `calls.expect` | matchers that must appear in this order among the tool calls (a subsequence) |
| `calls.forbid` | matchers no tool call may satisfy |
| `replyIncludes` | literal strings the last assistant reply must contain |

A matcher is `{ "tool", "isError"?, "inputPattern"?, "resultIncludes"? }`: `tool` is a tool name or a list of names any of which matches, `inputPattern` is a regular expression over the call's JSON input, `resultIncludes` a literal in its result text. Only calls the agent loop runs are seen: a tool an `eval` cell calls through its `tool.<name>` bridge is part of that `eval` call's input and result. The driver checks what the scenario declares and attaches no meaning of its own. [`scenarios/echo-hi.json`](scenarios/echo-hi.json) is the smallest example.

Each run of a scenario for a model ends with a result:

| Result | When |
|---|---|
| `pass` | Every assertion held |
| `fail` | The session completed and an assertion did not hold |
| `untested` | omp does not know the model (`Model "…" not found`), or every assistant reply failed at the provider and no tool ran |
| `harness-error` | `init` failed, omp exited before its ready frame for another reason, the prompt was rejected, the session hit the 600 s limit, omp exited nonzero, or omp reported no session file |

Evidence lands in `/tmp/omp-sandbox-<run>/evidence/<provider>_<model>/`. The normal report is `<name>.driver.json` (result, every tool call with its input, `isError` and the first 4,000 characters of its result, the final-assertion output, and the first 4,000 characters of the last reply). `<name>.events.jsonl` (every RPC frame) is created when the RPC session starts; `<name>.session.jsonl` is copied only if omp reports a session file that exists. `<name>.requests.jsonl` holds one line per model request of the session, helper sessions included (see the recorder above); it exists, empty if no request was made, whenever the driver starts a session. If `init` fails, only the driver report is written. The host copies whichever of these evidence files exist for each model; `agent.db` and `models.yml` never leave the container. Events, session files and request bodies contain whatever the model saw, so a scenario must not read credential files.

## Prompt-cache report

`hold` and `run` export the report after the middle step and before teardown, so it covers every session the run started, the interactive ones included; `cache RUN` exports it from a held sandbox at any time. Each export overwrites `/tmp/omp-sandbox-<run>/cache.json` on the host and prints its summary tables as Markdown. A failed export prints its reason and does not change the exit code of `hold` or `run`.

`sandbox/cache.ts` runs in the container over every `*.jsonl` under `~/.omp/agent/sessions`: the main sessions and the subagent transcripts nested in their directories. That directory starts empty, because the copy of `~/.omp/agent` leaves out `sessions/`. A model call is an assistant `message` entry (`source.kind` `turn`, a turn of the agent loop) or a `model_usage` entry (`aux`, with the `purpose` omp recorded, such as `job-caption`). Calls that no transcript records are not in the report.

| Field of `cache.json` | Contents |
|---|---|
| `calls` | One row per call in transcript order: `transcript` (path under `sessions/`), `line`, `at`, `source`, `provider`, `model`, `stopReason`, `input`, `cacheRead`, `cacheWrite`, `output`, `hitRate` |
| `byTranscript`, `byModel` | Totals per transcript and per `provider/model`: `calls`, `callsWithRead` (calls with `cacheRead` > 0), token sums and the token-weighted `hitRate` |
| `skipped` | Lines that are not JSON objects, such as the torn last line of a session still being written |

Token counts are omp's normalized usage, in which `input` excludes cached tokens. A call's prompt is `input + cacheRead + cacheWrite` and its `hitRate` is `cacheRead / prompt`; it is `null` when the prompt is 0, as for a call that failed at the provider. Only numbers, model names, purposes and timestamps enter the report, never message text.

## Lifecycle and the ledger

The OrbStack ledger is the directory `~/Ext/work/orbstack/`; sandbox runs have their own file there, `omp-sandbox.md`. `hold` and `run` write the run's row (state 进行中) before creating anything and refuse to start when the ledger directory is missing. The build, the scenario or the wait for `SIGINT`/`SIGTERM`/`SIGHUP`, the prompt-cache export, and the container evidence/log export run inside `try`; the `finally` attempts to remove the run's containers and network and checks for leftovers with `docker ps -a` and `docker network ls` filtered by `name=omp-sandbox-<run>`. It rewrites the same row with the result: 已完成、已清理 with the removal and the empty listings, or 清理失败 with remaining resources or failed Docker command details, including a failure to list resources (the command then exits 1). `down` and `prune` rewrite rows the same way (`已清理（down）` and `已清理（prune）`).

A SIGKILLed holder leaves the row at 进行中 and its resources in place; `down <run>` removes one run and `prune` cleans every stale run while leaving running sandboxes untouched.

## Rules

- The container isolates the host's files, not remote services: sessions run with real credentials and outbound network access. Do not write scenarios that act on remote systems or accounts they must not change.
- One run, one sandbox: runs are not reused. The run id combines the build time in base 36 with a random suffix.
- Keep `sandbox/*.ts` self-contained: `/sandbox` in the container holds a copy of this directory, and `driver.ts`, `cache.ts`, `db.ts`, `autoupdate-off.ts` and `recorder.ts` run there with Bun alone.
