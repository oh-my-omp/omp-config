# omp 测试沙箱

[English](README.md)

`sandbox/` 在本机 OrbStack 上建一个一次性 Linux 容器，在里面用本机 `~/.omp` 配置与凭据的副本和待测的 omp-config 工作树跑真实的 `omp` 会话。不能在宿主机上试的改动在这里验证，例如可能拦不住 `rm -rf "$X"/…` 的删除拦截：改动出错时受影响的只有容器；运行结束时，容器、网络连同其中的凭据副本一起删除。

沙箱运行在装有 OrbStack（或其他 Docker 引擎）的 macOS 上，宿主机需要 `bun`、`git` 与 `tar`。CI 不使用沙箱：凭据不进公开仓库的 CI。

## 命令

```bash
bun sandbox/sandbox.ts hold [--target] [--repo DIR]                          # 建好后保持，收到 SIGINT/SIGTERM 时删除
bun sandbox/sandbox.ts run [--target] [--repo DIR] SCENARIO_JSON MODEL...   # 建好，对每个模型跑一遍场景，删除
bun sandbox/sandbox.ts matrix RUN SCENARIO_JSON MODEL...                     # 在保持中的沙箱里跑场景
bun sandbox/sandbox.ts down RUN                                              # 删除持有进程被杀后遗留的运行
```

- `--repo` 默认是 `sandbox/` 所在的 checkout。`--target` 增加 ssh 目标机。
- `hold` 打印运行 id 与接入命令，然后等待。交互会话用 `docker exec -it -w /work omp-sandbox-<run> omp --model <provider>/<model>`；agent 经 `exec_command` 驱动这条命令。用 Ctrl-C 或 SIGTERM 结束持有进程并等它退出：清理需要几秒。持有进程跑在 `exec_command` 会话里时，发送 Ctrl-C（`write_stdin` 发 `\u0003`），不要用 `kill_session`：它 2 秒后升级为 SIGKILL，会打断清理。
- `run` 在每个模型都通过或未测时退出 0，否则退出 1。`matrix` 相同。
- `down` 只用于没有走到 `finally` 就退出的持有进程（SIGKILL、宿主机崩溃），删除带该运行标签的全部资源。

## 一次运行包含什么

| 资源 | 内容 |
|---|---|
| 网络 `omp-sandbox-<run>-net` | 最先创建、最后删除。用户自定义 bridge：容器可以出网，也能按名称互相访问。 |
| 容器 `omp-sandbox-<run>` | `oven/bun:latest` linux/arm64（每次运行都拉取，不钉版本），`--init`，`HOME` 与宿主机家目录路径相同，复制来的配置里的绝对路径因此原样有效。另装 `git`、`openssh-client`、`python3`、`zsh`、`jq`、`sqlite3`、`procps`。不发布端口，不挂卷、bind mount 或 docker socket。 |
| 容器 `omp-sandbox-<run>-target`（`--target`） | `debian:stable-slim`，装 `openssh-server` 与 `python3`。沙箱每次运行在 `$HOME/.ssh` 下新生成 ed25519 密钥，目标机为 `root` 信任它；沙箱内的 `/etc/ssh/ssh_config.d/omp-sandbox-target.conf` 把目标机命名为 `target`：`ssh target …`（ssh 从 passwd 家目录 `/root` 读 `~/.ssh`，不看 `$HOME`）。 |

三者都带标签 `omp-sandbox.run=<run>`，清理时按这个标签查找。

内容以 tar 流或经 stdin 管道进入 `docker exec`，宿主机磁盘上不暂存任何含凭据的东西：

- `~/.omp/agent`，不含 `sessions/`、`blobs/`、`terminal-sessions/`、`custom-session-files/`、`predict/`、`cache/`、`history.db*`、锁文件与 `agent.db*`。`~/.omp/logs` 不复制。
- `agent.db`：对宿主机数据库的只读连接做 SQLite 序列化。序列化在同一个读事务内完成，因此包含尚未 checkpoint 的 WAL 帧。镜像被标成回滚日志库（头部第 18–19 字节），逐字节写入容器，在容器内改回 WAL，再执行 `integrity_check`。随后宿主机读回容器内的副本，在内存里与快照逐表、逐行、逐字段比较，任何差异都让构建失败。只打印表名、行数与「every field equal」，从不打印值或摘要。
- `~/.omp/plugins`，不含 `node_modules/`（为 macOS 构建）；容器内 `bun install` 按锁文件为 Linux 装同样的版本。
- `~/.claude/rules`、`~/.claude/skills`、`~/.claude/CLAUDE.md`，存在才复制。
- 工作树放到 `/repo`：已跟踪与未跟踪的文件，含未提交改动，不含被忽略的文件。

之后容器安装最新的 `@oh-my-pi/pi-coding-agent`，并运行 `/repo` 里的 updater（`omp-config-update.ts apply --source /repo`），容器 agent 目录中的扩展因此来自工作树，而不是宿主机上次应用的版本。

### 凭据

凭据副本原样使用：不改写、不刷新、不筛选，模型绑定与宿主机配置相同。某个模型在沙箱里调用不成功时记为未测，沙箱不排查原因。若某个服务商会轮换 refresh token，沙箱内的会话刷新它之后，宿主机那份可能失效；沙箱不防范这一点。

## 场景与 RPC 驱动

`matrix` 与 `run` 把场景文件复制进容器，并对每个模型在容器内运行一次 `sandbox/driver.ts`：每次一个新的 `omp --mode rpc --no-ui --model <model>` 会话，工作目录在 `/runs/` 下且各不相同。场景文件是 JSON：

| 字段 | 含义 |
|---|---|
| `name` | `[a-z0-9][a-z0-9._-]*`；用作证据文件名 |
| `init` | 会话前由驱动执行（不经 agent）的 sh 命令，须退出 0；每个模型前都重新执行 |
| `prompt` | 唯一的一条用户消息 |
| `finalAssertion` | 会话结束后执行的 sh 命令；退出 0 即通过 |
| `calls.expect` | 必须按此顺序出现在工具调用中的匹配器（子序列） |
| `calls.forbid` | 任何工具调用都不得满足的匹配器 |
| `replyIncludes` | 最后一条助手回复必须包含的字面串 |

匹配器是 `{ "tool", "isError"?, "inputPattern"?, "resultIncludes"? }`：`inputPattern` 是作用于调用 JSON 输入的正则表达式，`resultIncludes` 是结果文本中的字面串。驱动只检查场景声明的内容，自己不附加任何含义。[`scenarios/echo-hi.json`](scenarios/echo-hi.json) 是最小示例。

一个场景对一个模型的运行，结果是以下四种之一：

| 结果 | 条件 |
|---|---|
| `pass` | 所有断言成立 |
| `fail` | 会话完成，但有断言不成立 |
| `untested` | omp 不认识该模型（`Model "…" not found`），或所有助手回复都在服务商处失败且没有运行任何工具 |
| `harness-error` | `init` 失败、omp 因其他原因在 ready 帧之前退出、prompt 被拒绝、会话超过 600 秒上限、omp 以非零退出，或 omp 没有报告会话文件 |

证据写到 `/tmp/omp-sandbox-<run>/evidence/<provider>_<model>/`：`<name>.driver.json`（结果、每次工具调用的输入、`isError` 与结果前 400 字符、终态断言输出、最后一条回复）、`<name>.events.jsonl`（每个 RPC 帧）与 `<name>.session.jsonl`（omp 报告的会话文件）。宿主机对每个模型只复制这三个文件；`agent.db` 与 `models.yml` 不离开容器。事件与会话文件包含模型看到的一切，所以场景不得读取凭据文件。

## 生命周期与台账

OrbStack 台账是目录 `~/Ext/work/orbstack/`；沙箱运行在其中有自己的文件 `omp-sandbox.md`。`hold` 与 `run` 在创建任何资源之前写入本次运行的一行（状态「进行中」），台账目录不存在时拒绝启动。构建、场景或等待信号都在 `try` 中进行；`finally` 删除本次运行的容器与网络，打印按 `name=omp-sandbox-<run>` 过滤的 `docker ps -a` 与 `docker network ls`，并原地改写同一行：「已完成、已清理」并附删除记录与空的列表结果，或「清理失败」并附残留（命令随后以 1 退出）。`down` 以同样方式改写该行。

被 SIGKILL 的持有进程会让该行停在「进行中」、资源留在原处；`down <run>` 删除它们。

## 规则

- 容器隔离的是宿主机文件，不是远端服务：会话持有真实凭据并可以出网。不要写会作用于不该被改动的远端系统或账号的场景。
- 一次运行一个沙箱，运行不复用。运行 id 是构建时间的 36 进制表示。
- `sandbox/*.ts` 保持自包含：容器内的 `/sandbox` 是本目录的副本，`driver.ts` 与 `db.ts` 只靠 Bun 在那里运行。
