---
tool: read
name: ssh
title: Reading remote files over SSH
when: before reading a file or directory on a remote host
upstream: pi-coding-agent@18.13.2 src/internal-urls/ssh-protocol.ts, src/prompts/internal-urls/ssh.md, src/tools/read.ts
inject:
  - id: read-ssh
    tool: read
    parameter: path
    pattern: '^ssh://'
  - id: eval-ssh-cat
    tool: eval
    parameter: code
    pattern: '\bssh\b[^\n;|&]*\bcat\b'
  - id: bash-ssh-cat
    tool: bash
    parameter: command
    pattern: '\bssh\b[^\n;|&]*\bcat\b'
---
# Reading remote files over SSH

- Bare `ssh://` lists configured hosts. `ssh://host/<absolute path>` reads a UTF-8 file or a one-level directory listing; any OpenSSH destination works (`~/.ssh/config` aliases, `user@host:2222`, `[::1]`), with key/agent auth only and a POSIX remote shell.
- `ssh://host/~/path` and `ssh://host/~` use the remote account's HOME, never the local one; `/%7E/` stays literal, `/~user` is unsupported, no other shell expansion happens.
- Percent-encode `:`, `?`, `#` in the path (`%3A`, `%3F`, `%23`).
- Line selectors apply; `?q=` jq queries run locally on the fetched text (`ssh://host/tmp/data.json?q=.items&limit=2`).
- Limit 1 MiB per file or listing; binary, non-UTF-8 and special files fail. For those, or larger files, mount with sshfs or open a remote shell; `bash` refuses `ssh` passthrough while the PTY tool is active. Do not `ssh host cat file` for text: read it here.
- A configured alias cannot take a different user or port; malformed hosts, ports or userinfo with passwords are errors.
xd://exec_command
