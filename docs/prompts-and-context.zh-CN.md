# 提示词与上下文

[返回首页](../README.zh-CN.md) · [English](prompts-and-context.md) | 简体中文

## 提示词文件

非空壳 harness 在基础模板、内置工具说明与子代理包装层中自带的预定义文本容易与本地规则重复或冲突，而模型遇到前后矛盾的提示词时会直接忽略。依托 Pi 系（含 `omp`）对系统提示词各阶段的全量定制能力，提示词按职责与作用域拆分为以下文件与扩展，使每条指令只出现一次、消除内置文本与本地规则之间的矛盾，并将主会话文体/顾问规则与子代理或特定模型的增量隔离开来：

| 文件 / 扩展 | 作用域 | 内容与职责 |
|---|---|---|
| `agent/SYSTEM_TEMPLATE.md` | 主会话 + 子代理 | 基于 OMP 内置 `packages/coding-agent/src/prompts/system/system-prompt.md` 维护的 Handlebars 模板（纯文本 `SYSTEM.md` 不解析 Handlebars 表达式）。负责工作流规范、渲染当前工具/技能/规则列表，并通过 `{{#if subagent}}` 将第 4 步切换为主会话 `Verify` 或子代理 `Hand-off`。不重复打印单个工具的调用说明。唯一的工具路由段是 `# Code by Syntax Shape`，每一行只在会话有对应工具时渲染（`{{#has tools "ast_grep"}}`、`{{#has tools "ast_edit"}}`）：按参数找调用、找声明、import 或多行结构交给 `ast_grep` 而不是 `grep` 正则；同一处结构改动出现在多个位置时交给 `ast_edit` 而不是反复调用 `edit`。它放在模板里，是因为模型在读到任何设备说明之前就已决定用哪个工具。 |
| `agent/PERSONALITY.md` | 仅主会话（子代理固定 `personality: none`） | 填充 `# Personality` 下的 `{{personality}}`。前半部分保留 OMP `personality: default` 原文（`Evidence-first terse engineer`）；后半部分定义 `# Writing` 分析与研究写作规范：结论、数字或机制直接开篇，一句话写清时间、主体、动作、规模与来源，多项对象或指标合并进一张表且不在正文逐行复述，删去过程自述、重复解释、叠加免责声明与文末总结。 |
| `agent/APPEND_SYSTEM.md`（轻量模式为空文件 `APPEND_SYSTEM_LIGHT.md`） | 仅主会话 | 增加主会话默认规则：用户的明确指令优先于默认规则；最终回复使用带主语的完整句子、首次提及时指认对象、结论旁附 `path:line` 或实测输出、不用类比；不为省 token 跳过必读文件或截断内容（改设计文档前先通读全文及关联文档）。 |
| [repo-rules](#repo-rules) | 主会话 + 子代理 | 加载 `.claude/rules`、`.agents/rules`、`.pi/rules` 与 `~/.claude/rules` 中的规则文件，并处理所有规则来源的 `paths` 按路径触发。 |
| [tool-topics](extensions.zh-CN.md#tool-topics) | 主会话 + 子代理（完整与轻量模式） | 只为 OMP 自己的工具实例添加 surface 与 `Topics` 索引；由插件或扩展注册的工具保留自己的说明与专题，包括以相同名称替换内置工具的情况，例如 `omp-ask-more` 的 `ask`。OMP 工具的详细调用说明按需读取 `tool://<tool>/<topic>`，`SYSTEM_TEMPLATE.md` 要求调用前先读条件命中的专题。 |
| [system-prompt-replace](#system-prompt-replace) | 按规则（默认所有会话；完整与轻量模式） | 在所有按路径加载的扩展最后运行，按 `REPLACE-SYSTEM-*.yml` 规则文件对渲染出的 system prompt 做措辞级修改；每条规则可以全局生效，也可以限定会话、cwd、模型、provider、当前模型的委派倾向（delegation bias）或模式，并用 `exclude.*` 写明何时不生效。 |
| [append-system-model](#append-system-model) | 按片段（默认仅主会话） | 追加 frontmatter 条件（会话、cwd、模型、provider、当前模型的委派倾向、完整/轻量模式，以及表示何时不注入的 `exclude.*`）命中的 `APPEND-SYSTEM-*.md` 片段。仓库自带 `APPEND-SYSTEM-decision-support.md`：完整模式的主会话中，重大决策询问 `discuss:steady` 与 `discuss:divergent`，长调查在开始前与交付前会商 `mentor:default`；主模型为 `claude-opus-5-5` 时不注入。 |
| [argon-long-output](extensions.zh-CN.md#argon-long-output) | 主会话 + 子代理（各按自己的模型匹配） | 模型为 `google-gemini-cli` 上的 `gemini-4-argon` 时追加仓库下发的 `ARGON_PROMPT.md`：先写骨架、再逐节 `edit`，让每次 `write`/`edit` 内容和最终回复都不超过 8,000 字符。 |
| [tool-topic-injection](extensions.zh-CN.md#tool-topic-injection) | 主会话 + 子代理 | 配置的工具参数命中后才加载专题，每条规则在真实未压缩上下文中注入一次；追加 developer 上下文，而不是扩大常驻工具说明。 |

### system-prompt-replace

源码：`agent/extensions-last/system-prompt-replace/`，登记在 `agent/config.yml` 与 `agent/config-light.yml` 的 `extensions` 列表最后一项。键与匹配规则以其文件头注释为准。

`before_agent_start` 处理器按扩展加载顺序串行执行：native 发现（`~/.omp/agent/extensions/` 与 `settings.json` 模块）→ hooks → 插件扩展 → `-e` 路径 → `config.yml` `extensions` → OMP 内置 inline 扩展。把该扩展放在 `extensions/` 之外的 `extensions-last/` 并排在 `extensions` 列表末项，可使它在两种模式下都在所有按路径加载的扩展之后运行（详见 [`agent/extensions-last/README.zh-CN.md`](../agent/extensions-last/README.zh-CN.md)）。

每次 `before_agent_start` 时（主会话与每个子代理各按自身匹配），扩展读取同目录下的全部 `REPLACE-SYSTEM-<label>.yml`（仓库自带与本机自建文件放在同一目录），以及从会话 cwd 到 git 根每层目录及其 `.omp/` 中的同名模式文件；配合 `config.yml` 的 `inlineToolDescriptors: "on"` 将工具说明内联渲染进 system prompt 后再替换。一个文件是一个由规则组成的 YAML 序列：

```yaml
- literal: "原文"
  replace: "替换文字"
- regex: "JavaScript 正则源码"
  replace: "替换文字，可用 $1、$&"
  target: subagents          # 可选条件，取值为字符串
  model: "^claude-opus"
  exclude.target: "mentor:default"
```

不写条件键的规则对所有会话生效。条件键与 [append-system-model](#append-system-model) 相同（`target`、`cwd`、`model`、`provider`、`mode`、`delegation` 以及 `exclude.` 下的同名键），但这里的默认 target 是所有会话，而不是 `main`。在 `REPLACE-SYSTEM-*.yml` 中，`model` 与 `provider` 字符串以 YAML 解码后的原值作为正则源码，包括解码后字符串内部的引号字符，不会再去掉引号。文件按发现顺序生效，文件内规则按顺序生效，每条作用于前一条的结果。未知键或取值错误时只跳过该文件，并按原因警告一次，其他文件照常生效。

仓库自带的 `REPLACE-SYSTEM-default.yml` 当前包含的替换规则，每条都限定 `mode: full`（其中文件检索与编辑固定使用 `read` + hashline `edit` 并禁止在 `eval` 中查文件，以要求模型在读取目标行邻近上下文后再做修改，避免在缺少编译器与测试保护的脚本、配置或命令行操作中脱离上下文直接修改）：

| 目标 | 修改内容 |
|---|---|
| 子代理 Todo 说明（`target: subagents`） | 删去原生子代理提示词中的 `"No TODO tracking, no progress updates."`，避免与子代理必填 Todo 及 `fork_task` 的验证要求冲突。task 侧的句子（按各 agent 的定义文本选择 agent、显式 `agent`、并发写入隔离、删掉的 “skip build/lint/tests”）改由 [tool-topics](extensions.zh-CN.md#tool-topics) 的 `SURFACE-task.md` 承载。 |
| 用户报错处理规则 | 补充说明“不重跑检查去质疑用户报错”不影响为定位原因而复现和修复后验证。 |
| 编译代码规则 | 补上原句缺失的动词 `add`（`NEVER add avoidable allocation...`）。 |
| `eval` 工具说明 | 禁止通过 `eval` 读取、列目录或搜索本地文件（统一使用 `read`、`glob`、`grep`）。 |
| `eval` 说明：批量分流 | 把 “For 2+ independent items, use a named `workpool()`” 改为按场景分流：代码需要模型逐条判断、抽取或改写时，用 `judgeBatch`，或逐条用带 schema 的 `completion`/`agent`，并指向 `tool://eval/workflow`；结果只需阅读的子代理工作仍用 `workpool()`。限定 `delegation: eager`，因为 OMP 只在当前模型的委派倾向为 `eager` 时才渲染原句。`agent`/`workpool` 的命名空间说明也补上逐条 schema 结果。 |
| `xd://` 设备说明 | 说明 `xd://<tool>` 只能通过 `write` 写入 JSON 调用，不存在 `xd__<tool>` 或裸 `<tool>` 函数。 |

[tool-topics](extensions.zh-CN.md#tool-topics) 按工具名而非原文措辞处理 OMP 自己的工具（`read`、`bash`、`task`）的整段说明，上游改写措辞后仍然生效。

当某条适用于主会话的规则找不到匹配文本时（例如升级 OMP 后上游改了内置措辞），每个进程对每条规则记一次日志并弹一次 UI 警告（headless 模式写 stderr），不阻塞请求。子代理的 system prompt 本就不含 `task` 等工具，不做缺失检查；条件不匹配当前会话的规则直接跳过，不做检查。

更新器把本机 `omomp.yml` 中的 `system-prompt-replace` 段转换成 `REPLACE-SYSTEM-default.yml`，并删除已迁移的段；app-managed 源文件绝不导入或删除（见[文件归属与同步规则](operations.zh-CN.md#文件归属与同步规则)）。

### append-system-model

源码：`agent/extensions/append-system-model/`，键与匹配规则以其文件头注释为准。

每次 `before_agent_start` 时（主会话与每个子代理各按自身匹配），扩展读取同目录下的全部 `APPEND-SYSTEM-<label>.md`（仓库自带与本机自建文件放在同一目录），以及从会话 cwd 到 git 根每层目录及其 `.omp/` 中的同名模式文件。所有命中的片段都会追加，不按名称覆盖；命中的正文按发现顺序拼成一个额外块，追加在 system prompt 末尾。文件每条 prompt 重读，新增或修改片段、`/model` 切换都从下一条 prompt 起生效，无需重启；子代理被 IRC 唤醒的轮次不运行该钩子。

片段由 `---` 包围的 frontmatter 与其后的提示词正文组成：

```markdown
---
target: main
mode: full
exclude.model: ^claude-opus-5-5$
---
# Mandatory decision support
…
```

注入条件键 `target`（默认 `main`；也可写 `subagents`、`*` 或代理名）、`cwd`、`model` 与 `provider` 沿用 `turn-judge` 与 `watchdog-agent` 的语法；`mode` 列出 `full` 和/或 `light`；`delegation` 列出 `eager`、`restrained` 和/或 `gated`。同一键内多项为“或”，不同键为“且”。`exclude.target`、`exclude.cwd`、`exclude.model`、`exclude.provider`、`exclude.mode` 与 `exclude.delegation` 描述何时不注入：片段设置的 `exclude.*` 键全部命中时跳过；未写 `exclude.target` 时排除覆盖所有会话。`model` 与 `provider` 是匹配会话当前模型 id 与 provider 的正则；`delegation` 匹配 OMP 为该模型解析出的委派倾向，OMP 正是按这个值决定往提示词里渲染哪套委派措辞。没有当前模型时，`model`、`provider` 与 `delegation` 在注入与排除两侧都不命中。`omp-light` 以 `OMOMP_MODE=light` 启动 omp，其余情况为 `full`。`enabled: false` 关闭该文件。未知键、正文为空或取值错误时只跳过该文件，并按原因警告一次，其他文件照常生效。

`APPEND-SYSTEM-*.md`、`WATCHDOG-*.md` 与 `TURN-JUDGE-*.md` 的 frontmatter 中，模型/provider 正则字段在编译前会去掉包围值的一对引号；这与 `REPLACE-SYSTEM-*.yml` 中已经过 YAML 解码的字符串不同。

旧的单文件格式 `APPEND_SYSTEM_MODEL.md` 由更新器按块拆成 `APPEND-SYSTEM-model-NN.md`，每个文件带 `target: *`，保持原来对主会话和子代理都生效的范围（见[文件归属与同步规则](operations.zh-CN.md#文件归属与同步规则)）。

### repo-rules

源码：`agent/extensions/repo-rules/`。

OMP 默认扫描 `.omp/rules`、`.agent(s)/rules`、`.cursor/rules`、`.windsurf/rules`、`.clinerules` 与 `.github/instructions`，但不扫描 `.claude/rules` 与 `.pi/rules`，会丢弃既无 `alwaysApply` 也无 `description` 的规则文件，也不处理 Claude Code 的 `paths` frontmatter。

- **无 `paths` 的规则**：从 `cwd` 向上至 git 根目录（不在 git 仓库内时只看 `cwd`）扫描 `.claude/rules`、`.agents/rules`、`.pi/rules` 下的非隐藏 `.md` 与 `.mdc`（离 `cwd` 越近越先，同级按 `.claude` → `.agents` → `.pi` 排序），并扫描 `~/.claude/rules`。每次 `before_agent_start` 追加 `<repo-level-rules>` 块：无 frontmatter、frontmatter 解析失败或 `alwaysApply: true` 的文件注入全文；其余带 frontmatter 的文件只列出名称、`description` 和路径。OMP 已经放进上下文的文件（alwaysApply、rulebook 条目或 TTSR）、正文空白归一后已在 system prompt 中的文件，以及 `rule://<文件名>` 已在列表中的条目均跳过。
- **带 `paths` 的规则**：frontmatter 含 `paths`（YAML 列表或逗号分隔的 glob，支持 `{…}` 与 `[…]`）的规则，只在匹配文件被成功 `read`、`write`、`edit`，或被 `bash` 中读取单文件的纯 `cat`/`head`/`tail` 触及时才加载（含管道、命令串联或多文件的命令不计）。适用范围涵盖上述扫描目录和 OMP 原生发现的全部规则（项目/用户级 `.omp` 与 `.agents`、cursor/windsurf/cline/GitHub 规则、插件或扩展根目录下的 `rules/`）。相对路径 glob 的基准目录：用户级规则为 `cwd`，项目规则为点目录所在父目录，插件或扩展 `rules/` 为该插件或扩展根目录。OMP 原生发现的带 `paths` 规则会从 `<generic-rules>` 和 `<domain-rules>` 中移除，改由文件命中时加载，同时继续遵守 `ttsr.disabledRules` 与 `agents` 作用域。TTSR 规则（`condition`、`astCondition`、`question`）和 OMP 内置规则仍由 OMP 处理。命中的规则通过 `tool_result` 的 `additionalContext`（`<path-scoped-rule path="…">`）每个上下文注入一次；若 compaction、resume 或切分支使该标记离开当前上下文，再次触及匹配文件时会重新注入。
- **绝对路径 `paths` 模式**：以 `/` 或 `~/` 开头的模式直接匹配被触及文件的绝对路径（`~` 为家目录），可用于在 `~/.claude/rules` 中按目录名匹配任意位置的仓库（如 `/**/{omp,.omp,omp-*,*-omp,*-omp-*}/**`）。

`repo-rules` 和条件专题注入共用 `_shared/context-delivery.ts`：是否已经投递由活动叶节点模型上下文中的持久 developer 标记决定；临时 turn 集合只覆盖宿主尚未持久化的工具批次窗口。

---

## 上下文与压缩

- **`task` 与 `fork_task`**：普通 `task` 新建空白子代理会话，只传入 `context` 与 `task` 文本，子代理的查找过程和工具输出留在其分支内，主会话只收最终 `yield` 结果。当主会话已经读入大量设计文档或经过多轮对话，无法用几句 `context` 交代清楚时，用 `fork_task` 把当前对话历史复制为子代理的起始上下文。
- **压缩顺序与触发时机**：`agent/config.yml` 将 `compaction.methodOrder` 设为 `[remote, soft, snapcompact, handoff, shake]`，并将 `compaction.asyncEnabled` 设为 `false`。开启 `asyncEnabled` 时，OMP 会在阈值前最多 32k token 提前在后台请求摘要，拿到后一直存到阈值才替换，且 Anthropic 的摘要不会重新生成，这期间每次请求仍发送完整历史；关闭后只在到达阈值时执行压缩。

### fork-task

源码：`agent/extensions/fork-task/`。注册 `fork_task` 工具（顶层 `context` 加不含 `solutionSpace` 的 `tasks[]`，需开启 `async.enabled: true`）。它的前置条件、不支持的字段和来源报错写在专题 `xd://fork_task/limits` 中，在 eval 单元中按模板批量分叉写在专题 `xd://fork_task/batch` 中；两者都由工具自己的 `docTopics()`（`topics.ts`）提供，并列在其说明末尾。

`fork_task` 保留原生 Agent Hub、结果投递、`agent://`/`history://`、后续消息与隔离工作区合并。每个子代理都复刻源的最近一次模型请求（调用方的，或 `from` 指定的活跃代理的），同一源的多个分叉共享供应商缓存前缀；任何任务项都不改写 system prompt。`agent` 只决定模型与角色：

| 任务项 | 模型 | 任务消息 | 默认工作区 | 用途 |
|---|---|---|---|---|
| 省略 `agent` | 源的模型、thinking 等级与请求参数 | `context` + `task` | 共享（`isolated: false`） | 从源开出另一条执行分支，复用已有缓存前缀 |
| 显式填写 `agent` | 该 agent 在 `task.agentModelOverrides` 中的绑定，否则取定义里的 `model` | `<role agent="…">` 包裹的定义正文 + `context` + `task` | 隔离（`isolated: true`） | 让另一个角色接着源的工作做，通常换更便宜的模型 |

- **前缀复刻**：`replica.ts` 在每个会话的 `Agent.streamFn` 捕获实际 `Context`，位置在 SDK 的提醒、图片、上下文变换之后、供应商序列化之前。子代理复用这份 system/工具定义前缀和分叉点以前的源消息；运行源的模型时还复用 thinking/service-tier/temperature/max-token 参数和 prompt-cache key，换成其他模型则用该模型自己的参数。共享 `context`、角色和任务接在继承历史后，作为子代理的 user 消息。所有子代理都以内部 `fork:self` 派发，工具调用由子会话自己的实现执行，存在的 `yield` 追加在源工具之后。子代理以 `fork:self` 运行源的工具面，所以指定 agent 的工具限制、派发策略、按 agent 配置的 service-tier、压缩阈值与账号池，以及按 agent 名生效的钩子（如 [`task-completion-judge`](extensions.zh-CN.md#task-completion-judge)）都不生效。实现只有一条供应商无关的路径，不分别改写 Anthropic/OpenAI payload。子会话的对话和传输身份保持独立；原生 `ask` 仍遵守 headless 限制。
- **缓存与生命周期边界**：模型相同、请求参数兼容是必要条件；是否命中仍由供应商的缓存策略、路由和 TTL 决定。改 `effort` 不影响复刻的前缀。不支持追加工具保留缓存的供应商可能因新增 `yield` 而 miss。请求快照保存在创建它的 OMP 进程中，支持同进程 idle/park/revive。OMP 可能把子代理放进子代理 worker 线程（`task.workerThreads`），该线程加载自己的一份扩展副本；因此父会话的派发钩子还会把复刻请求的纯数据写到 `$TMPDIR/omp-fork-task/replicas/`，这类子代理从那里读取。`from` 指向 worker 线程中的代理时无法从别的线程复刻，因为它的请求只在它自己的线程里捕获：应给它发消息，让它自己调用 `fork_task`。会话自己的快照在该会话 dispose（关闭或 idle park）时释放，分叉子代理的复刻请求及其副本保留到父会话关闭。两者只保存纯请求数据（消息、工具 schema），至多再加一个借给 headless 子代理的 `ask` 工具（副本中没有），所以 park 后的会话不会因它们留在内存中。进程重启或父会话关闭后丢失快照的子代理会在请求供应商前失败，应创建新分叉。压缩改变子会话上下文后，包装器停止替换继承消息；未压缩时锚点缺失或不唯一则报错，不猜测拼接位置。
- **工作区覆盖**：`isolated` 覆盖默认值。并发写入必须显式选择 `isolated: true`；plan mode 强制共享、只读子代理；隔离子代理完成后不能继续唤醒。
- **Shake 必须显式选择**：`shake` 默认为 false，任何任务项都不检查继承 token 数或来源成本。显式 `shake: true` 对副本执行 `session.shake("elide")`，保留最近约 4,000 token 及 `skill://`、`local://PLAN.md` 读取，把更早的文本工具结果、$\ge 400$ token 的代码块和顶层小写 XML 块替换成共享 artifact 中的恢复引用。开启 shake 的分叉明确不再回放原始消息前缀。
- **拒绝的任务项**：`tools` 不是 fork 字段，子代理只暴露源的工具。未知 agent、`task.disabledAgents` 中的 agent 或 `fork:self` 本身在派发前报错。
- **执行失败**：execute 边界捕获失败，在暂存清理后记录警告并返回 `isError` 工具结果；只有用户中止（`signal.aborted`）会重新抛出，交由宿主处理取消。
- `from: "<agent-id>"`（解析规则同 `agent://<id>`）复刻运行中或 idle 的代理而非调用方：先捕获它的最近一次请求，再落盘并复制它的对话历史。parked 代理没有可复刻的活跃请求，派发前报错，需先用 `write agent://<id>` 唤醒。子代理的工作目录仍取自调用方的 checkout，而非 `from` 代理自己的隔离 worktree。
- 复制出的历史末尾会追加 `<system-notice cause="fork_task">`，说明前面的历史仅作背景，并要求子代理在交回结果前完成相关构建、测试与真实运行验证。
- 暂存步骤：先把源会话复制到 `$TMPDIR/omp-fork-task/<uuid>/`（清零继承费用、为未完成的工具调用补齐中止结果、清空源 Todo、追加 fork notice），移除 `session_init`、`model_change`、`thinking_level_change`、`service_tier_change` 与 shake 产生的 `session_exit` 并将子条目重挂到上一级，共享子代理写入调用方 `cwd`、隔离子代理置空 `cwd`，最后在 `before_subagent_spawn` 中把暂存文件移到 `<父会话文件去掉 .jsonl>/<子代理 id>.jsonl`。

### model-compaction

源码：`agent/extensions/model-compaction/`。

OMP 原生的 `compaction.modelThresholds` 只支持精确 `provider/id` 或 `*` 前缀。该扩展在主会话每次 `before_agent_start` 时依次读取项目（`<cwd>/.omp/`，随会话当前目录变化）与 agent 目录（本机）`omomp.*` 中的 `model-compaction` 段，取第一份有效副本整段使用，两份不合并：

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

由于原生 `f<N>` 条目可能改变模型的上下文窗口档位（standard vs extended），凡是会让某个模型切换当前窗口档位的规则都会对该模型跳过并记一次 warning。项目副本在该项目中整段取代本机规则，仍需要的本机规则要在项目副本里重写一遍；项目副本写 `rules: []` 即在该项目关闭本机规则。无法读取、有歧义或无效的副本会被跳过并记 warning，改用下一个位置：项目副本无效时回落到本机副本，没有任何有效副本时不应用规则。其他来源已写入的运行时条目会被保留，并在无规则命中或 `session_shutdown` 时恢复；若运行期间有其他代码修改了这张映射表，扩展会记一次 warning 并停止更新。

### ctx

[omp-todo-more](plugins-and-modes.zh-CN.md#todo-more) 插件拥有 `ctx` 与 `todo`；`agent/config.yml` 关闭原生 `todo`。更新器在安装插件前预检待退役本地 Todo/ctx 文件的归属；只有 OMP 确认插件就绪后才删除列出的 Todo 文件，且只有该就绪插件带有 `src/ctx` 时才删除列出的 ctx 文件。

工具文档：`xd://ctx` 与 `xd://todo`。
