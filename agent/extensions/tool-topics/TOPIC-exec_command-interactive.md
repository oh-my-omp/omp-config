---
tool: exec_command
name: interactive
title: Sending input and monitoring output
when: before sending input to a running terminal, or before using `monitor` with a `condition`
upstream: omp-unified-exec@0.14.19 (7e87dd6) src/index.ts write_stdin/monitor descriptions
---
# Sending input and monitoring output

- `write_stdin` writes bytes verbatim, appending nothing: end every line with `\r` (Windows console programs ignore `\n`), and send ESC or an arrow key sequence on its own.
- An empty payload is rejected (`empty_poll_removed`): to read without writing, read `terminal_url`; to wait, use `monitor`.
- `chars` takes C-style escapes (`\xHH`, `\uHHHH`, `\u{H…}`, `\n`, `\r`, `\t`, `\0`, `\a`, `\e`, `\b`, `\f`, `\v`, `\\`, `\"`; an unknown `\X` stays literal). `chars_b64` sends raw bytes. They are mutually exclusive.
- `yield_time_ms` on `write_stdin` is an attachment window, not a process timeout.
- `monitor` with a `condition` (JavaScript regex source, no `/` delimiters) wakes you for each batch matching it, up to `max_returns` (default 10). Without `condition` it wakes once when the session ends.
- It observes without consuming: only output produced after the call counts, and matches coalesce for about 250 ms. `kill_session` or a session reset ends it silently, and delivered follow-ups cannot be recalled.
- `remind_after_ms` (default 20 minutes) sends one reminder quoting the current screen; it neither counts toward `max_returns` nor ends the monitor, and a match restarts it. On that reminder, read the terminal, answer the prompt with `write_stdin`, call `monitor` again, or `action: "cancel"`.
- A session that settles on an unseen input prompt raises an input-wait alert with or without a monitor.
- Results show rendered terminal state, not raw bytes: a running result shows unseen history plus the current screen, a finished one its final screen. `terminal_url` gives retained history or a full-screen program's screen, `/screen` the active text, `/screen.png` colours and styles; raw bytes stay in `log_path`.
