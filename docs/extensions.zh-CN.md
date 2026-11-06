# 本地扩展

[返回首页](../README.zh-CN.md) · [English](extensions.md) | 简体中文

## 本地扩展总览表

配置文件承载用户可以按自己工作方式调整的选择。仓库随附的规则和值是一组可运行的示例：加载且满足适用条件时，在配置的范围内决定行为，也可以通过支持的配置接口修改或替换。各节说明作用域和加载方式；[更新归属](operations.zh-CN.md#文件归属与同步规则)说明后续更新怎样保留或合并本机修改。

| 序号 | 扩展目录 | 所在章节 | 作用域 | 轻量模式 | 配置来源（`omomp.yml` 段或同目录文件） | 用户可定制内容 |
|---|---|---|---|---|---|---|
| 1 | `system-prompt-replace` | [提示词与上下文](prompts-and-context.zh-CN.md#system-prompt-replace) | 按规则（默认主 + 子） | 是 | `REPLACE-SYSTEM-*.yml`（仓库示例、本机或项目文件） | 修改或添加所需的措辞规则及会话条件；OMP 升级后核对匹配原文 |
| 2 | `append-system-model` | [提示词与上下文](prompts-and-context.zh-CN.md#append-system-model) | 主 + 子 | 是 | `APPEND-SYSTEM-*.md`（仓库示例、本机或项目文件） | 修改或添加指令片段，选择适用会话、项目、模型和模式 |
| 3 | `repo-rules` | [提示词与上下文](prompts-and-context.zh-CN.md#repo-rules) | 主 + 子 | 是 | 已发现目录中的规则文件 | 在 `.claude/rules`、`.agents/rules`、`.pi/rules` 或 `~/.claude/rules` 编写自己的规则及 `paths` 条件 |
| 4 | `fork-task` | [提示词与上下文](prompts-and-context.zh-CN.md#fork-task) | 主 + 子 | 否 | 无扩展配置文件 | 每次调用选择来源会话和目标角色；模型沿用当前会话或目标 agent 的绑定 |
| 5 | `model-compaction` | [提示词与上下文](prompts-and-context.zh-CN.md#model-compaction) | 主写 / 子读 | 是 | `omomp.yml#model-compaction`（本机或项目） | 按自己的模型和项目设置阈值；项目段整段取代本机段 |
| 6 | `user-prompt-inject` | [子代理](agents.zh-CN.md#user-prompt-inject) | 子代理 | 否 | `PROMPT-INJECT-*.md`（仓库示例或本机文件） | 修改或添加模板，选择目标角色及其接收的用户原话和回答 |
| 7 | `isolation-nudge` | [isolation-nudge](#isolation-nudge) | 主 + 子 | 否 | 无配置文件 | 在 task 调用中显式设置 `isolated`，选择共享只读工作或隔离写入 |
| 8 | `task-split-check` | [task-split-check](#task-split-check) | 主 (`split`) / 主+子 (`report-limit`) | 否 | `omomp.yml#task-split-check` | 选择回退角色与 `agents` 列表（`split` 覆盖的 worker 名），将 `@task-split-check` 或 `modelRoles.smol` 绑定到自己的可用模型 |
| 9 | `task-completion-judge` | [task-completion-judge](#task-completion-judge) | 声明 `completionJudge: true` 的子代理 | 否 | `omomp.yml#task-completion-judge` | 在 agent 定义中声明 `completionJudge: true`，选择回退角色，将 `@task-completion-judge` 或 `modelRoles.smol` 绑定到自己的可用模型 |
| 10 | `tool-policy-nag` | [tool-policy-nag](#tool-policy-nag) | 主会话（`pty` 通道：主 + 子） | 否 | `omomp.yml#tool-policy-nag` 与 `INTENT-policy.md` | 按工作方式调整检测模式、提醒措辞与频率、意图及风险设置和终端路由通道 |
| 11 | `watchdog-agent` | [watchdog-agent](#watchdog-agent) | 主 + 子，按文件条件 | 否 | `WATCHDOG-*.md`（本机或项目） | 定义审阅内容、目标会话、间隔和投递方式；存在匹配文件后运行 |
| 12 | `turn-judge` | [turn-judge](#turn-judge) | 主 + 子，按文件条件 | 否 | `TURN-JUDGE-*.md`（仓库示例或本机文件） | 编写判定问题、触发规则、提醒和会话条件，绑定适合的判定或聊天模型 |
| 13 | `lang-nag` | [lang-nag](#lang-nag) | 主会话 | 否 | `omomp.yml#lang-nag` | 在本机或项目中选择回复语言与提醒措辞；需要专用聊天判定时绑定 `@lang-nag` |
| 14 | `child-memory-warning` | [child-memory-warning](#child-memory-warning) | 进程全局，仅 macOS | 是 | `omomp.yml#child-memory-warning` | 在本机或项目中按自己的硬件和负载选择告警阈值 |
| 15 | `input-polish` | [input-polish](#input-polish) | 主 TUI | 是 | `omomp.yml#input-polish` | 选择快捷键、改写指令和回退角色，绑定 `@input-polish` 或 `modelRoles.smol` |
| 16 | `doc-polish` | [doc-polish](#doc-polish) | 主 + 子 | 否 | `omomp.yml#doc-polish`（本机） | 选择回退角色、并发数和 `@doc-polish.*` 模型绑定 |
| 17 | `wt-tool` | [wt-tool](#wt-tool) | 主 TUI | 是 | 无配置文件 | 通过工具选择工作树分支，并核对移除时的状态 |
| 18 | `harness-restart` | [harness-restart](#harness-restart) | 主 TUI | 是 | 无配置文件 | 带原因请求重启，重启后恢复会话 |
| 19 | `antigravity-wire-profiles` | [antigravity-wire-profiles](#antigravity-wire-profiles) | 根主会话，以及每个子代理 worker 线程的第一个会话；按线程的表 | 是 | 提供商报告的模型元数据 | 有凭据时从 Antigravity 刷新输出容量；无本地策略文件 |
| 20 | `omp-config-autoupdate` | [安装、同步与维护](operations.zh-CN.md#omp-config-autoupdate) | 根主会话 | 是 | `omomp.yml#omp-config-autoupdate`（本机） | 通过 `/omp-config-autoupdate` 选择启动更新及冲突处理方式，按需适配冲突 |
| 21 | `omomp-lang` | [omomp-lang](#omomp-lang) | 进程全局 | 是 | agent 目录的 `omomp.yml#omomp-lang` 或环境变量 | 在本机段选择界面语言，或用 `OMOMP_LANG` 覆盖 |
| 22 | `tool-topics` | [tool-topics](#tool-topics) | 主 + 子；进程全局路由 | 是 | 同目录的 `TOPIC-*.md` 和 `SURFACE-*.md` | 修改或添加 OMP 自有工具的说明与专题，重启 OMP 后加载 |
| 23 | `tool-topic-injection` | [tool-topic-injection](#tool-topic-injection) | 主 + 子 | 是 | `omomp.yml#tool-topic-injection` | 在本机或项目中选择工具参数匹配及专题；空规则列表关闭注入 |
| 24 | `delete-guard` | [delete-guard](#delete-guard) | 主 + 子 | 是 | 无配置文件或开关 | 选择字面删除路径；默认可恢复，永久删除需要明确确认 |
| 25 | `subagent-usage` | [subagent-usage](#subagent-usage) | 主 + 子 | 是 | 本机授权与本地校准数据 | 用户本人通过 `/subagent-usage` 启停历史访问，项目文件不能授权 |
| 26 | `argon-long-output` | [argon-long-output](#argon-long-output) | 主 + 子 | 是 | `ARGON_PROMPT.md` 与支持的流超时设置 | 为匹配模型定制长输出指令和显式超时预算 |
| 27 | `ast-top-level` | [ast-top-level](#ast-top-level) | 进程全局 + 主 + 子 | 是 | 无扩展配置文件 | 语法工具开关由 OMP 提供；本扩展让启用的工具直接可见，停用后需重启 |

---

## 任务派发与交付检查

### isolation-nudge

源码：`agent/extensions/isolation-nudge/`。

在主会话与子代理的 `tool_call` 阶段检查 `task` 调用；本扩展不检查 `fork_task`。填写 `agent` 的分叉默认隔离，省略 `agent` 的分叉默认共享 cwd，因此并发写入的 fork 必须显式设 `isolated: true`。当一次 `task` 调用会让 $\ge 2$ 个可写代理（`task:*`、内置 `task`、未填 `agent` 的项、`m1` 等，合并计算本次批次与当前会话仍在运行的共享写入任务）在未设 `isolated: true` 的情况下共用同一工作目录，且其中有未显式填写 `isolated` 的项时，按该项 `task` 文本的 SHA-256 拦截一次，提示写入任务设 `isolated: true`、只读任务设 `isolated: false`；相同 `task` 文本再次调用时放行。

### task-split-check

源码：`agent/extensions/task-split-check/`。

在 `tool_call` 阶段检查 `task` 与 `fork_task`。整批共用 25 秒超时，各任务项并发判定，同一项的全部适用是非检查合在一次模型请求中提问，任一项不通过即拦截整次调用：

- **判定模型**：先取 OMP 模型角色 `@task-split-check`（在 `/model` 中配置，保存在本机 `modelRoles`），再取 `omomp.yml#task-split-check.fallbackRole`（仓库配置 `smol`），每次调用实时解析。角色条目未带 `:level` 后缀时使用 `medium` 推理强度；遇到 provider 错误时换链中的下一个模型。
- **split 覆盖范围**：`omomp.yml#task-split-check.agents` 列出 `split` 检查覆盖的 `agent` 名。仓库默认值覆盖仓库的 worker 档位（`task:low`、`task:free`、`task:mid`）；更新器只在本机缺少时写入一次，此后归本机。`report-limit` 检查与此列表无关，对所有 `task:*` 生效。
- **失败处理**：配置缺失或无效时仅移除配置的回退角色；`@task-split-check` 能解析出模型时仍继续判定。没有可用模型或有效结论（包括请求报错、超时或答案无法解析）时放行。每次完成判定记一条 `task-split-check verdicts` 日志。

重试身份由共享 `context` 与该项 `task` 各自去除首尾空白后渲染的提示词决定；要复用结论，二者都必须保持不变。

| 检查项 | 适用范围 | 判定问题 | 缓存与重试行为 |
|---|---|---|---|
| `split` | 主会话 `task` 调用中 `agent` 列在 `omomp.yml#task-split-check.agents` 的项 | 只看该项的 `task` 文本（共享 `context` 仅作背景）：是否把多个互不相关的主题塞进了同一个子代理（按主题而非文件数判断）？ | 缓存所有结论（`pass-repeats`）：单主题边界可能存在判断分歧，被拦后若主会话确认属于同一主题，并保持共享 `context` 和该项 `task` 不变重发，第二次调用放行。 |
| `report-limit` | 任意会话 `task` 与 `fork_task` 中派给 `task:*` 或未填 `agent` 的项 | 同时看共享 `context` 与该项 `task`：是否限制了子代理返回报告的长度（字数、行数、段落数、token 数或“简短汇报”；对写入仓库文件的交付物限制长度不算）？ | 只缓存通过结论（`skip-clear`）：限制报告长度会截断父会话验收所需的证据，必须删掉字数限制（长报告可写到 `local://<name>.md`），原样重发继续拦截。 |

### task-completion-judge

源码：`agent/extensions/task-completion-judge/`。

在 frontmatter 声明 `completionJudge: true` 的子代理调用终止性结构化 `yield` 时运行（仓库自带的 `task:free`、`task:mid`、`task:low` 声明了该键；其他子代理、主会话、报错 `yield` 与增量提交不拦截）：

- **输入内容（60k token 预算）**：读取当前分支最后一条 `session_init` 中的任务说明（忽略 `fork_task` 继承的前置历史）、system prompt 中的共享背景、子代理 Todo 的 `goal`、本次 `yield` 提交内容（最多 6,000 字符），以及 `session_init` 之后从最新一条往前能装入剩余预算的连续工具调用与结果（单条参数和结果各最多 800 字符，超长保留前 60% + 后 40%；按 ASCII 字符 1 token、非 ASCII 字符 2 token 估算）。
- **判定模型与标准**：先取 `@task-completion-judge`，再取 `omomp.yml#task-completion-judge.fallbackRole`（仓库配置 `smol`），每次判定实时解析，未带 `:level` 时使用 `low` 推理强度，超时 25 秒，provider 报错时换链中下一个模型，返回 `DONE` 或 `NOT_DONE`。若子代理的 Todo `goal` 缩小了派工范围、`goal` 中声明的验证方式未在工具调用中出现，或未达到 `doneWhen`（包括报告 blocker），均判为 `NOT_DONE`。
- **退回规则**：
  1. 首次判为 `NOT_DONE` 时拦截 `yield` 并返回原因，要求子代理继续完成并验证。
  2. 判为 `DONE` 后，同步触发 `omp-todo-more:read` 读取最新 Todo 列表；若仍有 `pending` 或 `in_progress` 项（`blocked` 项不计），再拦截一次并列出这些项的说明，要求先更新 Todo 状态。
  3. 每种退回在每个子代理会话中各最多发生一次，避免真实受阻的子代理陷入死循环；通过后，该会话后续 `yield` 不再拦截。判定结论只写日志（`task-completion-judge verdict`），`yield` 数据保持 agent 的 `{ report }` schema。配置、模型或插件读取失败时记 warning 并放行。

### subagent-usage

源码：`agent/extensions/subagent-usage/`。人类侧 `/usage` 在 AI 侧的对应物：只读工具 `subagent_usage`（无参数；主会话与子会话、完整与轻量模式）估算每个可用子代理在其首位绑定模型的供应商额度耗尽前还能派发几次。仓库不带任何校准数据；每台机器只在人工授权后，用自己的会话与用量历史校准。

- **授权**：agent 目录下 `omomp.yml#subagent-usage` 的 `{ enabled: true }`（项目 `.omp/omomp.*` 不能授权；属于 `LOCAL_OMOMP_SECTIONS`），只由人工命令 `/subagent-usage on|off|status|recalibrate|reset` 写入。`on` 即同意读取本机会话记录与用量历史，并在后台开始首次校准。未授权时什么都不读，工具保持未激活；每次校准开始前、写入结果前以及每次工具调用都会重新检查授权。`off` 停止正在进行的扫描，保留数据但不再使用；`reset` 删除数据；`status` 只读已存数据的元信息。全程不调用任何模型，校准是确定性代码。
- **校准**：一个 Bun Worker 读取会话根目录下的全部会话文件，每行只看前 256 字节决定是否需要，只解码需要的条目，并维护按文件大小与修改时间索引的逐文件聚合缓存（`<agentDir>/cache/subagent-usage/transcripts.json`），之后只读新增或改动的文件。本机首次全量扫描 28,237 个会话文件耗时 59 秒，内存峰值 262 MB；有缓存时重扫耗时 0.6 秒。随后主线程原子写入 `<agentDir>/subagent-usage/calibration.json`：
  - **单次派发均值**，在 `on` 与 `recalibrate` 时计算：本机已结束派发按 agent + 模型 + 思考强度、以及按模型 + 思考强度分组的平均 USD（至少 3 次；合格派发须完全运行在其 `session_init` 解析出的模型上、没有回退记录，并写过 `session_exit` 或已 30 分钟未修改），以及 ln 成本的合并离散度 $\sigma$。
  - **额度换算常量**，取最近 21 天，超过一天后在工具调用内重算，因此套餐或额度变化会随窗口滚动淘汰：按账号与额度窗口计算（键由供应商、usage history 账号键的无盐 SHA-256 前 16 位十六进制、额度 id 与窗口 id 组成；文件里没有原始账号键、邮箱或凭据，但这个指纹是稳定的，且账号键可能含邮箱，因此可被猜出），用该额度经供应商策略适用的模型在本机的花费，除以该额度已用比例的增量，只计入该账号这个额度有同一重置周期内快照对、且该供应商其他账号空闲的小时；取该比值与每日比值 25 分位数（变动至少 5% 的天，至少 3 天）中的较小者。历史不足的额度记录原因，不给常量。同一账号换套餐不会被立即识别：新旧套餐的天数同在窗口内时较小者占优，所以升级后最长 21 天内数字偏低，降级后几天内即降到新水平。
- **不跟踪的渠道**不进入任何均值、估算或定价（扫描按文件聚合，会读到所有会话文件，但会丢弃这些渠道的条目）：omp 没有用量报告的供应商、models.yml 自定义了传输的供应商（`baseUrl`、凭据、`api`、headers、auth、discovery），以及 models.yml 定义的模型或覆盖了 headers 的模型。只改元数据的覆盖（如上下文窗口、价格）不影响跟踪。
- **只看首位模型**：绑定按 `task` 执行器的方式解析（`resolveAgentModelPatterns`，再只用第一个模式调 `resolveModelOverride`）。逗号之后的回退模型不进入任何计算；首位模型不在模型注册表中时报告为不跟踪。
- **单次派发估算**：取该 agent 在首位模型上、会话文件在最近 21 天内有改动的全部合格派发（合格规则与单次派发均值相同），范围是项目会话。项目会话指调用方所属顶层会话的会话目录（沿 `AgentRegistry` 的 parent 链向上找，所以子代理不论是否隔离，都与其主会话汇总同一批会话），加上它的 git worktree 和 agent 管理的 worktree（`worktreeSessionDirs`）。每次调用工具都经逐文件缓存重扫，只读上次扫描后改动过的会话文件。有 $n \ge 1$ 次时取对数正态均值 $\exp(\overline{\ln c} + \sigma^2/2)$，$\sigma$ 用本机值（本机没有 $\sigma$ 或有派发成本为 0 时改用算术平均）；窗口内一次都没有时依次取本机该 agent 在该模型上的均值、该模型的均值；再没有则不给估算。
- **额度**：取 `AgentSession.fetchUsageReports` 的报告，即人类侧 `/usage` 的数据源。每份实时报告按账号 id、邮箱或抓取时间匹配到 usage history 的账号。对每个账号，用供应商排序策略保留适用于该模型的额度（plan gate、`scopeLimitsForReserve` 或 `scopeLimits`），去掉重置时间已过的窗口，用该账号的常量为剩余比例定价；账号取其中最小值，只要有一个适用额度缺常量，该账号就不计入并列出原因。账号之间相加，因为 OMP 会把每次请求路由到仍有余量的账号；部分账号未定价时标为下限。
- **输出**：先列规则（同一 pool 内的次数互为替代、不可相加；不计重置后的恢复；只看首位模型；PENDING、NOT TRACKED、NO ESTIMATE 表示没有数字，绝不表示无限），再按供应商分 `POOL <provider>` 段列出共享额度的 agent，每行给出次数、单次派发 USD 及其来源与可信度、剩余额度、最紧的窗口与重置时间；最后列 PENDING（有额度但暂时无法定价）与 NOT TRACKED。

---

## 基于 `JUDGE` 角色的扩展

`turn-judge`、`tool-policy-nag` 的 `intent` 通道（`detector: jev` 时）、`watchdog-agent` 的选项模式与 `lang-nag` 以自身扩展名作为 purpose 调用 `agent/extensions/_shared/judge.ts` 中的 `openJudge`。purpose 既是用量记录的标签，也是该扩展自己的模型角色名（`@turn-judge`、`@tool-policy-nag`、`@watchdog-agent`、`@lang-nag`，登记在 `agent/config.yml` 的 `modelTags`）：

1. `@<purpose>` 解析出聊天模型时（在 `/model` 中配置，保存在本机 `modelRoles`），按链顺序由这些模型以提示式判定（`TextJudge`）作答，之后接 `omomp.yml#judge.fallbackRole` 的聊天模型。此时跳过 OMP 的 judge 角色链，该 purpose 不会由原生或本地判定模型作答。`judge` 模型答不好某个扩展的问题时绑定该角色，例如原生判定模型把英文回复判成中文时绑定 `@lang-nag`。
2. 否则先走 OMP 的 judge 角色链（`resolveJudge`：`modelRoles.judge` → `retry.fallbackChains.judge` → OMP 内置默认链）。跳过无凭据候选，遇到 provider 错误换下一个（401/402/403 使该候选冷却 5 分钟），遇到中止或超时立即停止。从链中第一个原生判定 API 模型起只保留原生候选，`openJudge` 不把当前会话模型加入链中。
3. 当上述链因中止、超时以外的原因失败，或未解析出任何模型时，改用 `omomp.yml#judge.fallbackRole`（仓库配置 `tiny`，即 `@tiny`：`modelRoles.tiny` → `retry.fallbackChains.tiny`，跳过本地 `local` 模型）中的聊天模型，以提示式判定（`TextJudge`）作答。未配置 `judge` 段则不回退。
4. 提示式判定的概率为 one-hot（选中项为 1），低于 1 的阈值只看选中项。每次请求都以 purpose 记入会话用量账本，提示式请求另记作答模型所属的角色。相同的原生请求复用 OMP 判定缓存，提示式请求不复用。角色设置与 `omomp.yml#judge` 在每次触发时重读。

### tool-policy-nag

源码：`agent/extensions/tool-policy-nag/`。`form`、`intent`、`risk` 通道只在主会话运行；`pty` 通道在主会话和子会话都运行。

在 `tool_call` 阶段检查宿主 `bash`、`bash_bg`（含写往 `xd://bash`、`xd://bash_bg` 的调用）和 `eval`；所有通道都忽略插件调用。`pty` 通道在执行前拒绝；提醒通道不拦截。提醒通道将长会话中违反宿主工具路由的调用作为偏离静态 system prompt 的信号：`form.prompt` 不是系统通知，而是以直接观察措辞发送的 user 角色 steer。启发式检测刻意不压低误报率：观察到的误报仅增加少量自检思考 token，未产生其他负面副作用。

每次调用重读 `omomp.yml#tool-policy-nag`（项目 `.omp/omomp.*` 优先于 agent 目录 `omomp.*`；无有效配置段时不运行）：

```yaml
tool-policy-nag:
  detector: heuristic
  form:
    prompt: 你为什么不遵守system prompt，反思自己以后继续。
    afterHits: 3
    maxNags: 3
  intent:
    threshold: 0.5
  risk:
    minCommands: 4
    minChars: 600
    minPrograms: 3
  pty: {}
```

- **`pty` 通道（`pty.ts`，阻断，主会话与子会话，不调模型）**：在 `tool_call` 中最先运行，与 `detector` 取值无关；只有配置段里有 `pty` 对象、且发起调用的会话的活动工具（`pi.getActiveTools()`）包含 `exec_command` 时才运行，否则一律放行。它在任何进程启动前拒绝运行以下各类命令的 `bash` 调用（直接调用、写往 `xd://bash`——在外层 `write` 上拒绝——或经 eval 的 `tool.bash` 桥；`pty: true` 不豁免）和 eval cell：
  - **passthrough**：命令交给另一台机器、另一个容器、另一个用户或另一个 shell 解释：`ssh`（`-G`/`-V`/`-O` 除外）、`mosh`、`vagrant ssh`、`gcloud compute ssh`、`aws ssm start-session`、`docker`/`podman`/`nerdctl` 的 `exec`/`run`、`docker compose`/`docker-compose` 的 `exec`/`run`、`kubectl` 的 `exec`/`run`/`debug`/`attach`、`incus`/`lxc` 的 `exec`/`shell`、`pct exec`/`enter`、`qm guest exec`/`terminal`、带 `-m` 或 `run`/`shell` 或无参数的 `orb`/`orbctl`、`limactl shell`、`multipass exec`/`shell`、`distrobox enter`、`nsenter`、`su`、`bash`/`zsh`/`sh`/`dash`/`ksh`/`fish -c`、`pwsh`/`powershell -c`/`-Command`；
  - **terminal**：需要终端或会停在交互提示上：stdin 没有输入的裸 `bash`/`zsh`/`sh`/`fish`/`python`/`python3`/`node`/`irb`/`ghci`；没有查询、文件或 stdin 的 `psql`/`mysql`/`mariadb`/`redis-cli`/`sqlite3`/`mongosh`；`vim`/`vi`/`nvim`/`nano`/`emacs`（`--batch`/`--headless` 除外）、`htop`、`btop`、`top`（`-b`/`-l` 除外）、`lazygit`、`lazydocker`、`tig`、`k9s`；`git rebase -i`、`git add -p`/`-i`、不带 `-m`/`-F`/`-C`/`--no-edit` 的 `git commit`；`expect`、`script`、`unbuffer`；可能要密码的 `sudo`/`doas`/`run0`（`sudo -n`/`-S`、`doas -n` 只判定它们后面的命令）；`passwd`；不带 `--with-token` 的 `gh auth login`；Python cell 里的 `pexpect`、`pty.spawn`/`pty.fork`；
  - **open-ended**：不会自己结束或在等外部条件：`tail -f`/`-F`、`journalctl -f`、`docker`/`podman logs -f`、`docker compose logs -f`、`kubectl logs -f`、`kubectl get -w`、`watch`、`gh run watch`、不带 `-c` 的 `ping`、不带 `-d`/`--wait` 的 `docker compose up`、`nohup`、`setsid`、以单个 `&` 结尾的管道、`while`/`until`/`for` 循环体里的 `sleep`。

  一行里任一简单命令命中即拒绝——管道每段、`$(…)`、`;`/`&&`/`||` 链与 shell 包装器后面的命令——类别取首个命中。eval 只检查自身名字与字面参数的启动：Python `subprocess.run`/`call`/`check_call`/`check_output`/`Popen`、`os.system`、`os.popen`、`!cmd`、`%%bash`；JS 不含 `${}` 的 `Bun.$`、`Bun.spawn`/`spawnSync`、child_process `exec`/`execSync`/`spawn`/`spawnSync`/`execFile`/`execFileSync`。读不出、非字面或改名的启动放行；本通道不检查 `xargs`、`find -exec`、`parallel` 与 shell `eval`。拒绝信息仅含简短原因（程序、类别、规则）与一行 `xd://exec_command` 指针，不含插件用法。被拒调用不进入其他通道，不计数、提醒、判定或记标记；所有通道都不解析或判定插件调用。闭合规则表是 `pty.ts` 的 `RULES`，命中与不命中样例见 `ci/tool-policy-nag-pty.test.ts`。轻量模式停用整个扩展。
- **`detector: heuristic`**：要求配置 `form`，忽略 `intent`（不发 JUDGE 请求，不读 `INTENT-policy.md`）。每次检查前在主会话运行时设置层写入 `bashInterceptor.enabled = false`（子代理透读主会话设置，同样关闭拦截器），切换 detector 或 `session_shutdown` 时清除该覆盖。
- **`detector: jev`**：要求 `intent`，保持 `config.yml` 的 `bashInterceptor.enabled`（拦截器开启时，`form`、`intent`、`risk` 跳过 `bash`，仍检查 `bash_bg` 与 `eval`；`pty` 先于该跳过运行）。可选 `form` 同步计数，仅在 `intent` 无法运行时提醒（spec 缺失、无效、停用或没有判定模型）；判定失败或 90 秒超时只按原因警告一次，不触发 `form`。
- **`form` 通道（命令语法解析与计数）**：
  - 解析管道、`;`/`&&`/`||`、引号、heredoc、`$(…)`/反引号与重定向（含 `>|`、`&>`），剥离 `NAME=value` 前缀、保留字（`if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`）及包装命令（`timeout`、`env`、`nice`、`stdbuf`、`time`、`nohup`、`command`、`exec`、`builtin`、`xargs`）；跳过 `sudo`/`doas`/`su`/`ssh`，对字面量 `bash|sh|zsh|dash -c '…'`、`eval '…'` 与 `find -exec … ;` 的内部命令直接分析。
  - 统计以下 shell 调用类别：列目录（`ls`、`tree`、`fd`、无动作 `find`、`rg --files`、`ag -g`）、读文件（`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`、`sed -n`、awk 行号与 `/start/,/end/` 区间、单文件 `jq`、单条只读 `sqlite3` 查询与 `.tables`/`.schema`、`tar -t`/`-xO`、`unzip -l`/`-p`）、搜索（带文件或 `-r` 的 `grep`、非管道输入的 `rg`/`ag`/`ack`、awk `/re/`、工作区 `git grep`）、编辑（`sed -i`、`perl -i`、`awk -i inplace`、`mv`）、写入字面内容（`echo`/`printf`/heredoc `cat` 重定向到文件或管道给 `tee`）、内联脚本（`node`/`bun`/`deno`/`python`/`ruby` 带 `-e`/`-c`/`-p`/`--eval` 或 `-` 读 stdin）；另计 `eval` 中的本地文件调用（`Path.read_text`、`open`、`glob`、`os.listdir`、`readFileSync`、`Bun.file`、`readdir`、`Bun.Glob`）。
  - 豁免项：结果用于 `$(…)` 捕获、仅经 stdin 过滤器传给 `wc`/`uniq -c`/`grep -c`、传给 `xargs`、作为 `if`/`while` 条件的 `grep -q`；目标是 `/dev/*`；以及 `tail -f`、`locate`、带 `-delete`/`-exec rm` 的 `find`、`git ls-files`、读管道 stdin 的无路径 `grep`。
  - 前 `form.afterHits`（`3`）次只计数；超出后每次以 steer 发送 `form.prompt` 并弹 UI 警告，每个上下文最多发 `form.maxNags`（`3`）次，直到下次 compaction、`/clear` 或 `branch_summary`（调高 `maxNags` 立即恢复）。计数保存在会话自定义条目 `mouriya.omp.tool-policy-nag.state` 中。
- **`intent` 通道（`INTENT-policy.md`）**：每次调用并发发起一次不阻塞命令的 JUDGE `choice` 请求（选项：`list`、`read`、`search`、`edit`、`write`、`move`、`eval`、`ast`、`shell`、`mixed`、`none`）。当 shell 调用选中非 `none`（或 `eval` 选中非 `eval`/`none`）且概率 $\ge$ `threshold`（`0.5`）时，在下一个 step 边界插入 `aside` 提醒，标出意图名称、应改用的内置工具与原调用。命令该走哪个 shell 入口由 `pty` 通道判定，不是这里的选项。
- **`risk` 通道（仅检查 shell，不调模型）**：配置了 `risk` 时在 `tool_call` 内同步执行。同时满足以下条件时触发：简单命令段数 $\ge$ `minCommands`（`4`）或总字符数 $\ge$ `minChars`（`600`）；排除 shell 内置命令（`cd`、`echo`、`printf`、`export`、`source`、`test`、`mkdir` 等）后调用的不同外部程序数 $\ge$ `minPrograms`（`3`）；且包含写入动作（重定向/`tee`/就地编辑，`rm`/`cp`/`mv`/`chmod`/`dd`/`tar -c|-x`/`rsync`/`scp`/`make`/`install`/`patch`，或 `git`、`gh`、`docker`、`kubectl`、`orb`、`npm`/`pnpm`/`yarn`/`bun`、`tofu`/`terraform`、`curl`、`wget` 的写子命令）。命中时发一条提醒列出段数、字符数、外部程序和写步骤。

### watchdog-agent

源码：`agent/extensions/watchdog-agent/`。

按 `WATCHDOG-<label>.md` 文件定期审阅目标会话（扫描 `~/.omp/agent/extensions/watchdog-agent/` 及会话当前 `cwd` 至 git 根各层的 `<dir>/WATCHDOG-*.md` 与 `<dir>/.omp/WATCHDOG-*.md`；归本机，不同步）。链接工作树使用自己的根目录；`/move` 后，下一条 prompt 或 `/watchdog` 命令从目标目录重新发现并匹配文件。发现文件不等于运行：会话必须同时匹配 `target` 和可选 `cwd`；之后由 `watchModel` / `watchProvider` 决定哪些助手消息计入 `every`。

`target`、`cwd` 与消息来源正则 `watchModel`、`watchProvider` 使用 `agent/extensions/_shared/session-filter.ts` 中与 `turn-judge` 共用的会话筛选：同一个键内的多个值任一匹配即可，不同键之间取 AND。

| Frontmatter 字段 | 取值与默认值 | 说明 |
|---|---|---|
| `target`（必填） | `main`、子代理名（如 `task:low`）或注册 id、`*`、`subagents` 或逗号列表 | 决定哪些会话运行该 watchdog |
| `cwd` | 可选的 Bun glob 逗号列表，每项为绝对路径或以 `~/` 开头；省略表示不限目录 | 与经 `node:path.resolve` 规范化的会话实时 cwd 匹配：`/a/repo` 只匹配该目录，`/a/repo/**` 只匹配其子目录，`/a/repo{,/**}` 两者都匹配，`/**/worktrees/*` 匹配任一 `worktrees` 目录的直接子目录。与 `target` 取 AND，`target: *` 也不例外。空列表或相对路径模式使整个文件无效 |
| `watchModel`、`watchProvider` | 可选；各一个 JavaScript 正则（多选用 `\|`），不锚定 | 匹配被监督会话每条助手消息的 `model` 与 `provider`；只有匹配消息的动作计数，实时计数和重载后恢复计数都按此筛选。空值或无效正则使文件无效。`model` 仍是聊天 reviewer 自己的模型 |
| `inject` | `system`（默认）或 `user` | `system`：带 `<watchdog name=… severity=…>` 标签的提醒作为 `watchdog` 自定义消息（`details.filePaths`）发送，即 OMP 自身的 harness 通知通道。模型实际收到的角色取决于 provider：OpenAI Responses（如 `openai-codex`）为 `developer`；支持对话中途 system 的 Anthropic 模型为 `system`；其余情况为带标签的 `user` 消息（实测 `anthropic/claude-haiku-5-5` 与 `opencode-go` 均如此，后者的 `openai-completions` 端点没有 developer 角色）。`user`：提醒作为 `attribution: "agent"` 的 user 消息发送，不带标签；聊天 reviewer 在同一次调用里直接以用户口吻对代理说话（第一人称、口语化、按严重程度带情绪），JUDGE 则原样发送所选选项的 `.prompt`。user 形式的 `steer` 会被 OMP 套上 “User interjection” 提示 |
| `name`、`enabled` | `name` 默认取文件名标签；`enabled` 默认 `true` | `/watchdog` 按 `name` 操作；多个文件重名时报错并列出路径 |
| `delivery` | `aside`（默认）、`steer`、`nextTurn`、`followUp` | 提醒发送方式；system 形式的 `aside`/`steer`/`followUp` 在会话空闲时开启新回合。`nextTurn` 等待下次用户输入或子代理 `before_agent_start`，并进入该回合的第一次模型调用：system 提醒作为钩子返回的自定义消息，user 提醒作为 prompt 准备期间排队的 steer |
| `every`、`scope` | `every` 默认 `30`；`scope` 为 `full`（默认）或 `window` | 计数助手消息中的每次工具调用和每条非空文字回复各计 1 步；满 `every` 步后台审阅，回合结束（非 `willContinue`）对剩余步数补跑一次。`window` 只读上次游标之后的新消息 |
| `maxPerContext` | 正整数，默认不限 | 两次 compaction 之间最多注入几条提醒（compaction 重置封顶计数，不重置步数与 `window` 游标） |
| `model`、`tools` | 聊天 reviewer 模式（默认） | 在禁加载扩展、`taskDepth: 1` 的内存会话中运行；`model` 未填时依次尝试 `@advisor`、`advisor`、`@slow`、当前会话模型；`tools` 默认 `[read, grep, glob]`（可加 `ast_grep, web_search, edit, write, bash, eval`）。首行以 `PASS`/`OK`/`LGTM`/`NONE` 开头视为通过，否则按 `inject` 形式注入 |
| `instructions`、`option.<标签>[.prompt\|.delivery]` | JUDGE 模式（声明 $\ge 2$ 个 `option.*` 时启用） | 不能与 `model`/`tools`/`note` 同用；调 `openJudge` 从声明的小写标签选项中选一个，若带 `.prompt` 则注入该文本（无 `.prompt` 视为通过）。报错或 90 秒超时不回退聊天模式 |

只监督领导 checkout 时，可使用如下 `WATCHDOG-LeaderScope.md`：

```markdown
---
target: main
cwd: /absolute/path/to/leader-checkout
---
按领导所承担的协调职责审阅最新工作。
```

同一规则复制到链接工作树后仍可被发现，但列表显示 `不适用于本会话`，不会监督该工作树的主会话；会话 cwd 位于所配置目录的子目录时同样不匹配。需要覆盖子目录时加上 `/absolute/path/to/leader-checkout/**`，需要覆盖工作树时加上 `/**/worktrees/*` 这类模式。

- **游标保存**：每次完成审阅后将游标写入会话条目 `mouriya.omp.watchdog-agent.cursor`，恢复会话或切换分支时从分支重建。
- **自身提醒**：发送 user 形式的提醒前，先写一条 `mouriya.omp.watchdog-agent.user-note` 条目记录文本与来源文件。该记录只是索引，不代表已送达：重载或切换分支后恢复的封顶计数只统计上次 compaction 之后该文件的 `watchdog` 自定义消息，以及文本与某条记录相同的 `attribution: "agent"` user 消息。审阅时两者都跳过，watchdog 不会审阅自己的提醒。
- **管理命令**：`/watchdog [list]`、`/watchdog on|off <name> [session|global]`、`/watchdog rm <name>`。`/watchdog add <需求>` 与 `/watchdog edit <name> [改动]` 不直接写文件，而是向当前模型发送一条 `attribution: "agent"` 消息，按 **1. 起草（给出预期行为、设置表、完整文件内容与绝对路径，不写盘）→ 2. 按反馈修改 → 3. 用户确认后写盘** 执行。任何修改 `WATCHDOG-*.md` 的文件系统 `write`/`edit` 工具结果末尾都会附带该文件的识别状态；`out://` 等资源 URI 写入不附带此状态。
- **范围展示**：`/watchdog list` 和 watchdog 文件写入/编辑的工具结果会展示 target、cwd 模式（省略时界面显示 `不限`、工具结果显示 `any`）、模型正则与注入形式，以及文件是否适用于本会话。`/watchdog add` 和 `/watchdog edit` 的设置参考包含全部筛选键与 `inject`；文件状态说明会指出由 target 或 cwd 限制排除，不再把所有排除都归因于 `target`。

### turn-judge

源码：`agent/extensions/turn-judge/`。

扫描扩展目录及 `cwd` 至 git 根各层的 `TURN-JUDGE-<label>.md`。在目标会话每次由模型自己结束回合（`stopReason: "stop"` 且有非空文字；`task.structured` 关闭时含子代理最终报告与 IRC 回复）后，对每个匹配文件发起一次 JUDGE 请求。仓库自带 `TURN-JUDGE-gpt-talk-only.md`，本机自建文件归本机。

- **匹配条件**：`target`（默认 `main`）、`cwd`（逗号分隔、绝对路径或以 `~/` 开头的 glob，匹配会话 cwd），以及匹配当前回复自身 `model`/`provider` 的不锚定 JavaScript 正则，使用与 `watchdog-agent` 共用的会话筛选：同一键内多个值任一匹配即可，不同键取 AND。另有逗号分隔的 `skipTools`：上一轮 `stop` 之后若调用过其中任一工具，本轮跳过。
- **配置与输入**：frontmatter 含 `name`、`enabled`（默认 `true`）、`target`、`cwd`、`model`、`provider`、`skipTools`、`inject`（默认 `system`，或 `user`）、`maxChars`（默认 `30000`）、至少一个 Noul 问题 `question.<id>`（可选 `question.<id>.true` / `.false` 说明是与否的含义）、至少一条规则 `when.<名称>`（合取式，如 `a >= 0.6 & b < 0.5`，每个值在 $(0, 1]$ 内）以及必填的 `prompt`；id 与规则名为 `[a-z0-9_]+`，每个问题都必须出现在某条规则中，正文保持为空。一个文件的全部问题在同一次请求里交给 `openJudge`，state 为 `{ 时间线: [{ 类型, 内容 }], 本轮回复 }`：`时间线` 从分支上最后一条人类输入开始，依次列出 `用户说`、`用户在ask中回答`（用户在 `ask` 里选的或自己写的答案，每个已作答的问题一行 `问题 → 答案`，由 `_shared/ask-answers.ts` 从工具结果读出；取消、被拒或未作答的 ask 不加条目）、`提醒`（`attribution: "agent"` 的 user 消息，以及 `watchdog` / `turn-judge` 自定义消息，每条前 400 字）、`模型想`（不含 redacted 块）、`模型说` 和 `模型调用工具`（`工具名：intent`，不含参数与结果），总长超过 `maxChars` 时从 `用户说` 之后最早的条目整条丢弃。
- **`TURN-JUDGE-gpt-talk-only.md`**：`target: main`、`model: (^|/)[Gg][Pp][Tt]`、`skipTools: wt, harness_restart`、`inject: user`。它的 Noul 问题分别问：`本轮回复` 是否说有工作仍未做完、未运行、未提交、未推送或未验证（`says_remaining`），是否宣布自己接下来要做什么（`announces_future`），是否承认自己犯错（`admits_mistake`），是否向用户提问或请用户决定（`asks_user`），是否指出自身无法控制的阻碍（`external_blocker`）；以及 `时间线` 里用户是否要求不要编辑、不要运行、停下或只回答（`user_forbids_work`）。当 `says_remaining >= 0.6` 且 `admits_mistake >= 0.5` 或 `announces_future >= 0.3`，同时 `asks_user`、`user_forbids_work`、`external_blocker` 都低于 `0.5` 时，发一条 user 消息要求继续用工具做到有可验证的结果。在 `futureppo-jev/decision-model-preview` 下用 2026-10-10 至 2026-10-25 的人工标注 GPT 主会话回合评测：19 个提前收工命中 11 个，23 个标注反例 0 误报，283 个未标注回合触发 22 次；同一批 state 上旧的单 Choice 文件只命中 3 个。
- **主会话与子代理投递差异**：触发的 `prompt` 按文件的 `inject` 形式原样发送：`system` 为 `turn-judge` 自定义消息（harness 通知通道，实际角色随 provider 而定，见 `watchdog-agent` 的 `inject`），`user` 为 `attribution: "agent"` 的 user 消息。按文件顺序找到第一条成立的规则即触发。主会话在后台判定，触发的文件发送其 `prompt`（空闲时开启新回合，忙碌时排为 follow-up；返回前若用户已输入或切换了分支则不发送），未触发文件合并弹一条 `turn-judge <name>：未命中规则（<id> <概率> · …）` 通知。子代理在 `message_end` 内等待最多 20 秒，空闲后按注入形式合并发送触发的 prompt：有 user 形式时合为一条 user 消息开启新回合，system 形式的合为一条自定义消息随之进入；只有 system 形式时合为一条自定义消息开启新回合，并用其 `details.deliveryId` 确认。新回合的回复替换交回父代理的报告（子代理无 UI，结果写 OMP 日志）。

### lang-nag

源码：`agent/extensions/lang-nag/`。仅在主会话运行。

在 `agent_end` 取最后一条非空回复最后一段的前 200 个字符，通过 `openJudge` 判断是否主要使用 `omomp.yml#lang-nag.language`（仓库配置 `language: 中文`、`instruction: 说中文`，会话开始或切换时读取）。若不符，在用户下一条输入前加上 `"说中文\n\n"`（斜杠命令会清除待发标记；用户发送时若判定仍未返回则直接中止判定并原样发出）。

---

## 删除

### delete-guard

源码：`agent/extensions/delete-guard/`。主会话与子会话、完整模式与轻量模式均启用；无配置、无开关，与 `tools.approvalMode`、`bashInterceptor` 无关。

**拦截。** `tool_call` 钩子判定每次 `bash` 调用：主循环发出的调用、对 `xd://bash` 的写入，以及 omp 为这类写入补发的嵌套 `bash` 事件（每次事件都判定，任一拦截即不执行）。bash 工具在所有平台都运行于内置 brush shell，因此按 posix 方言分类。被拦的调用不执行，返回 `delete-guard: …`，写明规则类别（删除命令或非字面命令）与命令原文；当前会话的活动工具含 `delete` 时指向它，否则写明本会话不能删除。钩子自身出错时记一条 warning 并拦截该调用。

- **分类范围**：文本中所有将被执行的命令，包括 `$(…)`、反引号、`<(…)`/`>(…)`、未加引号 here-document 正文里的替换、字面的 `sh|bash|zsh|dash|ksh -c '…'` 脚本、shell 读取的带引号 here-document，以及字面的 `eval`、`trap`、`alias` 正文，最多嵌套 8 层。无法解析的文本（引号、替换或分组未闭合）直接拦截。
- **删除命令**，与参数无关：`rm`、`unlink`、`rmdir`、`shred`（转小写、取路径的 basename、去掉引号与反斜杠：`RM`、`/bin/rm`、`\rm`），以及经 `sudo`、`doas`、`command`、`builtin`、`exec`、`env`、`nice`、`nohup`、`time`、`timeout`、`stdbuf`、`busybox`、`xargs` 调用的形式（它们的选项按表跳过；不认识的选项按"带值"与"不带值"两种读法都判定，任一读法落到删除命令即拦截），`find -delete` 与 `find -exec|-execdir|-ok|-okdir`。
- **非字面命令**：命令名来自展开、替换、glob 或花括号模式（`$CMD x`、`$(printf rm) x`）；嵌套 shell、`eval`、`trap`、`alias` 的脚本不是字面量（`sh -c "$s"`）；shell 的参数来自展开（`bash "$FLAGS"`，它可能是 `-c` 或 `-s`）；`env -S`；shell 从 stdin 读脚本而来源不是带引号的 here-document（`… | sh`、here-string、未加引号的 here-document、没有脚本）。不认识的 shell 长选项按"带值"与"不带值"两种读法都判定。任何描述符上的 here-document 正文都会检查替换；双引号内的 `'` 不起引号作用（`"${x:-'$(…)'}"` 会执行其中的替换）。
- **嵌套的 Windows shell**（所有平台都判定；在 Windows 上，brush 只能经它们到达 cmd 与 PowerShell）：带 `-Command`/`-c` 或位置脚本参数的 `powershell|pwsh`（含 `.exe`、任意路径）按 PowerShell 分类——`Remove-Item` 及其别名 `rm`、`ri`、`del`、`erase`、`rd`、`rmdir`，`[System.IO.File]::Delete`、`[IO.Directory]::Delete` 与任何 `.Delete(` 调用都是删除；`& $cmd`、`Invoke-Expression`/`iex`、`-EncodedCommand` 以及从 stdin 读脚本都是非字面；`-File` 执行脚本文件，放行。`=` 之后（`$x=Remove-Item x`）、`return`/`throw`/`exit`、`&` 或 `.` 之后的命令同样分类；控制结构块的 `}` 结束该语句。带 `/c` 或 `/k` 的 `cmd`（含 `.exe`）按 cmd 分类——`del`、`erase`、`rd`、`rmdir`（含 `for … do`、`if …`、`(…)` 块内以及 `start` 之后，`start` 的 `/d`、`/node`、`/affinity`、`/machine` 取值会跳过）都是删除；命令名含 `%VAR%`/`!VAR!` 即非字面；不带 `/c`/`/k` 的 `cmd` 从 stdin 读命令，按非字面拦截。均不区分大小写，脚本可跨方言嵌套。
- **放行**：只作参数出现的词（`echo rm -rf /`、`git rm`、`npm rm`）、参数中的展开（`ls $HOME`）、不含删除的字面嵌套脚本、字面的脚本文件（`bash x.sh`、`sh < x.sh`、`source`）、`-n` 语法检查（`+n` 会撤销它）以及 `--version`/`--help`。
- **不覆盖**：`exec_command`、自带删除语义的程序（`git clean`、`rsync --delete`）、脚本文件的内容，以及 bash 工具从用户 shell rc 引入的 alias 与函数。

**Eval。** 同一钩子在 `eval` 单元格执行前按文本判定，规则与 reason 同上。交给 shell 的命令不是字面字符串时（带占位符的 f-string 或模板字面量、变量、拼接）按非字面拦截。

- **Python**（自写分词器；无法分词的单元格直接拦截）：删除 API——`rmtree`、`removedirs`、`unlink`、`rmdir` 这几个名字在代码中出现即拦截（调用、`map(os.unlink, …)` 这类引用、import；字符串与注释不算），以及 `os` 或其别名上的 `remove`，和以任何名字从 `os` 导入的 `remove`（`from os import remove as erase`）。交给 shell 的调用——`os.system`、`os.popen`、`subprocess.getoutput|getstatusoutput`、`asyncio.create_subprocess_shell`、`shell=` 不是字面 `False` 或 `None` 的任何调用（`shell=flag` 可能启动 shell），以及 kernel 的 `!cmd`、`x = !cmd` 与 `%%bash` 正文——把字面命令按系统 shell 的脚本分类：macOS 与 Linux 为 posix，Windows 为 cmd（`ComSpec`）；`%%bash` 恒为 posix。不经 shell 的启动——`subprocess.run|call|check_call|check_output|Popen` 与 `asyncio.create_subprocess_exec`——按字面 argv 分类（argv[0] 非字面即拦截）。桥接调用 `tool.bash({"command": …})` 同样分类。`%time`/`%timeit` 的参数、`%%capture`/`%%timeit` 的正文、f-string 占位符及其格式说明中嵌套的表达式（`f"{x:{w}}"`）按 Python 判定。
- **JavaScript**（使用 omp 自带的 Babel 解析器与 kernel 相同的选项）：删除 API——`rmSync`、`unlinkSync`、`rmdirSync`、`unlink`、`rmdir` 在代码中出现即拦截，fs 或 fs.promises 绑定或 `require` 上的 `rm`（含经已绑定的 `fs` 取得的 `fs.promises`、`import {promises}` 与 `const {promises} = require("fs")`），以及 `Bun.file(…)` 或绑定到它的名字上的 `.delete()`。`child_process` 的 `exec`/`execSync` 字符串按系统 shell 脚本分类（Windows 上为 cmd）；`spawn`/`spawnSync`/`execFile`/`execFileSync` 按 argv 分类，选项可能启动 shell 时按脚本（`shell` 不是字面 `false`、`null` 或 `undefined`，或选项不是代码里写明的对象）；`Bun.spawn`/`Bun.spawnSync` 的 argv、`Bun.$` 模板（各平台均为 posix；含任何 `${}` 即非字面）、`tool.bash({command})` 与写入 `xd://bash` 的 `tool.write` 都会分类。名字表没有原型，`toString`、`hasOwnProperty` 只是普通名字。
- **放行**：其他程序的 argv 启动（`subprocess.run(["ls"])`）、`!ls`、`%run`、只在字符串或注释里提到 API 名的代码、`list.remove`、`Map.delete`，以及不含上述调用的单元格。
- **不覆盖**：在之前单元格里起别名的通用名（`remove`、`run`、`exec`、`spawn`、`rm`；独有名不论在哪个单元格都会拦截）、`getattr` 式的动态访问、`os.exec*`/`os.spawn*`/`pty.spawn`，以及脚本文件（`%run`、`%load`）。函数定义体内出现删除 API 名时，即使本单元格没有调用它也会拦截。

**`delete` 工具。** 在 macOS、Linux 与 Windows 上注册（审批级别 `write`，顶层工具）；其他平台不注册，拦截的 reason 写明本会话不能删除。参数：`paths`（非空字符串数组）与 `mode`（`"trash"`，默认；或 `"permanent"`）。工具说明、`mode` 参数说明与拦截的 reason 都要求 agent 省略 `mode`，只有用户明确要求不可恢复的删除时才设 `"permanent"`；「删除」「移除」「清理」或以 `rm -rf` 表述的请求都不算这种要求。

- **字面路径**：不展开 `~`、环境变量与 glob；相对路径相对会话 cwd。`"$HOME"`、`"*.log"` 都是文件名。
- **先校验、后改动**：所有路径先逐个校验，任一被拒则整次拒绝、不动任何文件。拒绝：空串或纯空白、以 `~` 开头、不存在、文件系统根、家目录及其祖先目录、会话 cwd 本身及其祖先目录。受保护目录按文件身份（`dev:ino`）比较，因此大小写变体、firmlink、bind mount 以及指向它们的符号链接都会被拒；检查覆盖路径本身、按原文经链接实际到达的文件，以及符号链接的目标。已不存在的受保护目录（如已删除的 cwd）按拼写比较。`..`、`.` 或末尾 `/` 穿过符号链接的路径（`link/../x`、`link/`）实际到达的文件与规范化后的路径不同，予以拒绝。通过校验的符号链接（含悬空链接）只删除链接本身。Windows 上拒绝裸盘符（`C:`）；根包括盘符根（`C:\`、`C:/`，以及解析到它的 `\` 或 `/`）、UNC 共享根（`\\server\share`）与 `\\?\C:\`；拼写统一转小写、分隔符统一为 `\` 后比较；家目录取 `USERPROFILE`。
- **`trash`**：把每个路径移入平台回收站，可从文件管理器还原。macOS 以 argv 传路径调用 `/usr/bin/trash -v <path>`（不经 shell）；该程序缺失时，整次调用在动任何文件之前失败，并说明 `permanent` 只用于用户明确要求的不可恢复删除。Linux 不依赖 `gio`、`trash-cli`，自行实现 [freedesktop.org Trash 规范](https://specifications.freedesktop.org/trash-spec/latest/)：与家目录回收站（`$XDG_DATA_HOME/Trash`，默认 `~/.local/share/Trash`）同设备的路径进家目录回收站，否则在实际容纳该路径的挂载点（解析其父目录的链接后）上进 `$topdir/.Trash/$uid`（带粘滞位的共享目录），其中任一步失败（建目录、写 info 文件或移动条目）时改进 `$topdir/.Trash-$uid`；写入 `files/<name>` 与 `info/<name>.trashinfo`（`Path=` 为 URI 转义后的原路径，家目录回收站写绝对路径，挂载点回收站写相对挂载点的路径）。`files/` 或 `info/` 中已有同名条目时依次改为 `<name>.2`、`<name>.3`……，不会覆盖回收站里已有的条目。Windows 以绝对路径调用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，运行固定脚本，经 `Microsoft.VisualBasic.FileIO.FileSystem` 的 `DeleteFile`/`DeleteDirectory` 与 `SendToRecycleBin` 删除；路径经环境变量传入，从不拼进脚本文本。UNC 路径、非固定盘（没有回收站）以及符号链接或 junction 会失败，并附同样的 `permanent` 说明；`powershell.exe` 缺失时整次调用在动任何文件之前失败。移动失败照实报告，不改为永久删除。
- **`permanent`**：递归删除，不可恢复，且必须先经用户确认。所有路径通过校验之后、动任何文件之前，工具弹出列出这些路径的确认框，每次调用都确认（不做会话级授权）。用户拒绝、取消或调用被中止，以及没有界面的会话（subagent、`--no-ui` 的 RPC、print 模式），都不删任何文件，返回错误并提示 agent 省略 `mode`；这类会话只能移入回收站。
- **结果**：按顺序处理，每个路径一行 `ok` 或 `failed`；任一失败则整次调用标为错误，摘要写明 `ok` 行已生效，已处理的路径保持处理结果。

---

## 宿主、TUI 与兼容扩展

### child-memory-warning

源码：`agent/extensions/child-memory-warning/`。仅 macOS（Darwin），完整模式与轻量模式均启用。

首个主会话在 `session_start` 通过 Bun FFI 打开系统 `libproc`/`sysctl`，启动每 2 秒一次的采样定时器（非 Darwin 平台记一条 `未启用` info 日志；主会话关闭时先清定时器再关闭句柄）：

- 读取 `proc_pid_rusage` 的 `ri_phys_footprint`（含压缩与换出内存），用 `PID + 内核启动时间` 标识进程。追踪当前 OMP 进程的全部后代及由后代组长创建的进程组；父进程退出后变成孤儿（`PPID === 1`）的已观测后代继续追踪至退出。
- 每次采样重读 `omomp.yml#child-memory-warning.thresholdGiB`（仓库配置 `4`；主会话 cwd 下 `.omp/omomp.*` 优先于 agent 目录 `omomp.*`）。配置缺失或无效时继续追踪进程但暂停告警，每种新配置问题记一次 warning。
- 任一归属进程的 `phys_footprint` 超过阈值时，按进程身份告警一次（弹主 UI warning，并向主会话发一条含 PID、PPID、是否孤儿、GiB/bytes、阈值与 240 字命令行的 `attribution: "agent"` 消息），不发信号杀进程。

### input-polish

源码：`agent/extensions/input-polish/`。仅在主会话交互式 TUI 运行。

在输入框按下 `omomp.yml#input-polish.key`（默认 `ctrl+enter`；不支持 Kitty 键盘协议或 `modifyOtherKeys` 的终端可改配 `alt+enter`）时，用 `@input-polish` 及回退角色 `fallbackRole`（仓库配置 `smol`，`instruction: 在不改变原意的前提下，改写到听起来会让人更加想努力、能激动人心，但不要太夸张。`）在 `taskDepth: 1` 无工具内存会话中改写草稿，流式显示在输入框上方的只读浮层中（输入框内原草稿不变）：

- 生成完成后按 `Enter` 用改写稿替换输入框内容并提交；按 `Esc` 或 `Ctrl+C` 取消并关闭浮层。
- 空白草稿及以 `/`、`!`、`$` 开头的草稿不处理。若改写结果改变了 `[Paste #N …]` 或 `[Image #N …]` 占位符的数量或内容，直接报错并显示在浮层中。

### doc-polish

源码：`agent/extensions/doc-polish/`。注册 `polish_doc` 工具与 `/polish-doc <path…>` 命令。

在不改变原意的前提下重排、润色 `.md` 与 `.txt` 文档。不修改源文件，输出写在 `/tmp/doc-polish/<时间戳>-<文件名>/` 下（源文件副本、`split.json` 和对照报告 `review.md`）：

- 各阶段运行 `taskDepth: 1`、禁加载扩展的内存子代理：**拆分（Split）**（仅持 `[read, write]`，读取原文并写出起止行号与术语表 `split.json`）→ **润色（Polish）**（无工具，并发改写各批次，通常每批不超过 5,000 码点；超长段落单独成批，不截断；再用并查集按 `sourceIndices` 归并跨段合并块）→ **校验（Check）**（无工具，逐组检查是否保持原意）。
- 模型分别取自 `@doc-polish.split`、`@doc-polish.polish`、`@doc-polish.check`（在 `/model` 中配置；`check` 未配模型时复用 `split` 链），各自后接本机 `omomp.*` 中 `doc-polish` 段的 `fallbackRole`（默认并发 `6`）：

```yaml
doc-polish:
  fallbackRole: default
  concurrency: 8
```

- 拆分或润色角色解析不出模型时直接报错退出，不创建 `/tmp/doc-polish/` 目录；无法解析的批次保留原文。工具在 execute 边界捕获失败、记 warning 并返回错误结果，不向 OMP 抛出异常。返回结果要求主代理亲自完整阅读每份 `review.md`，不得转交子代理或截断。

### wt-tool

源码：`agent/extensions/wt-tool/`。仅在主会话交互式 TUI 启用（默认 `defaultInactive`，主会话 `session_start`/`session_switch` 时开启）。

OMP 的 `/wt` 与 `/move` 在回合流式输出期间拒绝执行，且 `ExtensionAPI` 不暴露 `InteractiveMode` 实例。扩展在一次同步 `ctx.ui.setEditorComponent(undefined)` 调用中捕获当前 `InteractiveMode` 实例，把工具请求排入单槽队列并提示模型立即结束本轮；等回合交还控制权（非 `willContinue` 的 `agent_end`，或只剩后台任务能唤醒会话时带 `awaitingAsyncWork` 的 `agent_end`）且会话空闲后，调用 TUI 的 `executeBuiltinSlashCommand` 执行命令，并把结果作为 `attribution: "agent"` 消息发回（按 `Esc` 中断回合会取消排队请求）。会话自行安排的续跑（stop 提醒、重试、compaction）不会触发执行，请求保持排队直到之后的回合结束：

- **`wt`**：执行 `/wt [<branch>]`。若当前会话已在 linked worktree 中，首次调用不创建目录，只返回当前 worktree 路径、分支、HEAD、未提交项数、主 checkout 路径与 `confirm` 哈希；需要再次新建时传入该 `confirm` 二次调用。工具描述要求模型在工作区出现自己没做的改动时提出切到 worktree，分不清是否属于干扰时先问用户。
- **`wt_remove`**：分两步调用。不传 `confirm` 时做只读检查，返回 worktree 与主 checkout 路径、`SAFE`/`UNSAFE`/`BLOCKED` 结论、删除会丢失的文件（staged、unstaged、untracked、ignored，每类最多列 50 项及总数）、主 checkout HEAD 未合并的分支提交（保留在分支上）、运行中任务/子代理阻塞项，以及绑定当前状态指纹的 `confirm` 哈希。传入 `confirm` 二次调用时，在空闲后按 **重检指纹 → `/move <主 checkout>` → 确认新 `cwd` → 再检指纹 → `worktreeRemove(path, true)`** 顺序执行，任一步状态变化即停止并报告停在哪一步。

### harness-restart

源码：`agent/extensions/harness-restart/`。仅在主会话交互式 TUI 启用（轻量模式同样启用）。

使用与 `wt-tool` 相同的空闲队列机制与武装条件触发 `InteractiveMode.restart()`。在调用 `restart()` 前向当前分支写入自定义条目 `mouriya.omp.harness-restart.request`（记录 `reason` 与时间戳）；新进程恢复会话时，在 `session_start` 读到该条目并发送 `"Harness restart completed（<时间>）。Reason was: <原因>。Continue what you were doing."`（`attribution: "agent"`）。

### antigravity-wire-profiles

源码：`agent/extensions/antigravity-wire-profiles/`。

OMP 的 `google-antigravity` provider 只对静态表 `ANTIGRAVITY_MODEL_WIRE_PROFILES`（`@oh-my-pi/pi-catalog/wire/gemini-headers`）中已有的 wire id 替换调用方的 `maxTokens`；表抓包之后新增的 id（如 `gemini-4-argon-*`）不在其中，导致 compaction 的 512 token 摘要请求原样发出，额度被 thinking 耗尽并报错 `thought-only response without final output`。

在根会话 `session_start`（最多等待 20 秒，`before_agent_start` 等待同一次加载）时，扩展用当前会话凭据和本机已存的全部 Antigravity 账号调用 `POST <baseUrl>/v1internal:fetchAvailableModels`，合并非 internal、非 disabled 且 `maxOutputTokens` 为正整数的条目，原地更新 `ANTIGRAVITY_MODEL_WIRE_PROFILES`（只新增或覆盖，不删除条目）。这张表按线程存在：子代理 worker 线程（`task.workerThreads`）加载自己的一份 provider 模块，所以 OMP 放进每个 worker 的第一个会话会为该线程执行同样的加载。若所有账号均获取失败，则保留原表内容，记日志并弹一次主 UI 警告，下次根会话（或 worker 中的会话）启动时重试。

### argon-long-output

源码：`agent/extensions/argon-long-output/`。主会话与子代理、完整与轻量模式都加载；无配置。

Cloud Code Assist 把 `functionCall` 作为一个完整 part 下发，`gemini-4-argon` 生成长 `write` 时，流在 thinking 摘要之后一直静默。OMP 的看门狗把这段静默判为卡死：300 s 后包装层报 `Provider stream stalled while waiting for the next event` 中止（首事件之前则报 `Cloud Code Assist stream timed out while waiting for the first event`），每次重试都重新生成同一调用，又撞上同一上限。本扩展只作用于 `api` 为 `google-gemini-cli`、id 匹配 `^gemini-4-argon` 的模型，与 provider 无关：

- **超时**：看门狗（包装层 idle、provider 首事件、provider pre-response）的预算按 调用方 option > settings `providers.streamIdleTimeoutSeconds` / `providers.streamFirstEventTimeoutSeconds` > 环境变量 `PI_STREAM_IDLE_TIMEOUT_MS` / `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` > `model.compat.stream{Idle,FirstEvent}TimeoutMs` > 300000 取值，0 表示关闭该看门狗。扩展只填匹配模型行的 compat 层：宿主已解析出的值保留；否则取 `models.yml` 的 `compat` 值（OMP 的 Google compat 解析只把它留在 `compatConfig`，由扩展搬过去）；都没有时取 `0`。因此显式 option、settings 与环境变量仍优先，其他模型保持 300 s 默认值。静默中的请求仍可用 Esc 或 session dispose 立即终止。
- **生效位置**：每次扫描修补会话模型和注册表中所有可用模型行（模型行在进程内共享，子代理与 compaction 候选也随之生效）。扫描在 `session_start`、`before_agent_start`、`context`（每次模型调用前）和 `session.compacting` 运行。OMP 在每条 LLM compaction 路径（手动 `/compact`、自动、预取）发出摘要请求之前都会发出 `session.compacting`。compaction 从会话模型和注册表行中选模型，所以上一回合之后因 `models.yml` 重载而重建的模型行，会在发出请求之前被修补。处理函数不返回任何内容，不改变 compaction 本身。上下文窗口重拟合会构建扫描看不到的新行，但 OMP 没有给 argon 模型行设窗口档位，不会对它们重拟合。
- **提示词**：argon 会话（主会话与每个子代理，各按自己的模型匹配）在 `before_agent_start` 时追加 `ARGON_PROMPT.md`（扩展同目录，仓库下发，每条 prompt 重读）：单次 `write` 内容、单次 `edit` 正文、单条最终回复都不超过 8,000 字符；更长的交付物先 `write` 只含标题的骨架，再逐节 `edit` 填充；修改已有大文件时只 `edit` 改动的节。文件缺失或不可读时按原因只警告一次，不追加。
- **超大单次调用**：仍一次生成超过后端输出上限的调用时，沿用 OMP 现有处理（`MAX_TOKENS` → `length`；截断的函数调用 → `MALFORMED_FUNCTION_CALL` → `error`，不执行）。

### ast-top-level

源码：`agent/extensions/ast-top-level/`。主会话与子代理、完整与轻量模式都加载；无配置。

`tools.xdev` 开启时，OMP 把 `loadMode` 为 `discoverable` 的已启用工具都挂到 `xd://` 下：它的 schema 不进请求的工具列表，模型要向 `xd://<tool>` 写 JSON 才能调用。内置 `ast_grep` 与 `ast_edit` 都是 discoverable，OMP 也没有让单个工具留在顶层的设置；唯一的豁免是 OMP 进程全局的 `XDEV_KEEP_TOP_LEVEL` 表（`todo`、`yield`、`ask`、`grep`、`web_search`），每次分区都经 `isMountableUnderXdev` 查询它：

- **加载**：把 `ast_grep` 与 `ast_edit` 加进该表（`@oh-my-pi/pi-coding-agent/tools/xdev`），并检查 OMP 已把它们留在顶层。此后每次分区（构建会话、`setActiveTools`、设置重载、MCP 刷新、plan 模式、晚注册的工具、子代理会话）都把两者作为函数工具发送。工具实例与设置开关（`astGrep.enabled`、`astEdit.enabled`）仍归 OMP；`ast_edit` 仍只生成预览，预览经 `xd://resolve` 应用、经 `xd://reject` 放弃。
- **晚绑定**：OMP 可能在会话已完成工具分区后才绑定本扩展（首帧前无需注册任何东西的扩展会被延后加载）。OMP 会把 `session_start` 补发给晚绑定的扩展；此时含这两个工具之一的会话按自身当前工具集重新应用一次，依据该表重新分区。
- **生命周期**：该表进程全局且不会还原；停用扩展后重启才生效。
- **失败处理**：导出被改名时扩展加载失败。表拒绝写入或 OMP 不再查询该表时，加载时记 warning，每次主会话启动弹一次警告；两个工具保持为设备。

### tool-topics

源码：`agent/extensions/tool-topics/`（`tool://` handler 在其 `registry.ts`；哪些专题由谁提供见[工具专题](operations.zh-CN.md#工具专题)）。

渐进式工具说明。被覆盖的工具在 system prompt 里的说明只保留常用调用说明，末尾附 `Topics` 索引；详细调用说明是按需读取的专题 `tool://<tool>/<topic>`（支持行选择器；`read tool://<tool>` 列出该工具的专题及读取条件；对 `tool://` 执行 `grep`/`find` 可检索全部专题）。`SYSTEM_TEMPLATE.md` 要求调用前先读条件命中的专题；[tool-topic-injection](#tool-topic-injection) 另在只读工具调用后补送专题。

- **文件**：`TOPIC-<tool>-<name>.md` 带严格 YAML 头（`tool`、`name`、`title`、`when`、`upstream`）和 Markdown 正文；`SURFACE-<tool>.md`（头为 `tool`、`upstream`）整段替换该工具的说明。专题写调用说明——参数、语法、取值、前置条件、结果、出错后的改法——不写实现细节。`when` 是索引显示的一行（“before …”“when …”）。`upstream` 记录核对时依据的 OMP 版本与来源。
- **覆盖范围**：`read`、`bash`、`task` 有表层文件（task 用 `{{native:Available Agents}}` 嵌入原生的 `# Available Agents` 段）；`ast_grep`、`ast_edit`（经 [ast-top-level](#ast-top-level) 留在顶层）也有表层文件，只写哪类代码工作该交给它们而不是 `grep` 或 `edit`，以及路径要写成代码 glob（裸目录会把 Markdown 文件也带进来，其段落会匹配代码 pattern 并被改写）；pattern 语法在各自的 `patterns` 专题。有专题的工具：read、bash（含等待外部条件）、edit（hashline 模式）、eval、grep、find、task、write、OMP 内置 ask、ast_grep、ast_edit，设备 debug、github、checkpoint。简单工具 `wait`、`glob`、`web_search`、`wt`、`wt_remove`、`harness_restart` 不拆专题：原生说明已写全调用契约。从扩展或插件文件注册的工具保留自己的说明与专题索引，即使它以同名替换了内置工具（如 `omp-ask-more` 的 `ask`），本扩展也不向它添加表层说明或索引。插件工具说明：`xd://<tool>`。
- **生命周期**：扩展加载时读取一次文件，把专题以 `tool://` 挂到 router 上，并替换之前加载（子代理、隔离子代理）留下的 handler；改文件需重启。每次 `before_agent_start`（主会话与子代理、完整与轻量模式）按工具名在 OMP 渲染格式中定位所覆盖的 OMP 自有工具——inline 工具是 `type <tool> =` 上方的 `//` 注释行，设备是 `### Schema` 之前的 `## <tool>` 段——把说明换成表层文本（或保留原生文本）再加索引，每行一个专题及其完整 `tool://` URL。没有 `read` 的会话保留原生说明。
- **失败处理**：逐个跳过格式错误或不可读的文件并记 warning，其他文件仍继续加载。找不到工具格式或 `{{native:…}}` 段时，该工具保留原生说明，记 warning，主会话按工具与原因各提示一次。OMP 或其他 handler 已占用 `tool://` 时，所有工具都不显示索引。

### tool-topic-injection

源码：`agent/extensions/tool-topic-injection/`；可复用规则引擎位于 `_shared/tool-topic-injection.ts`。主会话、子代理及完整/轻量模式均加载。扩展监听 `tool_result`，不阻塞或修改工具执行；在工具批次结束后、下一次模型调用前，将命中的专题作为可信 developer 上下文注入。工具报错时也会提供说明。

仓库规则存于 `omomp.yml`，每次工具结果到达时重读（项目 `.omp/omomp.*` 优先于 agent 目录的 `omomp.*`）。没有有效配置段时不运行；无效副本记 warning 并跳过。设置空 `rules` 数组可关闭注入：

```yaml
tool-topic-injection:
  rules:
    - id: read-ssh
      tool: read
      parameter: path
      pattern: '^ssh://'
      topic: tool://read/ssh
    - id: read-sqlite
      tool: read
      parameter: path
      pattern: '\.(sqlite3?|db3?)(:|\?|$)'
      topic: tool://read/sqlite
    # … read-archives、read-json、read-documents、read-forge、read-runtime、read-web、
    #   grep-regex、grep-scopes、eval-ssh-cat、bash-ssh-cat
```

仓库规则只覆盖不改动任何东西、重来没有代价的调用（read、grep），外加 eval/bash 里 `ssh … cat` 的误用提醒：调用后送达的专题用于改进下一次调用。`task`、`fork_task`、`edit`、`write` 和会改动状态的设备没有规则：调用之后再送专题已经晚了，它们的专题要在调用前读。

`tool` 精确匹配工具名；`parameter` 指定字符串参数名，也支持点分属性路径。`pattern` 是不带斜杠定界符和 flags 的 JavaScript 正则源码，只匹配文本，不解释 shell 语义。参数缺失或不是字符串时不匹配。`topic` 指向 [tool-topics](#tool-topics) 提供的 `tool://<tool>/<topic>` 正文。规则 id 在同一 owner 内须唯一且稳定。

每条规则在活动叶节点重建的真实模型上下文中保有自身标记时只注入一次。共享 `_shared/context-delivery.ts` 也服务 `repo-rules`；临时集合只覆盖当前 turn 中宿主尚未持久化 developer 消息的窗口。compact 移除标记后，该规则可再次注入；若标记仍在保留尾部，则不重复注入。resume 和树导航按当前分支判断，不扫描整份历史。指向同一专题的多条规则各自保有注入资格。专题缺失、为空或加载失败时记 warning，不消耗资格，也不妨碍其他规则执行。

### omomp-lang

源码：`agent/extensions/omomp-lang/`。

设置本地扩展与 OMP 插件所有面向人的界面文字语言（`en` 或 `zh`）：通知、widget、状态栏、对话框、浮层、命令与快捷键说明、工具标签和渲染器。发给模型的文本（prompt、steer、工具说明、工具结果）与日志保持原文。

- 从 agent 目录的 `omomp.*` 读取 `omomp.yml#omomp-lang.language`（仓库配置 `zh`；不读项目 `.omp/` 副本，修改后下次启动生效）。
- 模块加载时将 `process.env.OMOMP_LANG` 设为该值，但若启动环境已设置（如 `OMOMP_LANG=en omp`）则保留环境值。
- `_shared/i18n.ts` 的 `tr(en, zh)` 在每次生成文字时按 `OMOMP_LANG` → `omomp-lang` 配置段 → `LC_ALL` / `LC_MESSAGES` / `LANG`（`zh*` 为中文）→ 英文 的顺序解析，并直接读取配置段，使早于 `omomp-lang` 加载的扩展也能拿到配置语言。
- `omomp-lang` 段归 omp-config 所有，OMP 插件在共享的语言发现顺序中读取该段。将它导出为 `OMOMP_LANG` 也为仅读环境变量的使用方与子进程提供语言。插件自有行为见[插件参考](plugins-and-modes.zh-CN.md)。
