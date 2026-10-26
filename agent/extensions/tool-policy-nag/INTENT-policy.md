---
# Intent spec for tool-policy-nag's intent lane: one `choice` question per
# watched call. The body below is the judge's instructions; every entry under
# `options` is one option — `rubric` is what the judge reads, `title` and `tool`
# are how the reminder names the intent and the tool it needs.
#
# A picked option is a violation for a shell call unless it is `none`, and for
# an eval call unless it is `eval` or `none`.
#
# TOOL ROUTING ONLY. Every option asks which built-in tool should have done this
# call's work; `mixed` is the case where the call reassembles more than one
# tool's operation. How big, chained or destructive a call is does not decide
# anything here: a long line that downloads, checksums, greps and writes files
# is `none` when every step belongs to the shell. Judging that call's
# side-effect surface is the risk lane's job, not this question's.
#
# The coverage sentences in the body are this policy's statement of which
# shell forms count. The `bash` description rewritten in the
# `system-prompt-replace` section of `omomp.yml` tells the agent the same
# division (`bash` is the synchronous default shell, `exec_command` runs
# long-running, waiting or interactive programs, `eval` does language
# computation); when one changes, change the other with it.
name: tool-policy
enabled: true
options:
  list:
    title: 列目录 / 找文件
    tool: "`read <dir>` / `glob`"
    rubric: |
      The call exists to see what is there: listing directory entries or locating files by name, path or pattern, which `read <dir>` or `glob` does. Examples: `ls -la src`, `ls ~/.omp/logs | head -3`, `find . -name '*.ts'`, `ls -t | head -1`. Not: a listing word belonging to another program, or one running on another machine or in a container.
  read:
    title: 读文件内容
    tool: "`read`"
    rubric: |
      The call exists to print a local file, archive member, database row, media metadata, web page, or remote UTF-8 text reachable with `read ssh://host/path`. Examples: `cat package.json`, `head -50 log`, `sed -n '1,20p' f`, `unzip -p a.zip x.json`, `tar -xO -f b.tar x`, `sqlite3 db.sqlite 'select 1'`, `ffprobe v.mp4`, `curl -s https://example.com/page.html`, `git cat-file -p HEAD:f`, or `ssh host 'cat /etc/hosts'` on a verified POSIX host within read's 1 MiB text limit. Not: printing an external CLI's own output (`km ls actions -f json`, `agent-browser … --json`, `gh issue view --json`, `docker ps`); files inside containers, binary/oversized/non-POSIX remote sources that `ssh://` cannot read; a filter fed by another command (`cmd | jq`), watching a file grow (`tail -f`), a header-only probe (`curl -I`, `curl -fsSI`), or a repository object fetched as a revision rather than the working-tree path.
  search:
    title: 搜索文件文本
    tool: "`grep`"
    rubric: |
      The call exists to search local file contents for text or a regex, which `grep` does. Examples: `grep -rn TODO src`, `rg -n foo`, `git grep x`, `grep -c ERROR log`. Not: filtering another command's output (`cmd | grep x`), counting only, or a `grep` word belonging to another program.
  edit:
    title: 修改已有文件
    tool: "`edit`"
    rubric: |
      The call exists to change an existing file's text in place, which `edit` does against a snapshot. Examples: `sed -i 's/a/b/' f`, `perl -pi -e …`, `awk -i inplace …`, an editor in batch mode. Not: writing through a redirect or `tee` (that is `write`), or a real tool rewriting files as its own job (a formatter, a code generator, a package manager, git).
  write:
    title: 新建 / 覆盖文件
    tool: "`write`（追加到已有文件时用 `edit`）"
    rubric: |
      The call exists to put content the agent itself authored into a file, which `write` does. Examples: `echo … > f`, `printf … > f`, a heredoc into a file, `tee f` fed that content, appending agent text with `>>`. Not: redirecting or teeing a real program's own output (`npm test > log`, `strings … > f`, `ansible-playbook … > log`).
  move:
    title: 重命名 / 移动文件
    tool: "`edit` 的 `MV`"
    rubric: |
      The call exists to rename or move a file or directory, which `edit`'s `MV` does. Examples: `mv a b`, `cp a b && rm a`. Not `git mv`; not a plain copy that keeps the source (`cp -R a b` with no delete); not a `mv` word belonging to another program.
  eval:
    title: 跑脚本逻辑 / 计算
    tool: "`eval`"
    rubric: |
      The call exists to run script logic or computation that belongs in the eval kernel: `python3 - <<EOF …`, `python -c …`, `node -e …`, `bun -e …`, `deno eval …`, or eval code doing computation the shell cannot express. Not: a query or filter in its own little language (`jq`, `yq`, `awk`, `sed`, `xargs`); not running a script file that already exists in the project (`bun run build`, `bun test`).
  ast:
    title: 结构化代码搜索 / 改写
    tool: "`ast_grep` / `ast_edit`"
    rubric: |
      The call exists to find or rewrite code by syntax shape (calls with their arguments, declarations, imports, multi-line constructs) through text patterns across files, which `ast_grep` / `ast_edit` do. Not: searching for a literal identifier, string or log line.
  pty:
    title: 交互程序没有走 PTY
    tool: "`exec_command`（PTY 会话），再用 `write_stdin` 驱动"
    rubric: |
      The call exists to drive a program that waits for the terminal it is talking to through `bash` or eval instead of an `exec_command` PTY session, or fakes a terminal: a bare shell or `ssh` session with no command, a password, passphrase or host-key prompt, a REPL or database shell opened bare, a TUI, `git rebase -i`, an installer asking on stdin, or `yes |`, `expect`, `ssh -tt`, `script -q`. Not: a program that only prints and exits (`open X.app`, `agent-browser … open`, `tern capture`, `omp -p …`, a build, a test, a linter), a one-shot given a command or a redirect (`ssh host 'cmd'`, `psql -c '…'`, `docker exec` without `-it`, `bash x.sh </dev/null`), or anything running on another machine or in a container (`ssh -o BatchMode=yes host 'ls; cat x'`, `orb -m box -u root bash`, `docker exec app sh`) — this rule never applies to another machine's program.
  shell:
    title: 起进程 / 跑 shell 命令
    tool: "`bash`（长时间运行或需要终端时用 `exec_command`）"
    rubric: |
      The call exists to start an operating-system process that should run through `bash` (or `exec_command` when it runs long or needs a terminal): `subprocess.run`, `os.system`, `!cmd`, `Bun.$`, `Bun.spawn`, `child_process` in eval code. Examples: `import subprocess; print(subprocess.run(['date'], …).stdout)`, and a shell command run from eval through the harness bridge. Not: calling another harness tool through `tool.<name>(…)`; and not eval code handing the shell a command line whose own operation a built-in tool covers — that call's intent is the covered operation (`read`, `list`, …), which is why routing it through eval is the violation.
  mixed:
    title: 一次调用重拼了多个内置工具的操作
    tool: 拆开：读走 `read` / `glob` / `grep`，写走 `edit` / `write`
    rubric: |
      One call reassembles the operations of more than one built-in tool, so no single tool could have done this call's work: a search and an in-place edit (`grep -rn foo . ; sed -i 's/a/b/' f`), a read and a write (`cat a && echo … > b`), or several operations of different kinds chained together. The fix is to split it: each operation goes to its own tool (`read` / `glob` / `grep` for reading, `edit` / `write` for writing), with `bash` still running any real program among them. Not: a single operation (that is that tool's own option); and not a call that is long, chained or generated while every step belongs to the shell (that is `none` here, whatever its risk).
  none:
    title: 不走内置工具
    tool: 保持原样
    rubric: |
      None of the above: a real program or short fact pipeline doing its own job — builds, tests, linters, package managers, git, an external CLI or API, counts, checksums, a program's own output redirected to a file, container commands, remote operations other than UTF-8 text reads covered by `read ssh://`, a service probe, or anything the shell is simply the right tool for.
---

The state is one tool call made by an AI coding agent working in a repository. Its system prompt gives it the built-in tools below and forbids reassembling their operations through the shell (`bash` or `exec_command`) or the eval kernel:

`read` — file contents and line ranges, directory listings, archive members, SQLite databases, PDFs and documents, images, web pages, and `ssh://host/path`; it is a protocol for every source the agent would otherwise shell out to (`cat`, `sed -n`, `jq` on a dump, `unzip`, `ffprobe`, `curl`). `glob` — find files by name or pattern. `grep` — regex search over files. `edit` — modify an existing file, and rename or move it. `write` — create or overwrite a file. `eval` — persistent Python/JS kernel, for work that needs language semantics on data already in hand. `ast_grep` / `ast_edit` — structural code search and rewrites. `bash` — the default, synchronous shell: real binaries and short fact pipelines, such as builds, tests, package managers, git, external CLIs and APIs, counts and checksums. `exec_command` — a PTY session for programs that run long, wait on an outside condition or need a terminal, driven with `write_stdin` and watched with `monitor`.

The shell stays legitimate for anything an external program owns: a subcommand belonging to another program (`km ls actions`, `docker ps`, `kubectl get pods`, `gh pr list`, `git ls-files`, `aws s3 ls`) lists that program's own resources; a filter reshaping a stream (`cmd | jq`, `cmd | grep x`) works on bytes no built-in tool produced; a program's own output redirected to a file (`npm test > log`, `strings … > f`) writes nothing the agent authored. Remote UTF-8 files up to 1 MiB on verified POSIX hosts are reachable with `read ssh://host/path`, so `ssh host 'cat /path'` for those files is a read operation; other remote operations, unsupported remote sources, and commands inside containers (`docker exec`, `kubectl exec`, `qm guest exec`, `orb -m`) still belong to the shell. A program that only prints and exits (`open X.app`, `agent-browser … open`, `omp -p …`, a build, a test, a linter) needs no terminal.

Say which option below is the intent of this call — what the call is trying to accomplish, not the words it happens to use. One option exactly.
