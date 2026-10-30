---
tool: bash
name: policy
title: Blocked commands, deletion and approval
when: after a command returned `Blocked:` or a `delete-guard:` error, or before deleting files or running a destructive command
upstream: pi-coding-agent@18.14.0 src/tools/bash.ts, src/tools/bash-interceptor.ts, src/tools/approval.ts, src/tools/settings.ts, src/exec/settings.ts; agent/config.yml bashInterceptor; agent/extensions/delete-guard
---
# Blocked commands, deletion and approval

- `Blocked: <message>` means the command matched a routing rule and never ran. Redo the work with the tool the message names. Routes in this setup:
  - `cat`/`head`/`tail`/`less`/`more` on files (not `tail -f`) → `read`
  - `grep`/`rg`/`ag`/`ack` → `grep`
  - in-place `sed -i`/`perl -i`/`awk -i inplace` → `edit`
  - in-place `sed -i`/`perl -i`/`awk -i` → `edit`
  - `echo`/`printf`/`cat <<` redirected into a file → `write`
- Routing checks each `&&`/`||`/`;`/`|` segment; a stage reading piped stdin (`… | grep x`) is not routed.
- Deleting files: call the `delete` tool with literal paths and leave `mode` unset; the default moves them to the system trash. Set `mode: "permanent"` (unrecoverable) only when the user explicitly asks for unrecoverable deletion; "delete", "remove", "clean up" or a request phrased as `rm -rf` is not such a request. A permanent call still asks the user to confirm, and a subagent or headless run cannot get that confirmation. Bash never deletes: a call containing `rm`, `unlink`, `rmdir`, `shred`, `find -delete` or `find -exec rm` anywhere it would run (also after `sudo`/`env`/`xargs`/`timeout`…, inside `$(…)`, `sh -c '…'`, `eval`, `trap`) is refused with a `delete-guard:` error and does not run, whatever its arguments. The same holds inside `powershell`/`pwsh -Command` (`Remove-Item` and its aliases, `[IO.File]::Delete`, `.Delete(`) and `cmd /c` (`del`, `erase`, `rd`, `rmdir`). Arguments that only mention these words (`echo rm`, `git rm`) are fine.
- `delete-guard:` also refuses commands it cannot read: a command name from a variable or substitution (`$CMD x`, `%X%`), a non-literal `sh -c "$s"` / `eval "$s"`, `iex` / `Invoke-Expression`, `-EncodedCommand`, or a script piped into a shell (`… | sh`). Write the command out literally.
- `eval` cells are judged the same way before they run: deletion APIs (`shutil.rmtree`, `os.remove`, `Path(…).unlink()`, `fs.rmSync`/`unlinkSync`, `Bun.file(…).delete()`, …) and shell handoffs carrying a deletion or a non-literal command (`subprocess`, `os.system`, `!cmd`, `%%bash`, `child_process`, `Bun.$`, `Bun.spawn`, `tool.bash`) are refused with a `delete-guard:` error. Use the `delete` tool instead.
- Approval does not protect you: under the default `tools.approvalMode` (`yolo`) even high-risk commands run without asking. Ask the user before destructive work.
