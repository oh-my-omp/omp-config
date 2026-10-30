# 本地扩展

[返回首页](../README.zh-CN.md) · [English](extensions.md) | 简体中文

## 本地扩展总览表

| 序号 | 扩展目录 | 所在章节 | 作用域 | 轻量模式 | 配置来源（`omomp.yml` 段或同目录文件） |
|---|---|---|---|---|---|
| 1 | `system-prompt-replace` | [提示词与上下文](prompts-and-context.zh-CN.md#system-prompt-replace) | 主 + 子 | 否 | `omomp.yml#system-prompt-replace`（仓库） |
| 2 | `append-system-model` | [提示词与上下文](prompts-and-context.zh-CN.md#append-system-model) | 主 + 子 | 是 | `APPEND_SYSTEM_MODEL.md`（本机） |
| 3 | `repo-rules` | [提示词与上下文](prompts-and-context.zh-CN.md#repo-rules) | 主 + 子 | 是 | 扫描 `.claude/rules`、`.agents/rules`、`.pi/rules`、`~/.claude/rules` 及原生规则的 `paths` |
| 4 | `fork-task` | [提示词与上下文](prompts-and-context.zh-CN.md#fork-task) | 主 + 子 | 否 | 无配置文件 |
| 5 | `model-compaction` | [提示词与上下文](prompts-and-context.zh-CN.md#model-compaction) | 主写 / 子读 | 是 | `omomp.yml#model-compaction`（本机） |
| 6 | `user-prompt-inject` | [子代理](agents.zh-CN.md#user-prompt-inject) | 子代理 | 否 | `PROMPT-INJECT-*.md`（仓库带 `user-goal.md`） |
| 7 | `isolation-nudge` | [isolation-nudge](#isolation-nudge) | 主 + 子 | 否 | 无配置文件 |
| 8 | `task-split-check` | [task-split-check](#task-split-check) | 主 (`split`) / 主+子 (`report-limit`) | 否 | `omomp.yml#task-split-check`（仓库） |
| 9 | `task-completion-judge` | [task-completion-judge](#task-completion-judge) | `task:low/mid/free` | 否 | `omomp.yml#task-completion-judge`（仓库） |
| 10 | `tool-policy-nag` | [tool-policy-nag](#tool-policy-nag) | 主会话 | 否 | `omomp.yml#tool-policy-nag` + `INTENT-policy.md`（仓库） |
| 11 | `watchdog-agent` | [watchdog-agent](#watchdog-agent) | 主 + 子 | 否 | `WATCHDOG-*.md`（本机） |
| 12 | `turn-judge` | [turn-judge](#turn-judge) | 主 + 子（按文件 `target`） | 否 | `TURN-JUDGE-*.md`（仓库带 `gpt-talk-only`，其余归本机） |
| 13 | `lang-nag` | [lang-nag](#lang-nag) | 主会话 | 否 | `omomp.yml#lang-nag`（仓库） |
| 14 | `child-memory-warning` | [child-memory-warning](#child-memory-warning) | 进程全局（由主会话启动） | 是 | `omomp.yml#child-memory-warning`（仓库） |
| 15 | `input-polish` | [input-polish](#input-polish) | 主 TUI | 是 | `omomp.yml#input-polish`（仓库） |
| 16 | `doc-polish` | [doc-polish](#doc-polish) | 主 + 子 | 否 | `omomp.yml#doc-polish`（本机） |
| 17 | `wt-tool` | [wt-tool](#wt-tool) | 主 TUI | 是 | 无配置文件 |
| 18 | `harness-restart` | [harness-restart](#harness-restart) | 主 TUI | 是 | 无配置文件 |
| 19 | `commandcode-model-spec` | [commandcode-model-spec](#commandcode-model-spec) | 主 + 子 | 是 | 读取本机 `commandcode-models.json` |
| 20 | `antigravity-wire-profiles` | [antigravity-wire-profiles](#antigravity-wire-profiles) | 根主会话（表为进程全局） | 是 | 后端 `fetchAvailableModels`；无文件 |
| 21 | `omp-config-autoupdate` | [安装、同步与维护](operations.zh-CN.md#omp-config-autoupdate) | 根主会话 | 是 | `omomp.yml#omp-config-autoupdate`（本机） |
| 22 | `omomp-lang` | [omomp-lang](#omomp-lang) | 进程全局（模块加载） | 是 | `omomp.yml#omomp-lang`（仓库） |
| 23 | `tool-topics` | [tool-topics](#tool-topics) | 主 + 子（提示词）；进程全局（`tool://` scheme） | 是 | 同目录的 `TOPIC-*.md` / `SURFACE-*.md`（仓库） |
| 24 | `tool-topic-injection` | [tool-topic-injection](#tool-topic-injection) | 主 + 子 | 是 | `omomp.yml#tool-topic-injection`（仓库） |
| 25 | `session-urls` | [session-urls](#session-urls) | 进程全局（`session://` scheme） | 是 | 读取会话文件、recap 记录与 prompt 历史；无配置 |
| 26 | `delete-guard` | [delete-guard](#delete-guard) | 主 + 子 | 是 | 无 |

---

## 任务派发与交付检查

### isolation-nudge

源码：`agent/extensions/isolation-nudge/`。

在主会话与子代理的 `tool_call` 阶段检查 `task` 调用；本扩展不检查 `fork_task`。填写 `agent` 的分叉默认隔离，省略 `agent` 的分叉默认共享 cwd，因此并发写入的 fork 必须显式设 `isolated: true`。当一次 `task` 调用会让 $\ge 2$ 个可写代理（`task:*`、内置 `task`、未填 `agent` 的项、`m1` 等，合并计算本次批次与当前会话仍在运行的共享写入任务）在未设 `isolated: true` 的情况下共用同一工作目录，且其中有未显式填写 `isolated` 的项时，按该项 `task` 文本的 SHA-256 拦截一次，提示写入任务设 `isolated: true`、只读任务设 `isolated: false`；相同 `task` 文本再次调用时放行。

### task-split-check

源码：`agent/extensions/task-split-check/`。

在 `tool_call` 阶段检查 `task` 与 `fork_task`。整批共用 25 秒超时，对每个任务项并发执行两项是非检查，任一项不通过即拦截整次调用：

- **判定模型**：先取 OMP 模型角色 `@task-split-check`（在 `/model` 中配置，保存在本机 `modelRoles`），再取 `omomp.yml#task-split-check.fallbackRole`（仓库配置 `smol`），每次调用实时解析。角色条目未带 `:level` 后缀时使用 `medium` 推理强度；遇到 provider 错误时换链中的下一个模型。
- **失败处理**：配置缺失或无效、解析不出模型、请求报错或超时均直接放行；每次完成判定记一条 `task-split-check verdicts` 日志。

| 检查项 | 适用范围 | 判定问题 | 缓存与重试行为 |
|---|---|---|---|
| `split` | 主会话 `task` 调用中派给 `task:low`、`task:mid`、`task:free` 的项 | 只看该项的 `task` 文本（共享 `context` 仅作背景）：是否把多个互不相关的主题塞进了同一个子代理（按主题而非文件数判断）？ | 缓存所有结论（`pass-repeats`）：单主题边界可能存在判断分歧，被拦后若主会话确认属于同一主题并原样重发，第二次调用放行。 |
| `report-limit` | 任意会话 `task` 与 `fork_task` 中派给 `task:*` 或未填 `agent` 的项 | 同时看共享 `context` 与该项 `task`：是否限制了子代理返回报告的长度（字数、行数、段落数、token 数或“简短汇报”；对写入仓库文件的交付物限制长度不算）？ | 只缓存通过结论（`skip-clear`）：限制报告长度会截断父会话验收所需的证据，必须删掉字数限制（长报告可写到 `local://<name>.md`），原样重发继续拦截。 |

### task-completion-judge

源码：`agent/extensions/task-completion-judge/`。

在 `task:low`、`task:mid`、`task:free` 子代理调用终止性结构化 `yield` 时运行（`task:high`、主会话、报错 `yield` 与增量提交不拦截）：

- **输入内容（60k token 预算）**：读取当前分支最后一条 `session_init` 中的任务说明（忽略 `fork_task` 继承的前置历史）、system prompt 中的共享背景、子代理 Todo 的 `goal`、本次 `yield` 提交内容（最多 6,000 字符），以及 `session_init` 之后从最新一条往前能装入剩余预算的连续工具调用与结果（单条参数和结果各最多 800 字符，超长保留前 60% + 后 40%；按 ASCII 字符 1 token、非 ASCII 字符 2 token 估算）。
- **判定模型与标准**：先取 `@task-completion-judge`，再取 `omomp.yml#task-completion-judge.fallbackRole`（仓库配置 `smol`），每次判定实时解析，未带 `:level` 时使用 `low` 推理强度，超时 25 秒，provider 报错时换链中下一个模型，返回 `DONE` 或 `NOT_DONE`。若子代理的 Todo `goal` 缩小了派工范围、`goal` 中声明的验证方式未在工具调用中出现，或未达到 `doneWhen`（包括报告 blocker），均判为 `NOT_DONE`。
- **退回规则**：
  1. 首次判为 `NOT_DONE` 时拦截 `yield` 并返回原因，要求子代理继续完成并验证。
  2. 判为 `DONE` 后，同步触发 `omp-todo-more:read` 读取最新 Todo 列表；若仍有 `pending` 或 `in_progress` 项（`blocked` 项不计），再拦截一次并列出这些项的说明，要求先更新 Todo 状态。
  3. 两种退回在每个子代理会话中各最多发生一次，避免真实受阻的子代理陷入死循环；通过后，该会话后续 `yield` 不再拦截。若 `yield` 数据是无自定义 `outputSchema` 的开放对象，放行时写入 `data.completion_judge = { verdict, reason, bounced }`（`bounced` 仅记录是否发生过 `NOT_DONE` 退回）。配置、模型或插件读取失败时记 warning 并放行。

---

## 基于 `JUDGE` 角色的扩展

`turn-judge`、`tool-policy-nag` 的 `intent` 通道（`detector: jev` 时）、`watchdog-agent` 的选项模式与 `lang-nag` 通过 `agent/extensions/_shared/judge.ts` 中的 `openJudge` 调用模型：

1. 先走 OMP 的 judge 角色链（`resolveJudge`：`modelRoles.judge` → `retry.fallbackChains.judge` → OMP 内置默认链）。跳过无凭据候选，遇到 provider 错误换下一个（401/402/403 使该候选冷却 5 分钟），遇到中止或超时立即停止。从链中第一个原生判定 API 模型起只保留原生候选，`openJudge` 不把当前会话模型加入链中。
2. 当上述链因中止、超时以外的原因失败，或未解析出任何模型时，改用 `omomp.yml#judge.fallbackRole`（仓库配置 `tiny`，即 `@tiny`：`modelRoles.tiny` → `retry.fallbackChains.tiny`，跳过本地 `local` 模型）中的聊天模型，以提示式判定（`TextJudge`）作答。提示式判定的概率为 one-hot（选中项为 1）。未配置 `judge` 段则不回退。
3. 两个阶段的请求均记入会话用量账本，相同的原生请求复用 OMP 判定缓存。角色设置与 `omomp.yml#judge` 在每次触发时重读。

### tool-policy-nag

源码：`agent/extensions/tool-policy-nag/`。仅在主会话运行。

在 `tool_call` 阶段检查 `bash`、`bash_bg`、`exec_command`（含写往 `xd://bash`、`xd://bash_bg`、`xd://exec_command` 的调用）和 `eval`。只发提醒，不拦截命令。设计上，它把工具调用不规范当作模型偏离静态 system prompt 的可观测信号（包括 Claude Opus 在内的模型在长会话中均会高频忽略静态 system prompt）：`form.prompt` 并非以系统提示注入，而是作为伪装成用户观察的 user 角色 steer 消息发送（在各模型厂商不透明的指令权重体系下，user 消息通常享有更高优先级），促使模型重新审视并遵守 system prompt。启发式检测刻意不压低误报率：对触发后的 thinking 记录逐条检查表明，误报仅增加少量自检思考 token，未观察到其他负面副作用。

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
```

- **`detector: heuristic`**：要求配置 `form`，忽略 `intent`（不发 JUDGE 请求，不读 `INTENT-policy.md`）。每次检查前在主会话运行时设置层写入 `bashInterceptor.enabled = false`（子代理透读主会话设置，同样关闭拦截器），切换 detector 或 `session_shutdown` 时清除该覆盖。
- **`detector: jev`**：要求配置 `intent`，`bashInterceptor.enabled` 保持 `config.yml` 的设置（拦截器开启时，三条通道均跳过已被拦截器处理的 `bash` 调用，只检查 `exec_command`、`bash_bg` 与 `eval`）。可选的 `form` 段在旁同步计数，仅在 `intent` 无法运行（`INTENT-policy.md` 缺失/无效/停用，或解析不出判定模型）时发送 `form.prompt`；判定请求失败或 90 秒超时只按原因记一次 warning，不触发 `form`。
- **`form` 通道（命令语法解析与计数）**：
  - 解析管道、`;`/`&&`/`||`、引号、heredoc、`$(…)`/反引号与重定向（含 `>|`、`&>`），剥离 `NAME=value` 前缀、保留字（`if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`）及包装命令（`timeout`、`env`、`nice`、`stdbuf`、`time`、`nohup`、`command`、`exec`、`builtin`、`xargs`）；跳过 `sudo`/`doas`/`su`/`ssh`，对字面量 `bash|sh|zsh|dash -c '…'`、`eval '…'` 与 `find -exec … ;` 的内部命令直接分析。
  - 统计六类 shell 调用：列目录（`ls`、`tree`、`fd`、无动作 `find`、`rg --files`、`ag -g`）、读文件（`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`、`sed -n`、awk 行号与 `/start/,/end/` 区间、单文件 `jq`、单条只读 `sqlite3` 查询与 `.tables`/`.schema`、`tar -t`/`-xO`、`unzip -l`/`-p`）、搜索（带文件或 `-r` 的 `grep`、非管道输入的 `rg`/`ag`/`ack`、awk `/re/`、工作区 `git grep`）、编辑（`sed -i`、`perl -i`、`awk -i inplace`、`mv`）、写入字面内容（`echo`/`printf`/heredoc `cat` 重定向到文件或管道给 `tee`）、内联脚本（`node`/`bun`/`deno`/`python`/`ruby` 带 `-e`/`-c`/`-p`/`--eval` 或 `-` 读 stdin）；另计 `eval` 中的本地文件调用（`Path.read_text`、`open`、`glob`、`os.listdir`、`readFileSync`、`Bun.file`、`readdir`、`Bun.Glob`）。
  - 豁免项：结果用于 `$(…)` 捕获、仅经 stdin 过滤器传给 `wc`/`uniq -c`/`grep -c`、传给 `xargs`、作为 `if`/`while` 条件的 `grep -q`；目标是 `/dev/*`；以及 `tail -f`、`locate`、带 `-delete`/`-exec rm` 的 `find`、`git ls-files`、读管道 stdin 的无路径 `grep`。
  - 前 `form.afterHits`（`3`）次只计数；超出后每次以 steer 发送 `form.prompt` 并弹 UI 警告，每个上下文最多发 `form.maxNags`（`3`）次，直到下次 compaction、`/clear` 或 `branch_summary`（调高 `maxNags` 立即恢复）。计数保存在会话自定义条目 `mouriya.omp.tool-policy-nag.state` 中。
- **`intent` 通道（`INTENT-policy.md`）**：每次调用并发发起一次不阻塞命令的 JUDGE `choice` 请求（12 个选项：`list`、`read`、`search`、`edit`、`write`、`move`、`eval`、`ast`、`pty`、`shell`、`mixed`、`none`）。当 shell 调用选中非 `none`（或 `eval` 选中非 `eval`/`none`）且概率 $\ge$ `threshold`（`0.5`）时，在下一个 step 边界插入 `aside` 提醒，标出意图名称、应改用的内置工具与原调用。
- **`risk` 通道（仅检查 shell，不调模型）**：配置了 `risk` 时在 `tool_call` 内同步执行。同时满足三项时触发：简单命令段数 $\ge$ `minCommands`（`4`）或总字符数 $\ge$ `minChars`（`600`）；排除 shell 内置命令（`cd`、`echo`、`printf`、`export`、`source`、`test`、`mkdir` 等）后调用的不同外部程序数 $\ge$ `minPrograms`（`3`）；且包含写入动作（重定向/`tee`/就地编辑，`rm`/`cp`/`mv`/`chmod`/`dd`/`tar -c|-x`/`rsync`/`scp`/`make`/`install`/`patch`，或 `git`、`gh`、`docker`、`kubectl`、`orb`、`npm`/`pnpm`/`yarn`/`bun`、`tofu`/`terraform`、`curl`、`wget` 的写子命令）。命中时发一条提醒列出段数、字符数、外部程序和写步骤。

### watchdog-agent

源码：`agent/extensions/watchdog-agent/`。

按 `WATCHDOG-<label>.md` 文件定期审阅目标会话（扫描 `~/.omp/agent/extensions/watchdog-agent/` 及 `cwd` 至 git 根各层的 `<dir>/WATCHDOG-*.md` 与 `<dir>/.omp/WATCHDOG-*.md`；归本机，不同步）：

| Frontmatter 字段 | 取值与默认值 | 说明 |
|---|---|---|
| `target`（必填） | `main`、子代理名（如 `task:low`）、`*`、`subagents` 或逗号列表 | 决定哪些会话运行该 watchdog |
| `name`、`enabled` | `name` 默认取文件名标签；`enabled` 默认 `true` | `/watchdog` 按 `name` 操作；多个文件重名时报错并列出路径 |
| `delivery` | `aside`（默认）、`steer`、`nextTurn`、`followUp` | 提醒发送方式（`nextTurn` 等待下次用户输入或子代理 `before_agent_start`） |
| `every`、`scope` | `every` 默认 `30`；`scope` 为 `full`（默认）或 `window` | 每次工具调用和每条非空文字回复各计 1 步；满 `every` 步后台审阅，回合结束（非 `willContinue`）对剩余步数补跑一次。`window` 只读上次游标之后的新消息 |
| `maxPerContext` | 正整数，默认不限 | 两次 compaction 之间最多注入几条提醒（compaction 重置封顶计数，不重置步数与 `window` 游标） |
| `model`、`tools` | 聊天 reviewer 模式（默认） | 在禁加载扩展、`taskDepth: 1` 的内存会话中运行；`model` 未填时依次尝试 `@advisor`、`advisor`、`@slow`、当前会话模型；`tools` 默认 `[read, grep, glob]`（可加 `ast_grep, web_search, edit, write, bash, eval`）。首行以 `PASS`/`OK`/`LGTM`/`NONE` 开头视为通过，否则注入 `<watchdog name=… severity=…>` |
| `instructions`、`option.<标签>[.prompt\|.delivery]` | JUDGE 模式（声明 $\ge 2$ 个 `option.*` 时启用） | 不能与 `model`/`tools`/`note` 同用；调 `openJudge` 从声明的小写标签选项中选一个，若带 `.prompt` 则注入该文本（无 `.prompt` 视为通过）。报错或 90 秒超时不回退聊天模式 |

- **游标保存**：每次完成审阅后将游标写入会话条目 `mouriya.omp.watchdog-agent.cursor`，恢复会话或切换分支时从分支重建。
- **管理命令**：`/watchdog [list]`、`/watchdog on|off <name> [session|global]`、`/watchdog rm <name>`。`/watchdog add <需求>` 与 `/watchdog edit <name> [改动]` 不直接写文件，而是向当前模型发送一条 `attribution: "agent"` 消息，按 **1. 起草（给出预期行为、设置表、完整文件内容与绝对路径，不写盘）→ 2. 按反馈修改 → 3. 用户确认后写盘** 三步执行。任何修改 `WATCHDOG-*.md` 的 `write`/`edit` 工具结果末尾都会附带该文件的当前识别状态。

### turn-judge

源码：`agent/extensions/turn-judge/`。

扫描扩展目录及 `cwd` 至 git 根各层的 `TURN-JUDGE-<label>.md`。在目标会话每次由模型自己结束回合（`stopReason: "stop"` 且有非空文字；`task.structured` 关闭时含子代理最终报告与 IRC 回复）后，对每个匹配文件发起一次 JUDGE 请求。仓库自带 `TURN-JUDGE-gpt-talk-only.md`，本机自建文件归本机。

- **匹配条件**：`target`（语法同 `watchdog-agent`，默认 `main`）、匹配当前回复自身 `model`/`provider` 的 JavaScript 正则，以及逗号分隔的 `skipTools`（上一轮 `stop` 之后若调用过其中任一工具，本轮跳过）。
- **配置与输入**：frontmatter 含 `name`、`enabled`（默认 `true`）、`target`、`model`、`provider`、`skipTools`、`maxChars`（默认 `30000`）、`option.<标签>`（至少 2 个，不含 `.` 或空白）、`option.<标签>.prompt` 及对应的必填 `option.<标签>.threshold` $\in (0, 1]$；正文为判定问题。传给 `openJudge` 的输入为 `{ 时间线: [{ 类型, 内容 }], 本轮回复 }`：`时间线` 从分支上最后一条人类输入开始，依次列出 `用户说`、`用户在ask中回答`（用户在 `ask` 里选的或自己写的答案，每个已作答的问题一行 `问题 → 答案`，由 `_shared/ask-answers.ts` 从工具结果读出；取消、被拒或未作答的 ask 不加条目）、`提醒`（每条前 400 字）、`模型想`（不含 redacted 块）、`模型说` 和 `模型调用工具`（`工具名：intent`，不含参数与结果），总长超过 `maxChars` 时从 `用户说` 之后最早的条目整条丢弃。
- **`TURN-JUDGE-gpt-talk-only.md`**：`target: main`、`model: (^|/)[Gg][Pp][Tt]`、`skipTools: wt, harness_restart`；选项为 `做完在汇报`、`只需文字`、`只说不做`（`threshold: 0.8`），当 GPT 主代理在任务未完成时只输出文字就停下（包括用户在 `ask` 里选定做法后只复述就停），自动发一条 prompt 要求继续用工具执行。用户在 `ask` 中的回答等同用户亲口说的话：用户只要求作出决定时，确认用户在 `ask` 中的决定后只用文字结束是正当的。阈值在 ask 回答进入时间线之前，于 `futureppo-jev/decision-model-preview` 下用 2026-10-10 至 2026-10-25 的 329 个 GPT 主会话回合校准：19 个标注正例命中 6 个，23 个标注反例和 287 个未标注回合 0 误报。
- **主会话与子代理投递差异**：主会话在后台判定，达到 `.threshold` 的最高概率选项以 `attribution: "agent"` 发送 `.prompt`（返回前若用户已输入或切换了分支则只弹通知），未触发文件合并弹一条 `turn-judge <name>：<标签>（<概率>）` 通知。子代理在 `message_end` 内等待最多 20 秒，空闲后把触发的 prompt 合为一条 `attribution: "agent"` 消息发出，由新回合的回复替换交回父代理的报告（子代理无 UI，结果写 OMP 日志）。

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
- **非字面命令**：命令名来自展开、替换、glob 或花括号模式（`$CMD x`、`$(printf rm) x`）；嵌套 shell、`eval`、`trap`、`alias` 的脚本不是字面量（`sh -c "$s"`）；`env -S`；shell 从 stdin 读脚本而来源不是带引号的 here-document（`… | sh`、here-string、未加引号的 here-document、没有脚本）。
- **放行**：只作参数出现的词（`echo rm -rf /`、`git rm`、`npm rm`）、参数中的展开（`ls $HOME`）、不含删除的字面嵌套脚本、脚本文件（`bash x.sh`、`sh < x.sh`、`source`）以及 `-n` 语法检查。
- **不覆盖**：`exec_command`、`eval` 工具、自带删除语义的程序（`git clean`、`rsync --delete`）、脚本文件的内容，以及 bash 工具从用户 shell rc 引入的 alias 与函数。

**`delete` 工具。** 在 macOS 与 Linux 上注册（审批级别 `write`，顶层工具）；其他平台（含 Windows）不注册，拦截的 reason 写明本会话不能删除。参数：`paths`（非空字符串数组）与 `mode`（`"trash"`，默认；或 `"permanent"`）。

- **字面路径**：不展开 `~`、环境变量与 glob；相对路径相对会话 cwd。`"$HOME"`、`"*.log"` 都是文件名。
- **先校验、后改动**：所有路径先逐个校验，任一被拒则整次拒绝、不动任何文件。拒绝：空串或纯空白、以 `~` 开头、不存在、文件系统根、家目录及其祖先目录、会话 cwd 本身及其祖先目录。受保护目录按文件身份（`dev:ino`）比较，因此大小写变体、firmlink、bind mount 以及指向它们的符号链接都会被拒；检查覆盖路径本身、按原文经链接实际到达的文件，以及符号链接的目标。已不存在的受保护目录（如已删除的 cwd）按拼写比较。`..`、`.` 或末尾 `/` 穿过符号链接的路径（`link/../x`、`link/`）实际到达的文件与规范化后的路径不同，予以拒绝。通过校验的符号链接（含悬空链接）只删除链接本身。
- **`trash`**：把每个路径移入平台回收站，可从文件管理器还原。macOS 以 argv 传路径调用 `/usr/bin/trash -v <path>`（不经 shell）；该程序缺失时，整次调用在动任何文件之前失败，并提示改用 `permanent`。Linux 不依赖 `gio`、`trash-cli`，自行实现 [freedesktop.org Trash 规范](https://specifications.freedesktop.org/trash-spec/latest/)：与家目录回收站（`$XDG_DATA_HOME/Trash`，默认 `~/.local/share/Trash`）同设备的路径进家目录回收站，否则在实际容纳该路径的挂载点（解析其父目录的链接后）上进 `$topdir/.Trash/$uid`（带粘滞位的共享目录），无法创建时改进 `$topdir/.Trash-$uid`；写入 `files/<name>` 与 `info/<name>.trashinfo`（`Path=` 为 URI 转义后的原路径，家目录回收站写绝对路径，挂载点回收站写相对挂载点的路径）。`files/` 或 `info/` 中已有同名条目时依次改为 `<name>.2`、`<name>.3`……，不会覆盖回收站里已有的条目。移动失败照实报告，不改为永久删除。
- **`permanent`**：递归删除。
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

- 分三阶段运行 `taskDepth: 1`、禁加载扩展的内存子代理：**拆分（Split）**（仅持 `[read, write]`，读取原文并写出起止行号与术语表 `split.json`）→ **润色（Polish）**（无工具，按每批 $\le 5000$ 码点并发改写，再用并查集按 `sourceIndices` 归并跨段合并块）→ **校验（Check）**（无工具，逐组检查是否保持原意）。
- 模型分别取自 `@doc-polish.split`、`@doc-polish.polish`、`@doc-polish.check`（在 `/model` 中配置；`check` 未配模型时复用 `split` 链），各自后接本机 `omomp.*` 中 `doc-polish` 段的 `fallbackRole`（默认并发 `6`）：

```yaml
doc-polish:
  fallbackRole: default
  concurrency: 8
```

- 拆分或润色角色解析不出模型时直接报错退出，不创建 `/tmp/doc-polish/` 目录；无法解析的批次保留原文。返回结果要求主代理亲自完整阅读每份 `review.md`，不得转交子代理或截断。

### wt-tool

源码：`agent/extensions/wt-tool/`。仅在主会话交互式 TUI 启用（默认 `defaultInactive`，主会话 `session_start`/`session_switch` 时开启）。

OMP 的 `/wt` 与 `/move` 在回合流式输出期间拒绝执行，且 `ExtensionAPI` 不暴露 `InteractiveMode` 实例。扩展在一次同步 `ctx.ui.setEditorComponent(undefined)` 调用中捕获当前 `InteractiveMode` 实例，把工具请求排入单槽队列并提示模型立即结束本轮；等回合交还控制权（非 `willContinue` 的 `agent_end`，或只剩后台任务能唤醒会话时带 `awaitingAsyncWork` 的 `agent_end`）且会话空闲后，调用 TUI 的 `executeBuiltinSlashCommand` 执行命令，并把结果作为 `attribution: "agent"` 消息发回（按 `Esc` 中断回合会取消排队请求）。会话自行安排的续跑（stop 提醒、重试、compaction）不会触发执行，请求保持排队直到之后的回合结束：

- **`wt`**：执行 `/wt [<branch>]`。若当前会话已在 linked worktree 中，首次调用不创建目录，只返回当前 worktree 路径、分支、HEAD、未提交项数、主 checkout 路径与 `confirm` 哈希；需要再次新建时传入该 `confirm` 二次调用。工具描述要求模型在工作区出现自己没做的改动时提出切到 worktree，分不清是否属于干扰时先问用户。
- **`wt_remove`**：分两步调用。不传 `confirm` 时做只读检查，返回 worktree 与主 checkout 路径、`SAFE`/`UNSAFE`/`BLOCKED` 结论、删除会丢失的文件（staged、unstaged、untracked、ignored，每类最多列 50 项及总数）、主 checkout HEAD 未合并的分支提交（保留在分支上）、运行中任务/子代理阻塞项，以及绑定当前状态指纹的 `confirm` 哈希。传入 `confirm` 二次调用时，在空闲后按 **重检指纹 → `/move <主 checkout>` → 确认新 `cwd` → 再检指纹 → `worktreeRemove(path, true)`** 顺序执行，任一步状态变化即停止并报告停在哪一步。

### harness-restart

源码：`agent/extensions/harness-restart/`。仅在主会话交互式 TUI 启用（轻量模式同样启用）。

使用与 `wt-tool` 相同的空闲队列机制与武装条件触发 `InteractiveMode.restart()`。在调用 `restart()` 前向当前分支写入自定义条目 `mouriya.omp.harness-restart.request`（记录 `reason` 与时间戳）；新进程恢复会话时，在 `session_start` 读到该条目并发送 `"Harness restart completed（<时间>）。Reason was: <原因>。Continue what you were doing."`（`attribution: "agent"`）。

### commandcode-model-spec

源码：`agent/extensions/commandcode-model-spec/`。

修复 `--model` 启动参数指定 `commandcode` 模型时的两类认证失败：`models.db` 将模型缓存为 `openai-completions`/`anthropic-messages` 导致请求未走插件的 `commandcode-custom` 而报 401，以及 `google/gemini-3.5-flash-lite` 等模型名被匹配到无凭据的内置 `google` provider。扩展在 `session_start` 读取 `<agentDir>/commandcode-models.json`（或 `COMMANDCODE_MODELS_CACHE`），若当前模型在该列表中、`api !== "commandcode-custom"` 且不是已配置凭据的内置模型，则调用 `setModel` 重新绑定到 `pi-commandcode-provider` 注册的实时模型。

### antigravity-wire-profiles

源码：`agent/extensions/antigravity-wire-profiles/`。

OMP 的 `google-antigravity` provider 只对静态表 `ANTIGRAVITY_MODEL_WIRE_PROFILES`（`@oh-my-pi/pi-catalog/wire/gemini-headers`）中已有的 wire id 替换调用方的 `maxTokens`；表抓包之后新增的 id（如 `gemini-4-argon-*`）不在其中，导致 compaction 的 512 token 摘要请求原样发出，额度被 thinking 耗尽并报错 `thought-only response without final output`。

在根会话 `session_start`（最多等待 20 秒，`before_agent_start` 等待同一次加载）时，扩展用当前会话凭据和本机已存的全部 Antigravity 账号调用 `POST <baseUrl>/v1internal:fetchAvailableModels`，合并非 internal、非 disabled 且 `maxOutputTokens` 为正整数的条目，原地更新 `ANTIGRAVITY_MODEL_WIRE_PROFILES`（只新增或覆盖，不删除条目）。若所有账号均获取失败，则保留原表内容，记日志并弹一次主 UI 警告，下次根会话启动时重试。

### tool-topics

源码：`agent/extensions/tool-topics/`；路由和注册由 [`_shared/tool-topics.ts`](operations.zh-CN.md#插件注册工具专题) 提供。

渐进式工具说明。被覆盖的工具在 system prompt 里的说明只保留常用调用说明，末尾附 `Topics` 索引；详细调用说明是按需读取的专题 `tool://<tool>/<topic>`（支持行选择器；`read tool://<tool>` 列出该工具的专题及读取条件；对 `tool://` 执行 `grep`/`find` 可检索全部专题）。`SYSTEM_TEMPLATE.md` 要求调用前先读条件命中的专题；[tool-topic-injection](#tool-topic-injection) 另在只读工具调用后补送专题。

- **文件**：`TOPIC-<tool>-<name>.md` 带严格 YAML 头（`tool`、`name`、`title`、`when`、`upstream`）和 Markdown 正文；`SURFACE-<tool>.md`（头为 `tool`、`upstream`）整段替换该工具的说明。专题写调用说明——参数、语法、取值、前置条件、结果、出错后的改法——不写实现细节。`when` 是索引显示的一行（“before …”“when …”）。`upstream` 记录核对时依据的 OMP 版本与来源。
- **覆盖范围**：`read`、`bash`、`task` 有表层文件（task 用 `{{native:Available Agents}}` 嵌入原生的 `# Available Agents` 段）；有专题的工具：read、bash、edit（hashline 模式）、eval、grep、find、task、write、ask、fork_task，设备 ast_edit、debug、github、checkpoint，以及 `exec_command` 插件设备（等待外部条件、终端生命周期与回收、交互输入与监视）。简单工具 `wait`、`glob`、`web_search`、`ast_grep`、`wt`、`wt_remove`、`harness_restart` 不拆专题：原生说明已写全调用契约。
- **生命周期**：扩展加载时读取一次文件，以 owner `omp-config/tool-topics` 注册各工具的专题；改文件需重启。每次 `before_agent_start`（主会话与子代理、完整与轻量模式）按工具名在 OMP 渲染格式中定位——inline 工具是 `type <tool> =` 上方的 `//` 注释行，设备是 `### Schema` 之前的 `## <tool>` 段——把说明换成表层文本（或保留原生文本）再加索引。其他 owner（插件）为自己的工具注册的专题，每次 `before_agent_start` 从注册表读取，保留该工具原生说明并在其后加索引，所以插件的专题由插件自己维护（见[插件注册工具专题](operations.zh-CN.md#插件注册工具专题)）。没有 `read` 的会话保留原生说明。
- **失败处理**：解析失败的文件跳过并记 warning。找不到工具格式或 `{{native:…}}` 段时，该工具保留原生说明，记 warning，主会话按工具与原因各提示一次。注册失败的工具不显示索引。

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

`tool` 精确匹配工具名；`parameter` 指定字符串参数名，也支持点分属性路径。`pattern` 是不带斜杠定界符和 flags 的 JavaScript 正则源码，只匹配文本，不解释 shell 语义。参数缺失或不是字符串时不匹配。`topic` 指向已注册的 `tool://<tool>/<topic>` 正文。规则 id 在同一 owner 内须唯一且稳定。

每条规则在活动叶节点重建的真实模型上下文中保有自身标记时只注入一次。共享 `_shared/context-delivery.ts` 也服务 `repo-rules`；临时集合只覆盖当前 turn 中宿主尚未持久化 developer 消息的窗口。compact 移除标记后，该规则可再次注入；若标记仍在保留尾部，则不重复注入。resume 和树导航按当前分支判断，不扫描整份历史。两条规则即使指向同一专题，也各有一次注入机会。专题缺失、为空或加载失败时记 warning，不消耗资格，也不妨碍其他规则执行。

外部插件可通过[导出的引擎和 schema](operations.zh-CN.md#渐进式专题注入-api)提供自己的 owner 和规则读取函数，无需导入本扩展。

### session-urls

源码：`agent/extensions/session-urls/`。在 OMP 进程全局的 URL 路由里注册只读的 `session://` scheme，主会话、子代理（`task`、`fork_task`、seance）和轻量模式都能直接用 `read` 与 `grep` 读本机的其他会话，不必手动定位 JSONL 文件。`read session://README` 返回完整语法。

- **查找**：`session://find?text=<词>[&project=.|<bucket>|<路径>][&max=N]` 匹配 prompt 历史（`history.db` 中 OMP 的 FTS 索引）、标题和 recap；`session://sessions.jsonl`、`session://here/sessions.jsonl`、`session://projects/<bucket>/sessions.jsonl` 以 JSONL 列出会话元数据（sid、cwd、title、created、modified、status、size、recap、parent）。
- **阅读**：`session://<id 前缀>/timeline` 把当前分支渲染成时间线：行头顶格写 `HH:MM:SS <类型> #<条目>[.<块>]`，正文每行缩进两格，每个用户回合一行 `── turn N`，间隔 5 分钟以上插一行 `── idle`。用户、developer、thinking、assistant 正文、收发的 IRC、task 派发和子代理结果（父会话实际收到的内容）全文显示；其余工具调用每个一行 `tool(参数) 状态 #<结果条目> // 意图`，不含输出。`…/entry/<id>`（或 `…/entry/@<原始行号>`）完整显示一个条目，工具结果连同其参数、意图和耗时。`…/events.jsonl` 是同一组事件的 JSONL；`…/raw.jsonl` 是会话文件本身；`…/agents/<AgentId>/…` 对子代理重复这套结构；`…/artifacts/<N>` 与 `…/local/<路径>` 是该会话的 `artifact://` 与 `local://`，时间线里对它们的引用已改写成这些 URL。
- **按类型过滤**：`timeline` 和 `events.jsonl`（根会话与子代理）接受 `?type=<filter>`，也可把同一过滤写成路径前缀 `session://type/<filter>/<路径>`；grep 带 glob 时只能用前缀形式（glob 段之后的 `?` 会被当成 glob 字符）。过滤是逗号列表，重复的 `type=` 以及前缀加查询会合并：事件类型（`user`、`developer`、`thinking`、`say`、`call`、`irc_out`、`irc_in`、`dispatch`、`subresult`、`exec`、`marker`，以及时间线行头里的 `calls`、`result`）、分组（`irc`、`subagent`、`tools`、`ai`、`speech`）、`call:<工具>`（带该工具调用的事件，故 `call:task` 即派发、`call:write` 即发出的 IRC）、`marker:<类型>`，以及排除写法 `-<x>` / `!<x>`（只有排除时保留其余全部）。不区分大小写；无法识别的写法报错并列出可用形式。过滤后的时间线头部多一行 `filter`，注明显示条数，每个 turn 行仍是整回合的统计；对过滤后的 `events.jsonl` 做 jq 时，续页提示保留 `type`。
- **jq**：`events.jsonl`、`sessions.jsonl` 与 `find` 接受 `?q=<filter>&raw=&compact=&offset=&limit=`，用 OMP 内置的 jaq（`executeJsonQuery`）对每次调用生成的临时 JSONL 执行。OMP 自带的 `read …?q=` 只对 `local://`/`artifact://` 文件生效，所以由本 scheme 自己执行；`raw.jsonl` 不接受查询。
- **grep**：只有一棵可遍历的树，`session://projects/<bucket>/<YYYY-MM-DD>/<完整 id>/timeline`（及 `…/agents/<AgentId>/timeline`），当前项目可写作别名 `session://here/…`，经路由的 `readDirectory` 列出；命中保留 `session://` 路径与行号，可直接读取。每个会话目录只列 `timeline` 和 `agents/`，因此一次 grep 不会把同一会话搜两遍，也不会扫工具输出；单次 grep 在 30 秒预算内约能覆盖 7 GB 会话文件，需按项目和日期限定范围。
- **读取方式**：不缓存，也不在会话旁写任何文件。每次读取用投影式 JSON tokenizer（`scanner.ts`）流式扫一遍文件，只构建视图需要的字段，跳过的字符串只计长度不落内存，再用 OMP 的 `resolveSessionLeafId` 选出当前分支。本机最大的会话（731 MB、3850 个条目）扫描约 6 秒，RSS 峰值增加 12 至 35 MB，而 OMP 自带加载器峰值增加 2.6 GB。无法解析的行和仍在写入的最后一行会在时间线头部注明，不会静默丢弃。`ci/session-urls-scanner.test.ts`（`bun run test`）在各种分块下把 tokenizer 与 `JSON.parse` 逐行对照。
- **宿主耦合**：所有 OMP 内部 import（路由、会话列表/索引/加载辅助函数、`tools/read-json`）集中在 `omp-adapter.ts`；宿主升级挪动其中任何一个时会在加载时报错。若 OMP 已自带 `session` scheme 或其他宿主已注册，则不覆盖。

### omomp-lang

源码：`agent/extensions/omomp-lang/`。

设置本地扩展与 OMP 插件所有面向人的界面文字语言（`en` 或 `zh`）：通知、widget、状态栏、对话框、浮层、命令与快捷键说明、工具标签和渲染器。发给模型的文本（prompt、steer、工具说明、工具结果）与日志保持原文。

- 从 agent 目录的 `omomp.*` 读取 `omomp.yml#omomp-lang.language`（仓库配置 `zh`；不读项目 `.omp/` 副本，修改后下次启动生效）。
- 模块加载时将 `process.env.OMOMP_LANG` 设为该值，但若启动环境已设置（如 `OMOMP_LANG=en omp`）则保留环境值。
- `_shared/i18n.ts` 的 `tr(en, zh)` 在每次生成文字时按 `OMOMP_LANG` → `omomp-lang` 配置段 → `LC_ALL` / `LC_MESSAGES` / `LANG`（`zh*` 为中文）→ 英文 的顺序解析，并直接读取配置段，使早于 `omomp-lang` 加载的扩展也能拿到配置语言。
- 仅运行在 OMP 的插件（`omp-todo-more`、`omp-playbooks`、`omp-thinking-translator`、`omp-codex-image-gen`、`omp-remote-build`）使用相同解析顺序；兼容 Pi 的插件（`omp-unified-exec`、`pi-bansos`）只读环境变量；第三方 npm 插件（`pi-commandcode-provider`、`pi-package-search`）仅英文。
