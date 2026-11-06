# omp-config

[English](README.md) | 简体中文

## 安装

`/onboard-omp` 是 omomp 的安装入口。先安装 [Oh My Pi（`omp`）](https://github.com/can1357/oh-my-pi)，再克隆本仓库并在仓库根目录启动 `omp`：

```bash
git clone https://github.com/oh-my-omp/omp-config.git
cd omp-config
omp
```

在 `omp` 会话中运行：

```text
/onboard-omp
```

agent 默认先只读了解你已有的规则与 skills，用你的语言讲清 omomp 能替代什么、增加什么，并帮助你选择定制。你明确要求安装 omomp 后，agent 才会适配配置并通过 `/update-omp` 流程应用到本机；单独运行 `/onboard-omp` 不会安装配置。诊断、更新与同步见[安装、同步与维护](docs/operations.zh-CN.md#常用维护操作)。

## 设计

omomp 的完整定制面向高能力主 agent：编排和监督机制增强其执行能力，为任务质量提供保障；同样的要求对低能力主 agent 是沉重负担。个人与领域规则有意留给用户。入门先从本机已有的全局规则和 skills 出发，讲清哪些语义约束可以由 omomp 机制承担、还能增加什么能力，再以组件介绍补充理解。

本仓库的配置围绕以下设计取舍展开：

1. **消除 system prompt 内部的重复与前后矛盾。** 非空壳 harness 在基础模板、内置工具说明与子代理包装层中自带的预定义文本极易与用户规则重复或冲突，而模型遇到前后矛盾的提示词时会直接忽略。依托 Pi 系（含 `omp`）的 Handlebars 模板、personality 槽位与追加提示词，本仓库从 `SYSTEM_TEMPLATE.md` 中剔除重复的工具说明；[`tool-topics`](docs/extensions.zh-CN.md#tool-topics) 只把 OMP 自身工具的说明压到常用调用说明加 `Topics` 索引，详细调用说明按需读取 `tool://<tool>/<topic>`（扩展与插件工具保留各自说明）；[`system-prompt-replace`](docs/prompts-and-context.zh-CN.md#system-prompt-replace) 做其余措辞级修改（如移除原生子代理禁用 Todo 的冲突句子），使每条规则只出现一次且前后一致。扩展保持 OMP 的 system prompt 与工具定义为 OMP 构建的原样，把各自的定制作为[增量消息](docs/prompts-and-context.zh-CN.md#提示词文件)追加到对话中：OMP 在每次 prompt 结束后丢弃钩子对 system prompt 的改写，agent 发起的轮次也不经过钩子，改写只到达部分请求，每次出现或消失都重写提示缓存；已投递的增量则一直留在历史里。
2. **文件读写固定使用 `read` + hashline `edit`，并以工具失范作为 system prompt 偏离的触发信号。** 允许用 `eval` 或 shell 组合命令检索和修改文件，会让模型跳过目标行周围的上下文直接按匹配结果修改；在长任务中读取邻近上下文增加的 token 占比很小，而在缺少编译器与测试保护的配置、脚本和命令行操作中，脱离上下文的修改容易造成破坏，因此配置启用 `edit.mode: hashline`（修改前须经非 `:raw` `read` 获取行快照标签）并禁止在 `eval` 中检索本地文件。同时，包括 Claude Opus 在内的前沿模型在长会话中普遍会逐步忽略静态 system prompt；[`tool-policy-nag`](docs/extensions.zh-CN.md#tool-policy-nag) 以工具调用不规范作为可观测信号，在违规调用执行完后，把以直接观察措辞写成的提醒附在这次调用的结果上（developer 角色的上下文消息），借此提醒模型重新遵守整个 system prompt，同时不打断这一轮里仍在运行的其他调用。其启发式检测刻意保持较高误报率：对触发后的 thinking 块逐条检查表明，误报除消耗少量自检思考 token 外未观察到负面影响。回合中途与结束状态另由 [`watchdog-agent`](docs/extensions.zh-CN.md#watchdog-agent) 与 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge) 抽查。
3. **推迟有损上下文压缩，并保留已确认的约束。** 长会话上下文除文件内容外，还记录已与用户确认的需求边界与排除方案，过早压缩或截断命令输出会丢失这些前提。配置将压缩方式按信息损耗从低到高排列（`remote → soft → snapcompact → handoff → shake`），关闭提前 32k token 的后台预摘要（`compaction.asyncEnabled: false`），通过 [`model-compaction`](docs/prompts-and-context.zh-CN.md#model-compaction) 按模型调整触发阈值，并在子代理需要完整对话背景时使用 [`fork-task`](docs/prompts-and-context.zh-CN.md#fork-task) 复制当前分支。
4. **[`omp-todo-more`](https://github.com/oh-my-omp/omp-todo-more#readme) 拥有 Todo 与 `ctx`；`config.yml` 关闭原生 Todo（`todo.enabled: false`）。** 工具文档：`xd://todo`、`xd://ctx`。
5. **子代理（subagent）按模型互补、多订阅分摊与职责边界划分。** 一是以少量调用延迟换取不同模型的特性互补（如 `gpt-*-sol` 偏稳健保守、`gpt-*-luna` 成本低、`claude-opus` 适合发散设计），收敛单一模型的推理偏差；二是将各档位与回退链分布到不同订阅与免费渠道（`anthropic`、`openai-codex`、`opencode-go`、`bansos`），分摊调用以降低综合成本；三是区分任务执行与角色边界——主代理编写派工 prompt 时会将自身假设带入子代理，因此执行侧不设预设人设或固定工作流节点（禁用 `scout`、`reviewer` 等内置子代理），统一由主代理编排无状态的 `task:high/mid/low/free` 执行器，并在派发与交付时由 [`task-split-check`](docs/extensions.zh-CN.md#task-split-check)、[`isolation-nudge`](docs/extensions.zh-CN.md#isolation-nudge) 与 [`task-completion-judge`](docs/extensions.zh-CN.md#task-completion-judge) 校验；非 `task` 子代理仅用于需要隔离职责边界的场景（使顾问既不受主代理转述偏差主导，也不替代主代理决策），通过 [`user-prompt-inject`](docs/agents.zh-CN.md#user-prompt-inject) 注入根会话用户消息、`discuss:*` 限制只读工具、`mentor:default` 移除全部工具来约束边界，因此只设 `discuss:steady`、`discuss:divergent` 与 `mentor:default` 这几个角色。

## 文档

| 页面 | 内容 |
|---|---|
| [提示词与上下文](docs/prompts-and-context.zh-CN.md) | 提示词分层（`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、`tool-topics`、`system-prompt-replace`、`append-system-model`、`argon-long-output`、`repo-rules`）与上下文保留（`fork-task`、`model-compaction`） |
| [子代理](docs/agents.zh-CN.md) | 可选 worker/顾问定义与内部 `fork:self`、模型绑定、顾问上下文、派发规则与 worktree 隔离 |
| [本地扩展](docs/extensions.zh-CN.md) | 全部本地扩展总表，以及派发/交付检查（`isolation-nudge`、`task-split-check`、`task-completion-judge`）与估算子代理剩余可派发次数的 AI 侧 `/usage`（`subagent-usage`）、`JUDGE` 判定扩展（`tool-policy-nag`、`watchdog-agent`、`turn-judge`、`lang-nag`）、bash 与 eval 删除拦截和只收字面路径的 `delete` 工具（`delete-guard`）与宿主/TUI 扩展 |
| [插件与运行模式](docs/plugins-and-modes.zh-CN.md) | `install-plugins.sh` 中的外部插件（`omp-todo-more`、`omp-sessions`、`omp-thinking-translator` 等）以及 `omp` 与 `omp-light` 的差异 |
| [安装、同步与维护](docs/operations.zh-CN.md) | 仓库与本机的文件归属、`/onboard-omp`、`/update-omp`、`/sync-omp-config`、`omp-config-autoupdate`、`_shared` 模块与升级检查 |
| [配置检查（`ci/README.zh-CN.md`）](ci/README.zh-CN.md) | `bun ci/check.ts` 如何安装 `omp`、应用配置、接入免费模型与影子代理并去重报告故障 |
| [测试沙箱（`sandbox/README.zh-CN.md`）](sandbox/README.zh-CN.md) | `bun sandbox/sandbox.ts` 如何用本机 `~/.omp` 配置、凭据与工作树建一次性容器，按模型驱动真实会话，并删除和登记每次运行 |
| [`extensions-last`（`agent/extensions-last/README.zh-CN.md`）](agent/extensions-last/README.zh-CN.md) | 扩展加载顺序，以及 `system-prompt-replace` 放在 `agent/extensions/` 之外的原因 |
| [子代理编写说明（`agent/agents/README.zh-CN.txt`）](agent/agents/README.zh-CN.txt) | 子代理 frontmatter、`spawns` 白名单、depth 2 递归上限与 `yield` 常见陷阱 |

## 常用命令

在仓库根目录启动 `omp` 后运行的斜杠命令：

```text
/onboard-omp [check|<plane>]                 # 安装引导：讲清配置取舍，明确要求后适配并安装
/update-omp [check]                          # 仓库工作区 -> ~/.omp/agent、omp-light 与插件；保留本机定制并当场适配冲突
/sync-omp-config [check]                     # 本机受管改动 -> 仓库（按字段比对修改、校验、提交并推送）
/omp-config-autoupdate [status|on|off|run|adapt|conflicts notify|agent]
                                             # 启动自动更新开关（默认关）、立即从 GitHub 拉取更新，或适配与上游冲突的本机定制
/migrate-omp-keys <target>                   # 经 SSH 将本机 auth_credentials 表复制到远端主机 agent.db
```

在仓库根目录运行的终端命令：

```bash
omp                           # 完整模式
omp-light                     # 轻量模式（跳过 config-light.yml 列出的治理扩展）
bun run check                 # biome check . && tsc --noEmit
bun run test                  # bun test ci：delete-guard、tool-policy-nag pty 与更新器三方应用测试
./plugin-audit.sh             # 只读比对 install-plugins.sh 与 `omp plugin list`
bun ci/check.ts               # 隔离 HOME 安装 + 免费模型跑完整模式与轻量模式 RPC 会话检查
```
