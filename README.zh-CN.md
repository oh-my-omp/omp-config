# omp-config

[English](README.md) | 简体中文

本仓库的配置围绕以下设计取舍展开：

1. **消除 system prompt 内部的重复与前后矛盾。** 非空壳 harness 在基础模板、内置工具说明与子代理包装层中自带的预定义文本极易与用户规则重复或冲突，而模型遇到前后矛盾的提示词时会直接忽略。依托 Pi 系（含 `omp`）对 Handlebars 模板、personality 槽位、追加提示词与 `before_agent_start` 钩子的完整定制能力，本仓库从 `SYSTEM_TEMPLATE.md` 中剔除重复的工具说明，通过 [`tool-topics`](docs/extensions.zh-CN.md#tool-topics) 把渲染出的工具说明压到常用调用说明加 `Topics` 索引，OMP 简短的内置说明里省掉的详细调用说明改为按需读取的 `tool://<tool>/<topic>`，再通过 [`system-prompt-replace`](docs/prompts-and-context.zh-CN.md#system-prompt-replace) 做其余措辞级修改（如移除原生子代理禁用 Todo 的冲突句子），使每条规则只出现一次且前后一致。
2. **文件读写固定使用 `read` + hashline `edit`，并以工具失范作为 system prompt 偏离的触发信号。** 允许用 `eval` 或 shell 组合命令检索和修改文件，会让模型跳过目标行周围的上下文直接按匹配结果修改；在长任务中读取邻近上下文增加的 token 占比很小，而在缺少编译器与测试保护的配置、脚本和命令行操作中，脱离上下文的修改容易造成破坏，因此配置启用 `edit.mode: hashline`（修改前须经非 `:raw` `read` 获取行快照标签）并禁止在 `eval` 中检索本地文件。同时，包括 Claude Opus 在内的前沿模型在长会话中普遍会逐步忽略静态 system prompt；[`tool-policy-nag`](docs/extensions.zh-CN.md#tool-policy-nag) 以工具调用不规范作为可观测信号，注入伪装成用户观察的 user 角色 steer 消息（在各模型厂商不透明的指令层级下，用户消息的注意力权重普遍高于系统提示），借此提醒模型重新遵守整个 system prompt。其启发式检测刻意保持较高误报率：对触发后的 thinking 块逐条检查表明，误报除消耗少量自检思考 token 外未观察到负面影响。回合中途与结束状态另由 [`watchdog-agent`](docs/extensions.zh-CN.md#watchdog-agent) 与 [`turn-judge`](docs/extensions.zh-CN.md#turn-judge) 抽查。
3. **推迟有损上下文压缩，并保留已确认的约束。** 长会话上下文除文件内容外，还记录已与用户确认的需求边界与排除方案，过早压缩或截断命令输出会丢失这些前提。配置将压缩方式按信息损耗从低到高排列（`remote → soft → snapcompact → handoff → shake`），关闭提前 32k token 的后台预摘要（`compaction.asyncEnabled: false`），通过 [`model-compaction`](docs/prompts-and-context.zh-CN.md#model-compaction) 按模型调整触发阈值，并在子代理需要完整对话背景时使用 [`fork-task`](docs/prompts-and-context.zh-CN.md#fork-task) 复制当前分支。
4. **`todo`（[`omp-todo-more`](docs/plugins-and-modes.zh-CN.md#todo-more)）介于普通会话与 `/goal` 之间。** 它保留 `/goal` 对目标、验收条件（`objective`/`measure`/`doneWhen`）与未完成项的督促，同时允许在执行过程中调整阶段、任务、耗时预估与阻塞状态。任务状态变更与 `DONE` 提交共同构成逻辑检查点（checkpoint）；跨 compact 轮次时，`omp-todo-more` 将 Todo 快照、[`Task log`](docs/prompts-and-context.zh-CN.md#task-log) 与 [`ctx`](docs/prompts-and-context.zh-CN.md#ctx) 子代理树重新注入上下文。
5. **子代理（subagent）按模型互补、多订阅分摊与职责边界划分。** 一是以少量调用延迟换取不同模型的特性互补（如 `gpt-*-sol` 偏稳健保守、`gpt-*-luna` 成本低、`claude-opus` 适合发散设计），收敛单一模型的推理偏差；二是将各档位与回退链分布到不同订阅与免费渠道（`anthropic`、`openai-codex`、`opencode-go`、`bansos`），分摊调用以降低综合成本；三是区分任务执行与角色边界——主代理编写派工 prompt 时会将自身假设带入子代理，因此执行侧不设预设人设或固定工作流节点（禁用 `scout`、`reviewer` 等内置子代理），统一由主代理编排无状态的 `task:high/mid/low/free` 执行器，并在派发与交付时由 [`task-split-check`](docs/extensions.zh-CN.md#task-split-check)、[`isolation-nudge`](docs/extensions.zh-CN.md#isolation-nudge) 与 [`task-completion-judge`](docs/extensions.zh-CN.md#task-completion-judge) 校验；非 `task` 子代理仅用于需要隔离职责边界的场景（使顾问既不受主代理转述偏差主导，也不替代主代理决策），通过 [`user-prompt-inject`](docs/agents.zh-CN.md#user-prompt-inject) 注入根会话用户消息、`discuss:*` 限制只读工具、`mentor:default` 移除全部工具来约束边界，因此仅设 `discuss:steady`、`discuss:divergent` 与 `mentor:default` 三个角色。

## 文档

| 页面 | 内容 |
|---|---|
| [提示词与上下文](docs/prompts-and-context.zh-CN.md) | 提示词分层（`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、`tool-topics`、`system-prompt-replace`、`append-system-model`、`repo-rules`）与上下文保留（`fork-task`、`model-compaction`、`ctx`、`Task log`） |
| [子代理](docs/agents.zh-CN.md) | 7 个可选 worker/顾问定义与内部 `fork:self`、模型绑定、顾问上下文、派发规则与 worktree 隔离 |
| [本地扩展](docs/extensions.zh-CN.md) | 26 个本地扩展总表，以及派发/交付检查（`isolation-nudge`、`task-split-check`、`task-completion-judge`）、`JUDGE` 判定扩展（`tool-policy-nag`、`watchdog-agent`、`turn-judge`、`lang-nag`）、bash 与 eval 删除拦截和只收字面路径的 `delete` 工具（`delete-guard`）、宿主/TUI 扩展与读取其他会话的 `session://`（`session-urls`） |
| [插件与运行模式](docs/plugins-and-modes.zh-CN.md) | `install-plugins.sh` 中的外部插件（`omp-todo-more`、`omp-thinking-translator` 等）以及 `omp` 与 `omp-light` 的差异 |
| [安装、同步与维护](docs/operations.zh-CN.md) | 仓库与本机的文件归属、`/update-omp`、`/sync-omp-config`、`omp-config-autoupdate`、`_shared` 模块与升级检查 |
| [配置检查（`ci/README.zh-CN.md`）](ci/README.zh-CN.md) | `bun ci/check.ts` 如何安装 `omp`、应用配置、接入免费模型与影子代理并去重报告故障 |
| [测试沙箱（`sandbox/README.zh-CN.md`）](sandbox/README.zh-CN.md) | `bun sandbox/sandbox.ts` 如何用本机 `~/.omp` 配置、凭据与工作树建一次性容器，按模型驱动真实会话，并删除和登记每次运行 |
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
bun run test                  # bun test ci：session-urls 扫描器差分测试与 type 过滤测试
./plugin-audit.sh             # 只读比对 install-plugins.sh 与 `omp plugin list`
bun ci/check.ts               # 隔离 HOME 安装 + 免费模型跑完整模式与轻量模式 RPC 会话检查
```
