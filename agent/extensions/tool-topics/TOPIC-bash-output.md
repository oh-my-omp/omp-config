---
tool: bash
name: output
title: Output, exit codes and truncation
when: when output was truncated or minimized, or before handling a non-zero exit, timeout or cancellation
upstream: pi-coding-agent@18.13.2 src/tools/bash.ts, src/exec/bash-executor.ts, omp://tools/bash.md § Outputs, § Limits & Caps, § Notes
---
# Output, exit codes and truncation

- stdout and stderr are merged. A command that printed nothing returns `(no output)`.
- About 50 KiB is kept inline: past that, the result keeps the first and last ~20 KiB and links the full stream as `artifact://<id>`. Read the artifact (line selectors apply) instead of re-running with `head`/`tail`. If the artifact could not be saved, the result says the capture is incomplete.
- Output may be minimized for known noisy programs; the footer `[raw output: artifact://<id>]` points to the lossless original.
- Lines longer than 768 characters are cut in streaming previews only.
- Non-zero exit: an error result ending `Command exited with code <n>`; `details.exitCode` holds it.
- Timeout: an error result with `details.timedOut: true`, not a success. Raise `timeout` (or move the work to `xd://exec_command`) rather than retrying unchanged.
- Cancellation surfaces as an abort error; `Command failed: missing exit status` means the backend lost the process.
