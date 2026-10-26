# omp-config

[English](README.md) | 简体中文

`omp-config` 存放 Oh My Pi（`omp`）纳入版本管理的配置：设置文件（`agent/config.yml`、`agent/config-light.yml`、`agent/omomp.yml`、`agent/thinking-translator.json`、`pi/agent/pi-bansos-relay-state.json`）、系统提示词文件（`agent/SYSTEM_TEMPLATE.md`、`agent/PERSONALITY.md`、`agent/APPEND_SYSTEM.md`、`agent/APPEND_SYSTEM_LIGHT.md`）、子代理定义（`agent/agents/*.md`）、本地 TypeScript 扩展（`agent/extensions/`、`agent/extensions-last/`）以及插件安装清单（`install-plugins.sh`）。

运行期产生的文件留在本机，不进仓库：数据库（`*.db*`）、会话记录、模型缓存（`models.yml`、`commandcode-models.json`）、日志、锁文件、已安装的插件包（`~/.omp/plugins/`）和供应商凭据。

## 文档

| 页面 | 内容 |
|---|---|
| [提示词与上下文](docs/prompts-and-context.zh-CN.md) | `SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、`system-prompt-replace`、`append-system-model`、`repo-rules`、`fork-task`、`model-compaction`、`ctx` 与任务日志 |
| [子代理](docs/agents.zh-CN.md) | `agent/agents/*.md` 中的 7 个自定义子代理、模型绑定、`user-prompt-inject`、派发规则与 worktree 隔离 |
| [本地扩展](docs/extensions.zh-CN.md) | 22 个本地扩展的索引表，以及派发/交付检查、`JUDGE` 判定扩展与宿主/TUI 扩展说明 |
| [插件与运行模式](docs/plugins-and-modes.zh-CN.md) | `install-plugins.sh` 中的插件（`omp-todo-more`、`omp-thinking-translator` 等）以及 `omp` 与 `omp-light` 的差异 |
| [安装、同步与维护](docs/operations.zh-CN.md) | 仓库与本机的文件归属、`/update-omp`、`/sync-omp-config`、`omp-config-autoupdate`、`_shared` 模块与升级检查 |
| [配置检查（`ci/README.zh-CN.md`）](ci/README.zh-CN.md) | `bun ci/check.ts` 如何安装 `omp`、应用配置、接入免费模型与影子代理并去重报告故障 |
| [`extensions-last`（`agent/extensions-last/README.zh-CN.md`）](agent/extensions-last/README.zh-CN.md) | 扩展加载顺序，以及 `system-prompt-replace` 放在 `agent/extensions/` 之外的原因 |
| [子代理编写说明（`agent/agents/README.zh-CN.txt`）](agent/agents/README.zh-CN.txt) | 子代理 frontmatter、`spawns` 白名单、depth 2 递归上限与 `yield` 常见陷阱 |

## 常用命令

在仓库根目录启动 `omp` 后运行的斜杠命令：

```text
/update-omp [check]                          # 仓库工作区 -> ~/.omp/agent、~/.pi/agent、omp-light 与插件
/sync-omp-config [check]                     # 本机受管改动 -> 仓库（按字段比对修改、校验、提交并推送）
/omp-config-autoupdate [status|on|off|run]   # 查看或切换启动自动更新开关（默认关），或立即从 GitHub 拉取更新
/migrate-omp-keys <target>                   # 经 SSH 将本机 auth_credentials 表复制到远端主机 agent.db
```

在仓库根目录运行的终端命令：

```bash
omp                           # 完整模式
omp-light                     # 轻量模式（跳过 10 个扩展与 system-prompt-replace）
bun run check                 # biome check . && tsc --noEmit
./plugin-audit.sh             # 只读比对 install-plugins.sh 与 `omp plugin list`
bun ci/check.ts               # 隔离 HOME 安装 + 免费模型跑完整模式与轻量模式 RPC 会话检查
```
