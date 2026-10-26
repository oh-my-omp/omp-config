# 子代理

[返回首页](../README.zh-CN.md) · [English](agents.md) | 简体中文

`agent/config.yml` 在 `task.disabledAgents` 中禁用了 OMP 内置的 5 个子代理（`task`、`scout`、`sonic`、`reviewer`、`security-reviewer`；即使写进 `spawns` 也会在 preflight 被拒）。所有子代理调用均使用 `agent/agents/*.md` 中的 7 个自定义子代理（frontmatter 规则与常见陷阱见 [`agent/agents/README.zh-CN.txt`](../agent/agents/README.zh-CN.txt)；该目录下的说明文件必须使用 `.txt` 后缀，否则会被当作 agent 定义解析并报错）。

子代理体系基于三项设计原则：
1. **跨模型特性互补**：以少量调用延迟换取不同模型的特性组合——如 `gpt-*-sol` 偏稳健保守（`discuss:steady`、`mentor:default`、`task:mid`）、`gpt-*-luna` 成本低（`task:low` 及各角色回退链）、`claude-opus` 适合发散设计（`discuss:divergent`、`task:high`）——通过跨模型校验收敛单一模型的推理偏差。
2. **跨订阅分摊综合成本**：将不同子代理档位与回退链分布到多个订阅与免费渠道（`anthropic`、`openai-codex`、`opencode-go`、`bansos`），分摊调用额度以降低整体成本。
3. **无状态 `task` 执行器与受机制约束的少量顾问角色**：主代理编写子代理 prompt 时会将自身假设带入子代理，因此常规任务不使用预设人设或固定工作流节点（禁用 `scout`、`reviewer`、`security-reviewer` 等内置角色），统一由主代理编排无状态的通用 `task` 执行器（按成本与可信度分为 `task:high/mid/low/free`）。非 `task` 角色仅在需要严格隔离职责边界时设立（使顾问既不受主代理转述偏差主导，也不替代主代理决策），并通过 [`user-prompt-inject`](#user-prompt-inject) 注入根会话用户消息、`discuss:*` 限制只读工具、`mentor:default` 移除全部工具在运行期约束边界，因此仅定义 `discuss:steady`、`discuss:divergent` 与 `mentor:default` 三个非 `task` 角色。

## 子代理定义与模型绑定

子代理的职责、工具限制和 `spawns` 列表写在 `agent/agents/<name>.md` 中，具体模型链写在 `agent/config.yml` 的 `task.agentModelOverrides` 下（修改模型绑定若改变了档位或成本量级，需同步更新 `agent/agents/<name>.md` 的 `description` 与下表）：

| 子代理 | `description` 标明的成本（每 1M token） | `config.yml` 绑定的模型链 | 允许派生 (`spawns`) / 工具 (`tools`) | 职责与限制 |
|---|---|---|---|---|
| `task:high` | Claude Opus 5.5，约 $0.45 | `anthropic/claude-opus-5-5:high` | `spawns: task:mid, task:low, task:free, task:high, discuss:steady, discuss:divergent, mentor:default` | 未经用户在当前对话明确允许不得调用。唯一可承担架构/核心设计并继续向下派生一层（depth 1 → depth 2）的 worker（首项默认 `spawns` 为 `task:mid`），负责其子批次的接口契约、验收与集成。 |
| `task:mid` | Opus 级，约 $0.30 | `openai-codex/gpt-6-1-sol:high` | `spawns: mentor:default` | 默认 worker 档位：负责架构与核心设计之外的实现、调查、调试和验证，并裁决低档位 worker 之间的分歧。 |
| `task:low` | Opus 级，约 $0.01 | `openai-codex/gpt-5.6-luna:max` | `spawns: mentor:default` | 在成本优先于额外判断力时使用（批量机械修改、查找、例行检查），并用于独立复现和验证 `task:free` 的结果。 |
| `task:free` | Opus 级，$0.00 | `bansos/muse-spark-1.3-contributor:xhigh, opencode-go/muse-spark-1.3-contributor:xhigh, openai-codex/gpt-6-luna:max` | `spawns: mentor:default` | 仅用于找线索、候选位置和出错无妨的试探；任何实质结论必须由父会话或 `task:low+` 独立验证，多个 `task:free` 结果一致不代表已验证。 |
| `discuss:divergent` | — | `anthropic/claude-opus-5-5:medium, openai-codex/gpt-5.6-luna:max` | `tools: read, grep, glob` | 只读发散讨论者：审视问题提法与给定约束，在存在实质不同的做法（删功能、改状态归属、一次解决同类问题）时给出带 `path:line` 依据和取舍代价的替代方案。 |
| `discuss:steady` | — | `openai-codex/gpt-5.6-sol:medium` | `tools: read, grep, glob` | 只读保守讨论者：对照实际代码与 `path:line` 检查方案的隐含假设、未覆盖状态、迁移影响面以及更简单的做法。 |
| `mentor:default` | — | `openai-codex/gpt-5.6-sol:high, openai-codex/gpt-5.6-luna:max` | `tools: []`（仅 `yield`） | 无工具顾问：长调查开始前协助收敛计划与决定性检查点，交付前核对改动、已跑验证与未验证项；回复内容必须放在 `yield` 参数内。 |

## 顾问上下文与 `user-prompt-inject`

默认情况下，子代理只看到调用方写在 `task` 和 `context` 里的转述。针对 `mentor:default`、`discuss:steady` 与 `discuss:divergent` 的三项约定：

1. [`user-prompt-inject`](#user-prompt-inject) 从根主会话提取用户原始输入，插入这三个顾问的每次模型请求开头，让顾问直接对照用户原话核对计划。
2. 重大决策同时询问 `discuss:steady` 与 `discuss:divergent`；同一话题后续追问通过 `write agent://<id>` 发给原代理，不重复新建。
3. `mentor:default` 的 `tools` 为空，咨询方需要把涉及的文件路径、符号、命令和实测输出直接写进消息，而不是只给文件名。

### user-prompt-inject

源码：`agent/extensions/user-prompt-inject/`。

在子代理每次模型调用（`context` 事件，含首次派发、`write agent://<id>` 唤醒与 parked 恢复）时，沿 `ctx.agent.parentId` 在进程 `AgentRegistry` 中向上查到根主会话（含 `task:high` 派出的 depth-2 孙代），读取主会话当前分支（`getBranch()`，含压缩前历史）上所有 `role: "user"`、`attribution: "user"` 且非 `synthetic` 的非空文本消息，按匹配的 `PROMPT-INJECT-<label>.md` 模板渲染后，作为一条不写盘的 developer 消息（`<user-prompt-inject name=…>`）插到请求上下文最前面：

- **模板扫描**：扫描 `~/.omp/agent/extensions/user-prompt-inject/PROMPT-INJECT-*.md` 以及 `cwd` 至 git 根各层的 `<dir>/PROMPT-INJECT-*.md` 与 `<dir>/.omp/PROMPT-INJECT-*.md`。仓库自带并同步 `PROMPT-INJECT-user-goal.md`（`target: mentor:default, discuss:steady, discuss:divergent`、`name: user-goal`、`enabled: true`，正文用 `{{user_prompt[0:e]}}` 注入全部用户输入）。
- **占位符语法**：`{{user_prompt[0]}}`（第一条）、`{{user_prompt[-1]}}`（最新一条）、`{{user_prompt[a:e]}}`（左闭右开切片，支持负数下标，每条渲染为 `<user_prompt index="N">…</user_prompt>`）。其他 `{{user_prompt…}}` 写法会记一条 warning 并跳过该文件。
- **扩展消息的 `attribution: "agent"`**：`pi.sendUserMessage` 不传 `attribution` 时默认为 `"user"`。本仓库所有发送 user 角色消息的扩展（`watchdog-agent`、`turn-judge`、`tool-policy-nag`、`doc-polish`、`wt-tool`、`harness-restart`、`child-memory-warning`）均显式传 `attribution: "agent"`，避免把扩展消息当成用户输入注入给顾问。

## 派发规则与并行写入隔离

- **按成本与所需可信度选档**：默认用 `task:mid`；成本优先于额外判断力时（批量机械修改、查找、验证 `task:free`）用 `task:low`（需要验证才能用的结果，直接让 `task:low` 做一次比让 `task:free` 做完再派验证者更省）。架构、领域类型、跨模块接口以及文档/prompt/skill/agent 定义的设计不得派给 `task:free/low/mid`。
- **递归深度上限为 2**：主会话为 depth 0，其派出的子代理为 depth 1；只有 `task:high` 能再派 depth 2 子代理，而 depth 2 的 `task` 工具会被宿主移除（因此也无法再派 `mentor:default`），只能接收直接执行的叶子任务。
- **显式填 `agent`，不传 `effort`**：每个任务项都显式指定 `agent`（省略会落到首个 `spawns` 项或已禁用的内置代理），用户未要求时不传 `effort`（`task.enableEffort: false` 隐藏了原生参数）。`config.yml` 中保留内置 `task` 与 `sonic` 的模型绑定仅用于 Vibe 模式的首层派发。
- **worker 执行流程**：`task:*` 子代理在修改代码前必须先阅读相关代码并与 `mentor:default` 审阅计划（depth 2 除外），全程使用 `todo` 记录步骤，仍有未完成项时不得提前 `yield`，也不得用 `drop`/`rm` 缩小任务范围。
- **并行写入隔离（`isolated: true`）**：同一仓库同时有 $\ge 2$ 个写入子代理运行（同批派出，或前序共享写入任务仍在运行）时，每个写入子代理都须设 `isolated: true`（`fork_task` 默认 `true`；只读调查设 `isolated: false` 以便续聊；plan mode 下强制共享目录）。传给隔离子代理的文件路径使用**仓库相对路径**（OMP 通过提示词约束工作目录，写绝对路径会让命令改回父工作区）。`task.isolation.merge: branch` 会把隔离子代理的提交逐个 cherry-pick 到父分支，保留提交说明和 todo-more 的 `Model` trailer；返回结果需检查是否有 `Merged branch: <name>`（或 `No changes to apply.`）。
