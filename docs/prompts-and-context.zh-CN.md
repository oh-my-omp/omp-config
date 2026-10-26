# 提示词与上下文

[返回首页](../README.zh-CN.md) · [English](prompts-and-context.md) | 简体中文

## 提示词文件

非空壳 harness 在基础模板、内置工具说明与子代理包装层中自带的预定义文本容易与本地规则重复或冲突，而模型遇到前后矛盾的提示词时会直接忽略。依托 Pi 系（含 `omp`）对系统提示词各阶段的全量定制能力，提示词按职责与作用域拆分为以下文件与扩展，使每条指令只出现一次、消除内置文本与本地规则之间的矛盾，并将主会话文体/顾问规则与子代理或特定模型的增量隔离开来：

| 文件 / 扩展 | 作用域 | 内容与职责 |
|---|---|---|
| `agent/SYSTEM_TEMPLATE.md` | 主会话 + 子代理 | 基于 OMP 内置 `packages/coding-agent/src/prompts/system/system-prompt.md` 维护的 Handlebars 模板（纯文本 `SYSTEM.md` 不解析 Handlebars 表达式）。负责工作流规范、渲染当前工具/技能/规则列表，并通过 `{{#if subagent}}` 将第 4 步切换为主会话 `Verify` 或子代理 `Hand-off`。不重复打印单个工具的使用说明。 |
| `agent/PERSONALITY.md` | 仅主会话（子代理固定 `personality: none`） | 填充 `# Personality` 下的 `{{personality}}`。前半部分保留 OMP `personality: default` 原文（`Evidence-first terse engineer`）；后半部分定义 `# Writing` 分析与研究写作规范：结论、数字或机制直接开篇，一句话写清时间、主体、动作、规模与来源，多项对象或指标合并进一张表且不在正文逐行复述，删去过程自述、重复解释、叠加免责声明与文末总结。 |
| `agent/APPEND_SYSTEM.md`（轻量模式为空文件 `APPEND_SYSTEM_LIGHT.md`） | 仅主会话 | 增加四条主会话默认规则：用户的明确指令优先于默认规则；最终回复使用带主语的完整句子、首次提及时指认对象、结论旁附 `path:line` 或实测输出、不用类比；不为省 token 跳过必读文件或截断内容（改设计文档前先通读全文及关联文档）；重大决策同时询问 `discuss:steady` 与 `discuss:divergent`，长调查在开始前与交付前会商 `mentor:default`。 |
| [repo-rules](#repo-rules) | 主会话 + 子代理 | 加载 `.claude/rules`、`.agents/rules`、`.pi/rules` 与 `~/.claude/rules` 中的规则文件，并处理所有规则来源的 `paths` 按路径触发。 |
| [system-prompt-replace](#system-prompt-replace) | 主会话 + 子代理（仅完整模式） | 在所有按路径加载的扩展最后运行，原地改写渲染进 system prompt 的工具说明。 |
| [append-system-model](#append-system-model) | 主会话 + 子代理 | 按当前会话的 `model` 或 `provider` 正则匹配 `APPEND_SYSTEM_MODEL.md`，追加模型专属提示词块。 |

### system-prompt-replace

源码：`agent/extensions-last/system-prompt-replace/`，登记在 `agent/config.yml` `extensions` 列表的最后一项。

`before_agent_start` 处理器按扩展加载顺序串行执行：native 发现（`~/.omp/agent/extensions/` 与 `settings.json` 模块）→ hooks → 插件扩展 → `-e` 路径 → `config.yml` `extensions` → OMP 内置 inline 扩展。把该扩展放在 `extensions/` 之外的 `extensions-last/` 并排在 `config.yml` 末项，可使它在所有按路径加载的扩展之后运行（详见 [`agent/extensions-last/README.zh-CN.md`](../agent/extensions-last/README.zh-CN.md)）。

每次 `before_agent_start` 时，扩展重读 agent 目录 `omomp.*` 的 `system-prompt-replace` 段（不读项目 `.omp/` 副本；配合 `config.yml` 的 `inlineToolDescriptors: "on"` 将工具说明内联渲染进 system prompt）：

```yaml
system-prompt-replace:
  replacements:
    - literal: "原文"
      replace: "替换文字"
    - regex: "JavaScript 正则源码"
      replace: "替换文字，可用 $1、$&"
```

`agent/omomp.yml` 当前包含的 10 条替换规则（其中文件检索与编辑固定使用 `read` + hashline `edit` 并禁止在 `eval` 中查文件，以要求模型在读取目标行邻近上下文后再做修改，避免在缺少编译器与测试保护的脚本、配置或命令行操作中脱离上下文直接修改）：

| 目标 | 修改内容 |
|---|---|
| `read` 工具说明 | 说明 `<source><:selector>` 与 `<source>?<query>` 选择器、单流 `.gz` 归档成员、hashline 快照标签（配合 `config.yml` 的 `edit.mode: hashline`，非 `:raw` 读取拿到 4 位十六进制标签后才能执行锚点 `edit`）以及 `omp://tools/read.md`。 |
| `task` 选档说明 | 把 `"Use most specific agent."` 改为按成本与所需可信度选档：默认 `task:mid`，省成本或验证 `task:free` 用 `task:low`，无须独立验证的试探用 `task:free`。 |
| 子代理检查与 Todo 说明 | 删去原生子代理提示词中的 `"Every task MUST skip build/lint/tests..."` 与 `"No TODO tracking, no progress updates."`，避免与子代理必填 Todo 及 `fork_task` 的验证要求冲突。 |
| 并发写入隔离 | 要求并发写入的子代理设置 `isolated: true`，只读调查子代理保持共享以便后续用 `write agent://<id>` 续聊。 |
| `agent` 与 `effort` 参数 | 要求每个 task 项显式填写 `agent`，用户未要求时不传 `effort`。 |
| 用户报错处理规则 | 补充说明“不重跑检查去质疑用户报错”不影响为定位原因而复现和修复后验证。 |
| 编译代码规则 | 补上原句缺失的动词 `add`（`NEVER add avoidable allocation...`）。 |
| `eval` 工具说明 | 禁止通过 `eval` 读取、列目录或搜索本地文件（统一使用 `read`、`glob`、`grep`）。 |
| `xd://` 设备说明 | 说明 `xd://<tool>` 只能通过 `write` 写入 JSON 调用，不存在 `xd__<tool>` 或裸 `<tool>` 函数。 |
| `bash` 工具说明 | 用精确 literal 整段替换内置 `bash` 说明，与 `omp://tools/bash.md` 及 `agent/extensions/tool-policy-nag/INTENT-policy.md` 保持同一分工：`bash` 用于内嵌 brush shell 的同步短命令；`xd://exec_command` 用于长时运行、等待外部条件、需要终端或切换 shell 的任务（配合不带 `condition` 的 `xd://monitor` 在结束时唤醒一次）；`eval` 用于代码计算。 |

当某条规则在主会话 system prompt 中找不到匹配文本时（例如升级 OMP 后上游改了内置工具描述），每个进程对每条规则记一次日志并弹一次 UI 警告（headless 模式写 stderr），不阻塞请求。子代理的 system prompt 本就不含 `task` 等工具，不做缺失检查。

### append-system-model

源码：`agent/extensions/append-system-model/`。

每次 `before_agent_start` 时读取 `~/.omp/agent/extensions/append-system-model/APPEND_SYSTEM_MODEL.md`，主会话与每个子代理各自按自身当前模型匹配。该文件属于本机，仓库不提供；修改文件或通过 `/model` 切换模型后，从下一条 prompt 起生效。

文件由 `---` 分隔的块组成：每个块以 YAML 头声明 `model`（匹配模型 id，如 `claude-opus-5-5`）和/或 `provider`（匹配 provider id，如 `^anthropic$`）的 JavaScript 正则，后面接正文直到下一个 `---` 行（正文内部如需分隔线用 `***`）。所有命中的块按文件顺序拼接后追加到 system prompt 末尾；文件不存在时跳过，格式错误时按行号记一次 warning。

### repo-rules

源码：`agent/extensions/repo-rules/`。

OMP 默认扫描 `.omp/rules`、`.agent(s)/rules`、`.cursor/rules`、`.windsurf/rules`、`.clinerules` 与 `.github/instructions`，但不扫描 `.claude/rules` 与 `.pi/rules`，会丢弃既无 `alwaysApply` 也无 `description` 的规则文件，也不处理 Claude Code 的 `paths` frontmatter。

- **无 `paths` 的规则**：从 `cwd` 向上至 git 根目录（不在 git 仓库内时只看 `cwd`）扫描 `.claude/rules`、`.agents/rules`、`.pi/rules` 下的非隐藏 `.md` 与 `.mdc`（离 `cwd` 越近越先，同级按 `.claude` → `.agents` → `.pi` 排序），并扫描 `~/.claude/rules`。每次 `before_agent_start` 追加 `<repo-level-rules>` 块：无 frontmatter、frontmatter 解析失败或 `alwaysApply: true` 的文件注入全文；其余带 frontmatter 的文件只列出名称、`description` 和路径。OMP 已经放进上下文的文件（alwaysApply、rulebook 条目或 TTSR）、正文空白归一后已在 system prompt 中的文件，以及 `rule://<文件名>` 已在列表中的条目均跳过。
- **带 `paths` 的规则**：frontmatter 含 `paths`（YAML 列表或逗号分隔的 glob，支持 `{…}` 与 `[…]`）的规则，只在匹配文件被成功 `read`、`write`、`edit`，或被 `bash` 中读取单文件的纯 `cat`/`head`/`tail` 触及时才加载（含管道、命令串联或多文件的命令不计）。适用范围涵盖上述扫描目录和 OMP 原生发现的全部规则（项目/用户级 `.omp` 与 `.agents`、cursor/windsurf/cline/GitHub 规则、插件或扩展根目录下的 `rules/`）。相对路径 glob 的基准目录：用户级规则为 `cwd`，项目规则为点目录所在父目录，插件或扩展 `rules/` 为该插件或扩展根目录。OMP 原生发现的带 `paths` 规则会从 `<generic-rules>` 和 `<domain-rules>` 中移除，改由文件命中时加载，同时继续遵守 `ttsr.disabledRules` 与 `agents` 作用域。TTSR 规则（`condition`、`astCondition`、`question`）和 OMP 内置规则仍由 OMP 处理。命中的规则通过 `tool_result` 的 `additionalContext`（`<path-scoped-rule path="…">`）每个上下文注入一次；若 compaction、resume 或切分支使该标记离开当前上下文，再次触及匹配文件时会重新注入。
- **绝对路径 `paths` 模式**：以 `/` 或 `~/` 开头的模式直接匹配被触及文件的绝对路径（`~` 为家目录），可用于在 `~/.claude/rules` 中按目录名匹配任意位置的仓库（如 `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**`）。

---

## 上下文与压缩

- **`task` 与 `fork_task`**：普通 `task` 新建空白子代理会话，只传入 `context` 与 `task` 文本，子代理的查找过程和工具输出留在其分支内，主会话只收最终 `yield` 结果。当主会话已经读入大量设计文档或经过多轮对话，无法用几句 `context` 交代清楚时，用 `fork_task` 把当前对话历史复制为子代理的起始上下文。
- **压缩顺序与触发时机**：`agent/config.yml` 将 `compaction.methodOrder` 设为 `[remote, soft, snapcompact, handoff, shake]`，并将 `compaction.asyncEnabled` 设为 `false`。开启 `asyncEnabled` 时，OMP 会在阈值前最多 32k token 提前在后台请求摘要，拿到后一直存到阈值才替换，且 Anthropic 的摘要不会重新生成，这期间每次请求仍发送完整历史；关闭后只在到达阈值时执行压缩。
- **压缩后的状态恢复**：`omp-todo-more` 插件把每次修改状态的 `todo` 调用追加写入 `task-log/<agent-id>.md`，并在主会话完成压缩后自动注入 `ctx list` 与主会话的 `ctx show`。

### fork-task

源码：`agent/extensions/fork-task/`。注册 `fork_task` 工具（顶层 `context` 加不含 `solutionSpace` 的 `tasks[]`，需开启 `async.enabled: true`）。

`fork_task` 派出的仍是原生 `task` 子代理（使用各自的 agent 定义、模型、工具、Agent Hub 条目、`agent://`/`history://` 与 worktree 合并），但初始会话历史复制自调用方当前分支，或某项 `from: "<agent-id>"` 指定的已注册代理：

- `isolated` 默认为 `true`（只读调查且后续需要 `write agent://<id>` 续聊时显式设 `isolated: false`；父会话处于 plan mode 时强制共享目录；隔离子代理结束后不可续聊）。
- `shake: true` 会对复制出的会话执行 `session.shake("elide")`：保留最近约 4,000 token 及 `skill://`、`local://PLAN.md` 读取，把更早的文本工具结果、$\ge 400$ token 的代码块和顶层小写 XML 块替换为 `[shaken ~N tokens — recover: artifact://<id> (region K)]` 存入共享 artifact 目录，子代理可按需 `read` 原文。
- `from: "<agent-id>"`（解析规则同 `agent://<id>`，支持运行中、idle 或 parked 代理）复制该代理已落盘的对话历史。带 `from` 的项必须显式填 `agent`；子代理的工作目录仍取自调用方的 checkout，而非 `from` 代理自己的隔离 worktree。
- 复制出的历史末尾会追加 `<system-notice cause="fork_task">`，说明前面的历史仅作背景，并要求子代理在交回结果前完成相关构建、测试与真实运行验证。
- 暂存步骤：先把源会话复制到 `$TMPDIR/omp-fork-task/<uuid>/`（清零继承费用、为未完成的工具调用补齐中止结果、清空源 Todo、追加 fork notice），移除 `session_init`、`model_change`、`thinking_level_change`、`service_tier_change` 与 shake 产生的 `session_exit` 并将子条目重挂到上一级，共享子代理写入调用方 `cwd`、隔离子代理置空 `cwd`，最后在 `before_subagent_spawn` 中把暂存文件移到 `<父会话文件去掉 .jsonl>/<子代理 id>.jsonl`。

### model-compaction

源码：`agent/extensions/model-compaction/`。

OMP 原生的 `compaction.modelThresholds` 只支持精确 `provider/id` 或 `*` 前缀。该扩展在主会话每次 `before_agent_start` 时读取 agent 目录 `omomp.*` 中的本机 `model-compaction` 段（不读项目 `.omp/` 副本）：

```yaml
model-compaction:
  rules:
    - provider: "^anthropic$"
      model: "opus"
      thresholdTokens: 150000
    - model: "[gG][pP][tT]"
      thresholdTokens: 650000
```

每条规则至少填 `model` 或 `provider` 的 JavaScript 正则（匹配全部模型写 `"model": ".*"`）。对 `ctx.models.list()` 中的每个模型，按文件顺序取第一条命中的规则，把 `"<provider>/<id>": "f<thresholdTokens>"` 写入主会话的运行时设置层（不改磁盘上的 `config.yml`；`/model` 切换、重试回退以及读取主会话设置的子代理都会按各自模型使用对应阈值）。

由于原生 `f<N>` 条目可能改变模型的上下文窗口档位（standard vs extended），凡是会让某个模型切换当前窗口档位的规则都会对该模型跳过并记一次 warning。其他来源已写入的运行时条目会被保留，并在无规则命中或 `session_shutdown` 时恢复；若运行期间有其他代码修改了这张映射表，扩展会记一次 warning 并停止更新。

### ctx

由 [omp-todo-more](plugins-and-modes.zh-CN.md#todo-more) 插件注册（`src/ctx/inventory.ts`），只读汇总当前会话、subagent registry、transcript、compaction 摘要、`.md`/`.json` sidecar 与 task log：

- **`ctx list [<id>] [all=true]`**：按深度优先输出每个上下文的一行状态、单行摘要与 `done/total` 任务数（有阻塞原因时附 `blocked`）。默认只列主会话和 `task` / `task:*` 子代理（隐藏 `mentor`、`discuss`、`trace`，把它们的可见后代上提一级并标注隐藏数量），非根节点后代超过 8 个时折叠为一行（用 `ctx list <id>` 展开；`all=true` 显示除 advisor 外的全部节点）。
- **`ctx show <id>`**：输出三部分：handoff（当前会话取最新 compaction 摘要，其他上下文优先取相邻 `.md` sidecar 全文，其次 `.json` sidecar 的 120 字摘要）、task log 中最后一条有效的 `## Goal`，以及从 task log 重放出的 `## Tasks` 时间线（分 `Completed` 和 `Open`，按任务最后一次被采纳操作的本地时间排序）。
- **日志重放限制**：任务数和时间线由追加写入的 task log 重建，而非直接读取内存中的 `TodoTracker`。`init` 和 `append` 只记任务数不记标题，创建后从未按标题单独操作过的任务会算进 `ctx list` 总数，但不会出现在 `ctx show` 时间线里；已标记完成或删除的标题不会被后续 `start`/`block`/`unblock` 重新打开；标题恰好叫 `all tasks` 的项会被当作批量选择器处理。

### Task log

位于 `omp-todo-more` 插件（`src/ctx/tasklog.ts`）。每次改变状态的 `todo` 或原生 `goal` 工具调用成功后，把本地时间、工具名、操作和目标追加写入 `<local root>/task-log/<agent-id>.md`（带 goal 的 `todo` 调用会再写一行 `todo-more set: <goal JSON>`）。只读的 `todo view`、`goal get` 和失败调用不记录。

### compact 后注入

位于 `omp-todo-more` 插件（`src/ctx/post-compact-hint.ts`）。监听主会话的 `session_compact` 与未中止的 `auto_compaction_end` 事件（5 秒内最多触发一次，子代理不触发），在压缩完成后自动以 steer 消息注入 `<post-compact-ctx>`，包含 `## List`（`ctx list`）和主会话的 `## Current session`（`ctx show`）。
