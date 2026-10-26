# omp-config

[English](README.md) | 简体中文

这套配置围绕长任务里反复遇到的四个问题组织：

1. **光靠 system prompt 约束不住长任务里的跑偏。** 模型写着写着就会用 `cat`/`sed -i`/`rg` 绕开内置的 `read`/`edit`/`grep`；一旦工具约定失守，`CLAUDE.md` 里的项目规则往往也跟着失效。因此能由运行时检查的都不只靠提示词：改文件前必须先拿到 `read` 的 hashline 快照（`edit.mode: hashline`），主会话的 shell 和 eval 调用由 `bashInterceptor` 与 [`tool-policy-nag`](docs/extensions.zh-CN.md#tool-policy-nag) 检查，执行中途和回合结束由 [`watchdog-agent`](docs/extensions.zh-CN.md#watchdog-agent) 与 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge) 抽查。
2. **长任务的上下文里存着已和用户确认的需求边界与排除项，不只是文件缓存。** 发生上下文压缩（compaction）、用 `grep` 局部匹配代替通读设计文档，或用 `head`/`tail` 截断命令输出，都会丢掉已经对齐的前提。配置将压缩方式按损耗从低到高排序，关闭提前 32k token 的后台预摘要（`compaction.asyncEnabled: false`），用 [`model-compaction`](docs/prompts-and-context.zh-CN.md#model-compaction) 调高大窗口模型的压缩阈值；子代理需要完整背景时用 [`fork-task`](docs/prompts-and-context.zh-CN.md#fork-task) 直接复制当前对话。
3. **`todo`（[`omp-todo-more`](docs/plugins-and-modes.zh-CN.md#todo-more)）是介于常规会话与 `/goal` 之间的内置工具。** 它吸收了 `/goal` 的督促性质（携带 `objective`/`measure`/`doneWhen`、未列计划前拦截 `edit`、仍有未完项且无须用户拍板时自动催促继续），但比 `/goal` 更灵活，支持在执行过程中随时调整目标、阶段、说明、预估耗时与阻塞状态。每完成一项（`DONE`）都会关联一次 git commit 并记入分支快照与 [`Task log`](docs/prompts-and-context.zh-CN.md#task-log)，形成逻辑上的 checkpoint，并在跨 compact 轮次时自动把 [`ctx`](docs/prompts-and-context.zh-CN.md#ctx) 子代理树与任务时间线重新注入上下文。GPT 主代理在任务未做完时只输出文字就结束回合，则由 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge)（`TURN-JUDGE-gpt-talk-only.md`）打回继续调用工具。
4. **会写代码不等于能做架构判断或守住任务边界。** 全局架构、领域类型、跨模块接口和最终验证留在主会话，边界清楚的实现和调查切片交给按成本与可信度分档的自定义子代理（`task:high`、`task:mid`、`task:low`、`task:free`，禁用全部内置子代理）。派发前由 [`task-split-check`](docs/extensions.zh-CN.md#task-split-check) 和 [`isolation-nudge`](docs/extensions.zh-CN.md#isolation-nudge) 检查多主题塞单、报告字数限制与并行写目录隔离；子代理交回前由 [`task-completion-judge`](docs/extensions.zh-CN.md#task-completion-judge) 核对派工要求、工具记录和 Todo 状态。为避免顾问只看到调用方裁剪过的转述而顺着偏差给建议，[`user-prompt-inject`](docs/agents.zh-CN.md#user-prompt-inject) 会把根会话里的用户原话直接塞进 `mentor:default`、`discuss:steady` 与 `discuss:divergent` 的请求，同时清空 `mentor:default` 的工具，逼调用方写出具体文件路径与实测结果。

## 文档

| 页面 | 内容 |
|---|---|
| [提示词与上下文](docs/prompts-and-context.zh-CN.md) | 提示词分层（`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、`system-prompt-replace`、`append-system-model`、`repo-rules`）与上下文保留（`fork-task`、`model-compaction`、`ctx`、`Task log`） |
| [子代理](docs/agents.zh-CN.md) | `agent/agents/*.md` 中的 7 个自定义子代理、模型绑定、顾问配置（`user-prompt-inject`、`discuss:steady` / `discuss:divergent`、`mentor:default`）、派发规则与 worktree 隔离 |
| [本地扩展](docs/extensions.zh-CN.md) | 22 个本地扩展总表，以及派发/交付检查（`isolation-nudge`、`task-split-check`、`task-completion-judge`）、`JUDGE` 判定扩展（`tool-policy-nag`、`watchdog-agent`、`turn-judge`、`lang-nag`）与宿主/TUI 扩展 |
| [插件与运行模式](docs/plugins-and-modes.zh-CN.md) | `install-plugins.sh` 中的外部插件（`omp-todo-more`、`omp-thinking-translator` 等）以及 `omp` 与 `omp-light` 的差异 |
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
