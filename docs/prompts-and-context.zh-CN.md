# 提示词四层解耦与上下文经济学

[返回首页](../README.zh-CN.md) · [English](prompts-and-context.md) | 简体中文

## 提示词四层解耦

为避免把所有指令塞进同一个文件导致提示词膨胀与规则互搏，系统提示词按职责拆分为四个正交层：

| 层级 | 载体文件 / 扩展 | 作用域 | 核心内容与边界 |
|---|---|---|---|
| **1. 基础工作流层** | `agent/SYSTEM_TEMPLATE.md` | 主会话 + 子代理 | 派生自 OMP 内置 `packages/coding-agent/src/prompts/system/system-prompt.md` 的 Handlebars 覆盖模板（纯文本 `SYSTEM.md` 无法编译表达式）。负责通用工程纪律、渲染实时工具/技能/规则清单，并通过 `{{#if subagent}}` 将第 4 步切换为主代理 `Verify` 或子代理 `Hand-off`。不重复印具体工具的使用说明。 |
| **2. 表达与写作风格层** | `agent/PERSONALITY.md` | 仅主会话（子代理固定 `personality: none`） | 填充模板的 `{{personality}}` 槽位。前半部分逐字保留 OMP `personality: default` 的 `Evidence-first terse engineer` 推理规范；后半部分定义 `# Writing` 研究与分析文体规范：结论/数字/机制直接开篇，一句话交代时间、主体、行为、规模与来源，多对象进单表且不在表后逐行复述，删除过程自述、重复解释、免责声明与总结段（删掉某段若不改变读者对事实、数字、机制、条件与结论的理解则必须删除）。 |
| **3. 主会话本地策略层** | `agent/APPEND_SYSTEM.md`（轻量模式为空文件 `APPEND_SYSTEM_LIGHT.md`）+ [repo-rules](#repo-rules) | `APPEND_SYSTEM.md` 仅主会话；`repo-rules` 主 + 子 | `APPEND_SYSTEM.md` 定义四项本地增量：① 用户显式指令高于一切默认规则；② 最终回复是唯一交付物（正文用带主语的完整句子、首现指认对象、结论旁附 `path:line` 或实测输出证据、禁类比）；③ 严禁为省 token 跳过必读内容或截断报告，修改设计文档前必须逐行通读全文及关联文档；④ 重大决策必问 `discuss:steady` 与 `discuss:divergent`，长调查必配 `mentor:default`。 |
| **4. 动态工具手术与模型差分层** | [system-prompt-replace](#system-prompt-replace) + [append-system-model](#append-system-model) | 主会话 + 子代理 | `system-prompt-replace` 在所有路径扩展最后执行，就地改写注入到 system prompt 中的内置/插件工具说明；`append-system-model` 按当前会话模型的 `model`/`provider` 正则动态追加模型专属补丁，使针对单一模型家族的纠偏不污染其他模型。 |

### system-prompt-replace

位于 `agent/extensions-last/system-prompt-replace/`，写在 `agent/config.yml` `extensions` 列表的最后一项。由于 `before_agent_start` 钩子按扩展加载顺序串行执行（加载顺序：native 发现 `~/.omp/agent/extensions/` 与 `settings.json` 模块 → hooks → 插件扩展 → `-e` 参数 → `config.yml` `extensions` 列表 → OMP 内置 inline 扩展），将其放在 `extensions/` 目录之外的 `extensions-last/` 并排在 `config.yml` 末项，可确保它看到所有路径加载扩展完成后的 system prompt（若放进 `extensions/` 会在第 1 步提前加载，且 `config.yml` 中的同名路径会被当作重复项丢弃）。

扩展在每次 `before_agent_start` 重读 agent 目录 `omomp.*` 的 `system-prompt-replace` 段（不读项目 `.omp/` 副本；依赖 `config.yml` 开启 `inlineToolDescriptors: "on"` 将完整工具说明渲染进 system prompt）：

```yaml
system-prompt-replace:
  replacements:
    - literal: "原文"
      replace: "替换文字"
    - regex: "JavaScript 正则源码"
      replace: "替换文字，可用 $1、$&"
```

- **当前仓库的 10 条改写规则**：① 将 `read` 重定义为统一的 `<source><:selector>` / `<source>?<query>` 检索与 hashline 快照协议，并说明单流 `.gz` 如何暴露其唯一成员（指向 `omp://tools/read.md`）；② 将 `task` 的 `"Use most specific agent."` 改写为按成本与可信度选档（默认 `task:mid`、`task:low` 省成本与验证 `task:free`）；③ 移除原生子代理包装层的 `"Every task MUST skip build/lint/tests..."` 与 `"No TODO tracking, no progress updates."`；④ 要求并发写入强制 `isolated: true` 且共享只读调查代理以便续聊；⑤ 要求显式指定 `agent` 且不覆写 `effort`；⑥ 澄清对用户报错“不复跑去怀疑报告，但为定位原因的复现与修复后的确认仍照常执行”；⑦ 修正编译代码规则缺失的 `add`；⑧ 严禁通过 `eval` 读取、列举或搜索本地文件；⑨ 声明 `xd://<tool>` 设备只能通过 `write` JSON 调用、严禁编造 `xd__<tool>` 函数名；⑩ 用精确 literal 整段替换原生 `bash` 说明（上游措辞一变即触发漂移警告），新说明与 `omp://tools/bash.md` 一致，并与 `agent/extensions/tool-policy-nag/INTENT-policy.md` 采用同一套三入口分工：`bash` 是同步语义的默认 shell（内嵌 brush、不在调用内切换 shell、并发调用使用隔离 shell、管道 / `$(…)` / 程序输出重定向属正常用法、`timeout` 按命令设定、自动转后台的结果只投递一次且不得轮询）；`xd://exec_command` 负责长时间运行、等待外部条件、需要终端或需要其他 shell 的程序，等待时用一个静默循环加不带 `condition` 的 `xd://monitor`，结束时只唤醒一次；`eval` 负责需要语言语义的计算。
- **失效与漂移检测**：当某条规则在主会话 system prompt 中找不到目标文本时（例如升级 OMP 后上游改动了内置工具描述），每个进程每条规则弹一次 UI 警告（headless 写 stderr）并记日志，绝不阻塞 prompt；subagent 因本就可能不含 `task` 等工具说明而不做缺失检查。

### append-system-model

在每次 `before_agent_start`（主会话与每个 subagent 各自按自身当前模型匹配）重读 `~/.omp/agent/extensions/append-system-model/APPEND_SYSTEM_MODEL.md`（本机独占文件，仓库不带，改文件或 `/model` 切换从下一条 prompt 即时生效）。文件由多个 `---` 分隔的块组成，每个块头部为声明 `model`（匹配如 `claude-opus-5-5`）和/或 `provider`（匹配如 `^anthropic$`）JS 正则的 YAML 头，正文延伸至下一个 `---` 行（正文内部如需分隔线请用 `***`）。所有匹配块按文件顺序拼接为一个额外 system prompt 块追加在末尾；文件缺失时静默跳过，格式错误时按行号记一次 warning 且不阻塞 prompt。

### repo-rules

OMP 默认扫描 `.omp/rules`、`.agent(s)/rules`、`.cursor/rules`、`.windsurf/rules`、`.clinerules` 与 `.github/instructions`，但不扫描 `.claude/rules` 与 `.pi/rules`，会丢弃既无 `alwaysApply` 也无 `description` 的规则文件，也不读取 Claude Code 的 `paths` frontmatter。

- **无作用域规则：** 本扩展从 `cwd` 向上至 git 根目录（不在仓库中时只看 `cwd`）逐层递归扫描 `.claude/rules`、`.agents/rules`、`.pi/rules` 下的非隐藏 `.md` / `.mdc`（离 `cwd` 越近优先级越高，同层按 `.claude` → `.agents` → `.pi` 排序），并在每个会话额外扫描用户级 `~/.claude/rules`，在每次 `before_agent_start` 追加 `<repo-level-rules>` 块。无 frontmatter、frontmatter 无法解析或 `alwaysApply: true` 的规则注入全文；其余带 frontmatter 的规则仅列出名称、`description` 与路径。OMP 已自行放置（alwaysApply、rulebook 条目或 TTSR）的文件跳过；正文空白归一后已在本次收到的 system prompt 中、或列表项的 `rule://<文件名>` 已在其中的也跳过。
- **按路径作用的规则（Claude Code `paths`）：** frontmatter 含 `paths`（YAML 列表或逗号分隔的 glob 字符串，支持花括号与 `[…]` 字符类）的规则，只在触及匹配文件时加载：成功的 `read`、`write`、`edit`，或只读取单个文件的纯 `cat`/`head`/`tail` 的 `bash` 命令（管道、命令串联与多文件命令不算）。来源为上述扫描文件以及 OMP 原生发现的全部规则（项目与用户级 `.omp`/`.agents` 规则、cursor/windsurf/cline/GitHub 规则、插件与扩展根目录的 `rules/`，例如经 `~/.claude` 扩展条目加载的 `~/.claude/rules`）。glob 的基准目录：用户级规则为 `cwd`，项目规则为包含该规则所在点目录的目录，插件或扩展根下 `rules/` 的规则为该根目录。带 `paths` 的原生规则无论 OMP 原本放在哪里都由本扩展接管：`alwaysApply` 正文从 `<generic-rules>` 删除，rulebook 条目从 `<domain-rules>` 删除，并继续遵守 `ttsr.disabledRules` 与其 `agents` 作用域。TTSR 规则（`condition`、`astCondition`、`question`）与 OMP 内置规则仍由 OMP 自行触发。命中的规则以 `tool_result` 的 `additionalContext`（工具批次之后的 developer 消息）送达，每个上下文一次：只要其 `<path-scoped-rule path="…">` 标记仍在 OMP 将发送的上下文中就不重复（因此压缩丢掉标记、resume 与切分支都按实际上下文处理）。
- **绝对路径模式（Claude Code 之外的扩展）：** 以 `/` 或 `~/` 开头的 `paths` 模式匹配被触及文件的绝对路径（`~` 为家目录），而非相对基准目录的路径，因此用户级规则可以按目录名生效、与会话 cwd 无关，例如 `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**` 覆盖所有 omp 仓库。Claude Code 本身把这类模式当作相对路径，永远不会命中。

---

## 上下文经济学（Context Economics）

Context 管理的核心矛盾是**保留已对齐的任务意图，同时剥离高噪音的执行过程**：

1. **普通 `task`（抛弃执行过程）vs `fork_task`（克隆完整对齐背景）**：
   - 当背景简短或需要独立视角时，使用普通 `task`：子代理的探索、试错与工具输出留在其可丢弃的分支中，主会话只接收最终 `yield` 的结论与证据。
   - 当主会话已载入百万字级设计材料或与人类完成了多轮复杂对齐，无法靠几句话的 `context` 无损转述时，使用 `fork_task` 让子代理带着完整对话记忆聚焦局部切片。
2. **推迟有损压缩（`compaction.methodOrder` + `model-compaction`）**：
   - `agent/config.yml` 将压缩方式按损耗从低到高排为 `remote → soft → snapcompact → handoff → shake`，并通过 `model-compaction` 为大窗口模型设定精确的高水位触发点。
   - `compaction.asyncEnabled: false` 让压缩在触发点当场生成摘要。开启时，OMP 会提前最多 32k token 在后台请求摘要，拿到结果后一直存到触发点才换入，且 Anthropic 的摘要从不重新生成，期间每次请求仍带着完整历史。
3. **压缩后的确定性状态重建（`omp-todo-more` 的 `todo` + `Task log` + `ctx`）**：
   - 一旦主会话发生 Compaction，模型自行生成的摘要不可全信。`omp-todo-more` 插件通过旁路记录每次成功 `todo` 调用的 `Task log`，在压缩完成后自动将子代理上下文树（`ctx list`）与确定性重放的任务时间线（`ctx show`）注入新上下文。

### fork-task

注册 `fork_task` 工具（顶层 `context` 加不含 `solutionSpace` 的 `tasks[]`，需 `async.enabled: true`）。派出的仍是原生 `task` 子代理（拥有独立 agent 定义、模型、工具、Agent Hub 行、`agent://`/`history://` 与隔离合并回写），唯一区别是其初始 transcript 复制自调用方当前对话，或某项 `from: "<agent-id>"` 指定的已注册代理对话：

- **关键行为差异**：
  - `isolated` 默认 `true`（仅只读调查时显式写 `isolated: false`；父会话处于 plan mode 时强制共享目录；隔离子代理结束后不可续聊）。
  - 支持 `shake: true`：对克隆副本执行与 `/shake` 相同的 `session.shake("elide")`——保护最近约 4,000 token 及 `skill://`、`local://PLAN.md` 读取，将更早的文本工具结果、$\ge 400$ token 的围栏代码块与顶层小写 XML 元素替换为 `[shaken ~N tokens — recover: artifact://<id> (region K)]` 写入整棵代理树共享的 artifact 目录，子代理可按需 `read` 恢复原文。
  - 支持 `from: "<agent-id>"`（匹配规则同 `agent://<id>`，含运行中、idle 或恢复会话中的 parked 代理）：复制该代理当前已落盘的对话而非调用方的。使用 `from` 时必填 `agent`（不继承来源的模型与角色），且子代理仍是调用方的子代，工作目录来自调用方的 checkout 而非 `from` 来源的隔离目录。
  - **强制 Runtime 验证契约**：克隆副本末尾自动追加 `<system-notice cause="fork_task">`，声明前置历史仅作背景，并明确要求 fork worker 在 handoff 前完成相关构建、测试与真实 runtime smoke 验证。
- **底层四步暂存机制**：① 将来源会话克隆至 `$TMPDIR/omp-fork-task/<uuid>/`（清零继承费用、为中断的工具调用补齐合成中止结果、清空源 Todo、追加 fork notice）；② 移除来源会话的运行时条目（`session_init`、`model_change`、`thinking_level_change`、`service_tier_change` 及 shake 辅助会话的 `session_exit`）并将子条目重挂到上一级；③ 共享子代理写入调用方 `cwd`，隔离子代理置空 `cwd` 交由执行器绑定 worktree；④ 在异步派发分配 ID 后触发的 `before_subagent_spawn` 钩子中，将暂存文件移至 `<父会话文件去掉 .jsonl>/<子代理 id>.jsonl` 供执行器直接打开。

### model-compaction

仅在主会话每次 `before_agent_start` 重读 agent 目录 `omomp.*` 中的本机 `model-compaction` 段（不读项目 `.omp/` 副本），弥补 OMP 原生 `compaction.modelThresholds` 仅支持精确 `provider/id` 或 `*` 前缀的限制：

```yaml
model-compaction:
  rules:
    - provider: "^anthropic$"
      model: "opus"
      thresholdTokens: 150000
    - model: "[gG][pP][tT]"
      thresholdTokens: 650000
```

- **匹配与运行时注入**：每条规则至少写 `model` 或 `provider`（无隐式兜底，全匹配需写 `"model": ".*"`），按文件顺序取首条匹配规则，将 `ctx.models.list()` 中匹配的每个模型展开为原生固定触发条目 `"<provider>/<id>": "f<thresholdTokens>"` 写入主会话运行时设置层（不写 `config.yml`，`/model` 切换、重试回退与继承主会话设置的 subagent 自动按各自模型生效）。
- **上下文窗口档位保护**：原生 `f<N>` 条目可能改变支持 extended 上下文模型的窗口档位。本扩展**绝不改变任何模型的窗口档位**：若某条规则的 `thresholdTokens` 会在 standard 与 extended 窗口之间切换该模型当前所处的档位，则对该模型拒绝应用并记 warning。同时保留其他来源预设的运行时条目，在无匹配规则或 `session_shutdown` 时恢复原值；若发现外部修改了该运行时映射则警告一次并停止管理。

### ctx

由 [omp-todo-more](plugins-and-modes.zh-CN.md#todo-more) 插件注册（`src/ctx/inventory.ts`）的只读工具，将当前会话、subagent registry、transcript、compaction 摘要、`.md`/`.json` sidecar 与 task log 组装为一棵上下文树，不修改任何会话或文件：

- **`ctx list [<id>] [all=true]`**：深度优先输出每行一个 context（含状态、单行摘要、`done/total` 任务计数及带原因的 `blocked`）。默认仅显示主会话与 `task` / `task:*` 子代理（隐藏 `mentor`、`discuss`、`trace` 并将其可见后代提升一级，附隐藏数量），非根节点后代超过 8 个时折叠为一行（用 `ctx list <id>` 展开）；`all=true` 显示除 advisor 外的全部节点。
- **`ctx show <id>`**：输出三部分：① handoff（当前会话取最新 compaction 摘要，其他 context 优先取相邻 `.md` sidecar 全文，次选 `.json` sidecar 的 120 字符摘要）；② task log 中最后一条有效的 `## Goal`（Objective / Measure / Done when）；③ 由 task log 重放生成的 `## Tasks` 时间线（分 `Completed` 与 `Open` 两段，按最后一次被采纳操作的本地时间排序）。
- **近似值边界**：计数与时间线是从追加日志重建的近似视图，不等同于 `TodoTracker` 的实时状态：`init`/`append` 只记数量不记任务名，因此创建后从未被单独按名操作的任务计入 `ctx list` 总数但不出现在时间线中；已完成或已移除的任务名后续 `start`/`block`/`unblock` 不再生效；名为 `all tasks` 的任务会被当成批量选择器。

### Task log

`omp-todo-more` 插件的 `src/ctx/tasklog.ts` 在每次改变状态的 `todo` 或原生 `goal` 工具调用成功后，将本地时间、工具名、操作与详情追加到 `<local root>/task-log/<agent-id>.md`（带 goal 的成功 `todo` 调用紧接着再记一行 `todo-more set: <goal JSON>`；只读的 `todo view`、`goal get` 及失败调用不记）。这使行事记录严格锚定在已实际成功的工具调用上，而非模型声称做过什么。

### compact 后注入

`omp-todo-more` 插件的 `src/ctx/post-compact-hint.ts` 监听主会话的 `session_compact` 与未中止的 `auto_compaction_end`（5 秒防抖窗口内最多触发一次，subagent 不注入），在压缩结束后自动以 steer 消息注入 `<post-compact-ctx>` 块（内含 `## List` 即 `ctx list`，以及主会话的 `## Current session` 即 `ctx show`），确保压缩后的新上下文第一时间拿到完整的子代理树与任务进度账本。
