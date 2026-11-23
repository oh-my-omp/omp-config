---
tool: write
name: urls
title: Writing to internal URLs
when: before writing to `out://`, `agent://`, `peer://`, `proc://`, `term://`, `cfg://`, `local://`, `vault://` or `ssh://`
upstream: pi-coding-agent@19.1.0 src/tools/write.ts, src/internal-urls/{agent,proc,cfg,local,out,ssh,vault}-protocol.ts, omp://tools/write.md § Writable internal resources and tool devices
---
# Writing to internal URLs

- `out://`: mid-turn reply channel — writes Markdown (up to 64 KiB) to show the user a reply without ending the turn. Interactive TUI main session only (print, RPC, ACP, and subagents refuse it); not readable.
- `agent://<id>`: sends `content` (non-empty) as a message to that agent; `agent://all` broadcasts to visible live peers (main agent only; a subagent's broadcast fails). No `/<json-path>` suffix. The receipt confirms delivery; it does not wait for a reply.
- `peer://<name>` (when `omp-peers` is active): sends `content` to a live peer session by name across sessions (see `read peer://` to list peers).
- `proc://<id>/kill`: cancels a background job or owned agent; `content` is required like on every write and ignored on this target, so send `content: ""`. Service stdin (`proc://<name>`) and `proc://<name>/mode` need named services, which are disabled here (`launch.enabled: false`). `proc://<id>/streams` is read-only.
- `term://<job_id>` (live PTY terminals, using the `bg_N` job id alongside `proc://<id>` for non-interactive background jobs): `write term://<job_id>` sends raw stdin text to a running PTY terminal; `write term://<job_id>/kill` (`content: ""`) terminates it; `write term://<job_id>/on_exit` registers an exit follow-up notice; `write term://<job_id>/monitor` (`content: "cancel"`) cancels an active monitor. Use `read term://` to list live PTY terminals and `read term://<job_id>` to inspect output (`help://bash/terminal`).
- `cfg://<setting>`: sets one setting leaf for this session (value parsed by the setting's type); `cfg://<setting>/save` persists it. Needs an interactive top-level session and user approval; refused in subagents and headless sessions. A higher-precedence layer or environment variable can shadow the value: check the result.
- `local://<path>`: a file in the session's shared scratch area (also visible to subagents); writes stay inside it.
- `vault://<path>`: a file under the vault root, when the vault is enabled.
- `ssh://<host>/<path>`: writes a remote text file over SSH (exec approval).
- Read-only schemes (`artifact://`, `skill://`, `history://`, `omp://`, `help://`, `issue://` …) are refused. A line selector on a write target is refused (`:raw` and `:conflicts` are the only peeled selectors).
