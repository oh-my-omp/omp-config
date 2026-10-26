# 多代理拓扑、防回声室顾问与成本信任分档

[返回首页](../README.zh-CN.md) · [English](agents.md) | 简体中文

`agent/config.yml` 在 `task.disabledAgents` 中显式禁用了全部 5 个内置子代理（`task`、`scout`、`sonic`、`reviewer`、`security-reviewer`；即使写进 `spawns` allowlist 也会在 preflight 被拒），所有子代理委派统一由 `agent/agents/*.md` 中的 7 个自定义子代理承载（编写陷阱详见 `agent/agents/README.txt` 与 `README.zh-CN.txt`，目录内笔记必须用 `.txt` 后缀以免被当作 agent 定义解析产生永久日志噪声）。

## 七个自定义子代理与模型绑定矩阵

模型的职责与能力边界定义在 `agent/agents/<name>.md` 中，而具体绑定的模型与回退链集中在 `agent/config.yml` 的 `task.agentModelOverrides`（更换绑定模型时若改变了档次或成本量级，须同步更新 agent 文件的 `description` 与下表）：

| 子代理名称 | `description` 声明的档次与综合成本（每 1M token） | `config.yml` 当前实际绑定模型链 | 允许派生 (`spawns`) / 工具限制 (`tools`) | 角色契约与信任边界 |
|---|---|---|---|---|
| `task:high` | Claude Opus 5.5，约 $0.45 | `anthropic/claude-opus-5-5:high` | `spawns: task:mid, task:low, task:free, task:high, discuss:steady, discuss:divergent, mentor:default` | **未获用户在当前对话显式允许严禁调用**；唯一可承担架构/核心设计并向下二次展开一层（depth 1 → depth 2）的顶级 worker，负责所派子批次的契约、验收与集成（默认首项 `spawns` 为 `task:mid`） |
| `task:mid` | Opus 级，约 $0.30 | `openai-codex/gpt-6-1-sol:high` | `spawns: mentor:default` | **默认主力 worker**：处理除架构与核心设计外的一切实现、调查、调试与验证，并负责裁决低档次 worker 之间的分歧 |
| `task:low` | Opus 级，约 $0.01 | `openai-codex/gpt-5.6-luna:max` | `spawns: mentor:default` | 成本优先且结果可直接交付的工作（批量机械改动、查找、例行检查），以及对 `task:free` 产出做独立复现与核验 |
| `task:free` | Opus 级，零成本，高并发 | `bansos/muse-spark-1.3-contributor:xhigh, opencode-go/muse-spark-1.3-contributor:xhigh, openai-codex/gpt-6-luna:max` | `spawns: mentor:default` | **零信任探针层**：仅用于找候选代码/文档与低成本试探；任何实质性结论必须经父代理或 `task:low+` 独立验证，多个 `task:free` 达成一致绝不构成验证 |
| `discuss:divergent` | — | `anthropic/claude-opus-5-5:medium, openai-codex/gpt-5.6-luna:max` | `tools: read, grep, glob` | **只读发散派辩手**：质疑既有问题框架与假定约束，在存在真正不同解空间（删除特性、换状态拥有者、解决一整类问题）时给出带 `path:line` 证据与代价的替代方案 |
| `discuss:steady` | — | `openai-codex/gpt-5.6-sol:medium` | `tools: read, grep, glob` | **只读保守派辩手**：对方案做压力测试，以 `path:line` 举证排查隐含假设、未处理状态、迁移爆炸半径与更平庸安全的做法 |
| `mentor:default` | — | `openai-codex/gpt-5.6-sol:high, openai-codex/gpt-5.6-luna:max` | `tools: []`（仅 `yield`） | **无工具全周期导师**：调查前将活动型计划压成可判定的问题并找最廉价决定性观测点，交付前对照原计划逐项对账复盘；答案必须放入 `yield` 载荷防丢失 |

## 破除顾问回声室：`user-prompt-inject` 与双视角辩论

在传统多代理系统中，`mentor` 或 `discuss` 只知道派发它的代理告诉它的内容，一旦主代理理解偏了用户意图，顾问只会顺着错误转述给出合理化建议。本配置通过三项机制破除回声室：

1. **穿透式注入人类原话（[user-prompt-inject](#user-prompt-inject)）**：直接从根主会话抓取人类亲手输入的全部原始 Prompt，注入给 `mentor:default`、`discuss:steady`、`discuss:divergent` 的每一次模型请求，要求它们拿用户的原话去审判咨询方的计划。
2. **物理拆分的对抗性双辩手（`discuss:steady` vs `discuss:divergent`）**：重大决策必须同时咨询两者，避免单一审阅者给出折中废话；同一议题通过 `write agent://<id>` 多轮续聊，不重复建新会话。
3. **无工具导师的前置控轨与事后对账（`mentor:default`）**：刻意剥夺 `mentor:default` 的全部读写工具（`tools: []`），逼迫咨询方必须把具体路径、符号、命令与实测输出整理成文本发给它，在整理过程中自我暴露哪些是“已观测事实”、哪些只是“未验证假设”。

### user-prompt-inject

在子代理每次模型调用（`context` 事件，涵盖首次派发、IRC `write agent://<id>` 唤醒与 parked 恢复）时，沿 `ctx.agent.parentId` 在进程 `AgentRegistry` 中向上找到根主会话（`task:high` 派出的孙代同样适用），读取其当前分支（`getBranch()`，含 compact 之前的历史）上所有 `role: "user"`、`attribution: "user"` 且非 `synthetic` 的非空文本消息，按 `PROMPT-INJECT-<label>.md` 模板渲染后作为一条不落盘的请求级 developer 消息（`<user-prompt-inject name=…>`）插在上下文最前面：

- **模板发现与 Frontmatter**：扫描 `~/.omp/agent/extensions/user-prompt-inject/PROMPT-INJECT-*.md` 及 `cwd` 至 git 根各层的 `<dir>/PROMPT-INJECT-*.md` 与 `<dir>/.omp/PROMPT-INJECT-*.md`。仓库自带并同步 `PROMPT-INJECT-user-goal.md`（配置 `target: mentor:default, discuss:steady, discuss:divergent`、`name: user-goal`、`enabled: true`，正文用 `{{user_prompt[0:e]}}` 注入全部用户原话）。
- **占位符语法**：`{{user_prompt[0]}}`（第一条）、`{{user_prompt[-1]}}`（最新一条）、`{{user_prompt[a:e]}}`（左闭右开切片，两端支持负数，每项渲染为 `<user_prompt index="N">…</user_prompt>`）；任何其他 `{{user_prompt…}}` 写法会让整个文件被跳过并记 warning。
- **消息归因隔离**：由于 `sendUserMessage` 不传 `attribution` 时默认为 `"user"`，本仓库所有主动发送用户角色消息的扩展（`watchdog-agent`、`turn-judge`、`tool-policy-nag`、`doc-polish`、`wt-tool`、`harness-restart`、`child-memory-warning`）一律显式设置 `attribution: "agent"`，防止扩展提醒被误当作人类原话注入顾问。

## 派发经济学与并行写入隔离契约

- **按成本与所需可信度选档，绝不按任务难度选档**：默认派 `task:mid`；当成本优先于额外判断力（批量机械改动、查找、核验 `task:free`）时降为 `task:low`（需要验证才能采信的任务，直接用 `task:low` 做一次比用 `task:free` 加验证者更便宜）。`task:free/low/mid` 严禁接手架构、领域类型、跨切片接口与文档/prompt/skill/agent 定义的设计。
- **递归深度上限为 2**：主代理在 depth 0，派出的 worker 在 depth 1；仅 `task:high` 能再派 depth 2 孙代，且 depth 2 的 `task` 工具会被宿主剥离（也无法派生自己的 `mentor:default`），因此交给 depth 2 的必须是可直接执行的叶子任务。
- **显式填 `agent`，禁覆写 `effort`**：每次调用必须显式指定 `agent`；模型与推理强度由 `config.yml` 绑定决定（`task.enableEffort: false` 隐藏了原生参数）。`config.yml` 中保留内置 `task` 与 `sonic` 的模型覆盖仅服务于 Vibe 模式的首层固定派发。
- **每个 `task:*` 切片的强制规程**：动手前先读代码写出计划交 `mentor:default` 审阅（depth 2 除外）；全程用 `todo` 初始化完整步骤并实时更新状态，还有未完项时严禁 `yield`，也严禁通过 `drop`/`rm` 缩小派工范围。
- **并行写入的 Worktree 隔离（`isolated: true`）**：同一仓库同时存在 $\ge 2$ 个写入 worker（同批派出，或前序共享写入 job 仍在运行）时，每个写入者必须设 `isolated: true`（`fork_task` 默认 `true`；只读调查设 `isolated: false` 以保持可续聊；plan mode 下强制共享）。给隔离 worker 的路径必须写**仓库相对路径**（OMP 的隔离靠提示词约束，写绝对路径会让命令跑回父工作区）。`task.isolation.merge: branch` 把 worker 自己的提交逐个 cherry-pick 到父分支，提交信息与 todo-more 的 `Model` trailer 原样保留；返回结果须确认 `Merged branch: <name>`（或 `No changes to apply.`）才算落盘。
