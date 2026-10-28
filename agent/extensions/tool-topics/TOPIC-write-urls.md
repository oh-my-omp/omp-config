---
tool: write
name: urls
title: Writing to internal URLs
when: before writing to `agent://`, `proc://`, `cfg://`, `local://`, `vault://` or `ssh://`
upstream: pi-coding-agent@18.13.2 src/internal-urls/{agent,proc,cfg,local,ssh,vault}-protocol.ts, omp://tools/write.md § Writable internal resources and tool devices
---
# Writing to internal URLs

- `agent://<id>`: sends `content` (non-empty) as a message to that agent; `agent://all` broadcasts to visible live peers. No `/<json-path>` suffix. The receipt confirms delivery; it does not wait for a reply.
- `proc://<id>/kill`: cancels a job or owned agent; `content` is optional and ignored. Service stdin (`proc://<name>`) and `proc://<name>/mode` need named services, which are disabled here (`launch.enabled: false`). `proc://<id>/streams` is read-only.
- `cfg://<setting>`: sets one setting leaf for this session (value parsed by the setting's type); `cfg://<setting>/save` persists it. Needs an interactive top-level session and user approval; refused in subagents and headless sessions. A higher-precedence layer or environment variable can shadow the value: check the result.
- `local://<path>`: a file in the session's shared scratch area (also visible to subagents); writes stay inside it.
- `vault://<path>`: a file under the vault root, when the vault is enabled.
- `ssh://<host>/<path>`: writes a remote text file over SSH (exec approval).
- `xd://<device>`: runs that device with the JSON object in `content`; `xd://<device>/<topic>` is documentation, read it, never write it.
- Read-only schemes (`artifact://`, `skill://`, `history://`, `omp://`, `issue://` …) are refused. A line selector on a write target is refused (`:raw` and `:conflicts` are the only peeled selectors).
