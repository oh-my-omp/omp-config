# omp-config

[English](README.md) | 简体中文

这套配置围绕长任务里反复遇到的四个问题组织：

1. **光靠 system prompt 约束不住长任务里的跑偏。** 模型写着写着就会用 `cat`/`sed -i`/`rg` 绕开内置的 `read`/`edit`/`grep`；一旦工具约定失守，`CLAUDE.md` 里的项目规则往往也跟着失效。因此能由运行时检查的都不只靠提示词：改文件前必须先拿到 `read` 的 hashline 快照（`edit.mode: hashline`），主会话的 shell 和 eval 调用由 `bashInterceptor` 与 [`tool-policy-nag`](docs/extensions.zh-CN.md#tool-policy-nag) 检查，执行中途和回合结束由 [`watchdog-agent`](docs/extensions.zh-CN.md#watchdog-agent) 与 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge) 抽查。
2. **长任务的上下文里存着已和用户确认的需求边界与排除项，不只是文件缓存。** 发生上下文压缩（compaction）、用 `grep` 局部匹配代替通读设计文档，或用 `head`/`tail` 截断命令输出，都会丢掉已经对齐的前提。配置将压缩方式按损耗从低到高排序，关闭提前 32k token 的后台预摘要（`compaction.asyncEnabled: false`），用 [`model-compaction`](docs/prompts-and-context.zh-CN.md#model-compaction) 调高大窗口模型的压缩阈值；子代理需要完整背景时用 [`fork-task`](docs/prompts-and-context.zh-CN.md#fork-task) 直接复制当前对话。
3. **`todo`（[`omp-todo-more`](docs/plugins-and-modes.zh-CN.md#todo-more)）是介于常规会话与 `/goal` 之间的内置工具。** 它吸收了 `/goal` 对目标与完成条件的督促性质（仍有未完成项且无须用户拍板时自动催促继续），但比 `/goal` 更灵活，允许在执行过程中随时调整阶段、任务、预估耗时与阻塞状态。任务状态推进与 `DONE` 提交共同构成逻辑上的 checkpoint，并在跨 compact 轮次时由 `omp-todo-more` 将 Todo 状态、[`Task log`](docs/prompts-and-context.zh-CN.md#task-log) 与 [`ctx`](docs/prompts-and-context.zh-CN.md#ctx) 子代理树重新注入上下文。GPT 主代理在任务未做完时只输出文字就结束回合，则由 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge)（`TURN-JUDGE-gpt-talk-only.md`）打回继续调用工具。
4. **子代理（subagent）围绕模型互补、跨订阅降本与角色边界三点设计。** 第一，借由不同子代理轻微牺牲一点运行时长，让不同模型取长补短（如 GPT `sol` 的保守、`luna` 的廉价、Claude Opus 的发散设计），把不同模型在思路上的差异控制在较小范围内；第二，将各档位分散绑定到不同订阅与免费渠道（`anthropic`、`openai-codex`、`opencode-go`、`bansos`），压低综合成本；第三，不把子代理做成固定工作流节点或人类视角的角色扮演（禁用 `scout`、`reviewer` 等全部内置角色）：大多数模型在写给子代理的 prompt 中都会把自身思路传染过去，本质只是工作外包，因此通用执行直接采用 Claude Code 式的即用即走 `task` 执行器（仅按成本与可信度分为 `task:high/mid/low/free`），具体做什么由更强的主代理自行编排，派发前与交回前由 [`task-split-check`](docs/extensions.zh-CN.md#task-split-check)、[`isolation-nudge`](docs/extensions.zh-CN.md#isolation-nudge) 与 [`task-completion-judge`](docs/extensions.zh-CN.md#task-completion-judge) 检查。真正预定义的非 `task` 角色只为守住职责边界而设（如咨询角色不能被主代理牵着鼻子走，也不能替代主代理做判断），而守住边界不能只靠写一段角色 prompt，必须配合 [`user-prompt-inject`](docs/agents.zh-CN.md#user-prompt-inject) 直注用户原话、`discuss:*` 只读工具限制与清空 `mentor:default` 全部工具等机制，因此非 `task` 角色只保留 `discuss:steady`、`discuss:divergent` 与 `mentor:default` 三个。

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
