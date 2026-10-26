# 运行期门禁、旁路判定器与本地扩展

[返回首页](../README.zh-CN.md) · [English](extensions.md) | 简体中文

## 派发前与交付前硬门禁（Pre-Dispatch & Pre-Yield Gates）

### isolation-nudge

在主会话与子会话的 `tool_call` 阶段拦截 `task` 调用（不查默认隔离的 `fork_task`）：当调用会导致 $\ge 2$ 个可写代理（`task:*`、内置 `task`、省略 `agent` 的项、`m1` 等，计入本批及本会话仍在运行的共享写入异步 job）在未开启 `isolated: true` 的情况下共用当前目录，且存在未显式指定 `isolated` 的项时，按每项 `task` 文本的 SHA-256 首次拦截整次调用，提示为写入者加 `isolated: true`、只读调查显式写 `isolated: false`；同一 prompt 原样重派则直接放行。

### task-split-check

在 `tool_call` 阶段询问 OMP 模型角色 `@task-split-check`（在 `/model` 中指定；`modelRoles` 属于本机，仓库不为它附带模型），再询问 `omomp.yml#task-split-check.fallbackRole` 所指的角色（仓库配置 `smol`），每次请求实时解析，角色条目不带 `:level` 后缀时用 `medium` 推理，整批共用 25s 超时信号，某个模型报 provider 错误时换角色链中的下一个，对 `task` / `fork_task` 的每个派发项并发执行两项是非检查，任一项命中即拦截整次调用：

| 检查项 | 适用范围 | 判定准则 | 进程内缓存与重派策略 |
|---|---|---|---|
| `split` | 主会话 `task` 调用中派给 `task:low`、`task:mid`、`task:free` 的项 | 仅看该项 `task` 文本（共享 `context` 仅作背景）：是否塞入了多个互不依赖的主题（按主题而非涉及的文件数判断） | 缓存全部确定结论（`pass-repeats`）：被拦后若主代理确认是单一主题，原样重派第二次直接放行 |
| `report-limit` | 任何会话 `task` 与 `fork_task` 中派给 `task:*` 或省略 `agent` 的项 | 同时看共享 `context` 与该项 `task`：是否限制了 worker 汇报的长度（字数、行数、段落、token 或“简短汇报”；给写入仓库文件的交付物定长不算） | 仅缓存无限制结论（`skip-clear`）：**必须删掉长度限制**（长报告可让 worker 写 `local://<name>.md` 并汇报路径），原样重派继续拦截 |

模型不可用、配置缺失或无效、请求失败或超时均 Fail-open 放行，每次判定记录一条 `task-split-check verdicts` info 日志。

### task-completion-judge

在 `task:low`、`task:mid`、`task:free` 子代理会话内拦截结构化 `yield`（`task:high`、主会话、带错误的 `yield` 或增量提交不拦截）：

- **证据组装（60k token 窗口）**：提取当前分支最后一条 `session_init` 中的派工单（跳过 `fork_task` 开头继承的父会话历史），加上 system prompt 共享背景、worker 自身 Todo 的 `goal`、本次 `yield` 提交内容（最多保留 6,000 字符），以及从最新一条往前连续装入剩余预算的本轮工具调用与结果（单次调用参数与结果各最多保留 800 字符，超长按前 60% + 后 40% 加省略行截断；按 ASCII 字符 1 token、其他字符 2 token 估算）。
- **判定模型与标准**：询问 OMP 模型角色 `@task-completion-judge`，再询问 `omomp.yml#task-completion-judge.fallbackRole` 所指的角色（仓库配置 `smol`），每次判定实时解析，角色条目不带 `:level` 后缀时用 `low` 推理，25s 超时，某个模型报 provider 错误时换角色链中的下一个，回答 `DONE` 或 `NOT_DONE`。派工单定义任务范围：若 worker 的 Todo `goal` 窄化了派工单范围、`goal` 写的验证方式未在工具调用中出现、或未达 `doneWhen`（含如实报告 blocker），均判 `NOT_DONE`。
- **双重单次退回（Single-Bounce）与结果附注**：
  1. 首次判为 `NOT_DONE` 时拦截本次 `yield`，将原因退回给子代理要求继续做完并验证。
  2. 判为 `DONE` 后，立即通过同步事件 `omp-todo-more:read` 重新读取该子代理的最新 Todo 投影；若仍有 `pending` 或 `in_progress` 项（`blocked` 项不触发），再拦截一次并逐项列出解释，要求先把 Todo 更新到真实进度。
  3. 两类退回在每个子代理会话中各最多触发一次；一旦放行，同一会话后续 `yield` 不再拦截。当 `yield` 的数据结构为无自定义 `outputSchema` 的开放对象时，放行结果自动附上 `data.completion_judge = { verdict, reason, bounced }`（`bounced` 仅表示是否发生过 `NOT_DONE` 退回）。一切配置、模型或插件读取异常均记 warning 并 Fail-open 放行。

---

## 运行期旁路纠偏与原生 JUDGE 角色共享机制

`turn-judge`、`tool-policy-nag` 的 `intent` 通道（`detector: jev` 时）、`watchdog-agent` 的选项后端与 `lang-nag` 通过 `_shared/judge.ts` 的 `openJudge` 共用宿主的 **JUDGE 模型角色**。每次判定先交给 OMP 自己的 judge 角色链：先 `modelRoles.judge`，再 `retry.fallbackChains.judge`，未配置该键时用 OMP 内置的 judge 默认链。链会跳过没有凭据的候选，候选报 provider 错误时换下一个（401/402/403 让该候选冷却 5 分钟），遇到中止或超时即停止；从第一个原生判定 API 模型起 OMP 只保留原生候选，`openJudge` 也从不把会话模型加进链里。这条链因中止、超时以外的原因失败，或解析不出任何候选时，由 `omomp.yml` 中 `judge` 段的 `fallbackRole` 所指的角色作答（仓库配置 `fallbackRole: tiny`，即 `@tiny`）：按该角色自己的模型链（先 `modelRoles.tiny`，再 `retry.fallbackChains.tiny`）依次以提示式判定作答，跳过本地 `local` 模型。提示式答案是 one-hot（选中项概率为 1），所以选项阈值退化为“选中即生效”。没有 `judge` 段就没有回退。两个阶段的每次尝试都记入会话用量账本，完全相同的原生请求由 OMP 共享判定缓存作答。只有链和回退角色都解析不出模型时才不运行。角色设置与该段每次触发实时读取，热重载后下一次触发即生效。

### tool-policy-nag

仅作用于主会话，在 `tool_call` 阶段检查 `bash`、`bash_bg`、`exec_command`（含经 `write` 写往 `xd://bash`、`xd://bash_bg`、`xd://exec_command` 的调用）与 `eval` 代码，**只提醒、不拦截命令**。由 `omomp.yml` 的 `tool-policy-nag` 段配置（按项目 `.omp/omomp.*` → agent 目录 `omomp.*` 每次调用重读；代码里不带任何预设，没有有效配置段时所有通道都不运行）。`detector` 选择工具路由违规的检测方式：`heuristic`（`form` 通道）或 `jev`（`intent` 通道）；`risk` 是独立的第三条通道，缺省或设为 `null` 即关闭：

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

- **`detector: heuristic`**：必须有 `form`；`intent` 段被忽略（保留它只为切回时改一个词），因此不发 JUDGE 请求、不读 `INTENT-policy.md`。每次检查被监视的调用之前，扩展在主会话实时设置上加一层仅运行期的覆盖 `bashInterceptor.enabled = false`，不论 `agent/config.yml`（已打开）怎么设；子代理透读这份设置，也一并失去拦截器。detector 改变时和 `session_shutdown` 时清除这层覆盖，不写任何磁盘文件。
- **`detector: jev`**：必须有 `intent`；`bashInterceptor.enabled` 按配置生效，为真时三条通道都跳过 `bash` 调用，因为拦截器已在执行前拒绝绕过内置工具的命令（`exec_command`、`bash_bg` 与 `eval` 照常检查）。可选的 `form` 段在 intent 通道旁照常计数，仅当 intent 通道无法运行（同目录 `INTENT-policy.md` 缺失、无效或停用，或 JUDGE 角色链与回退角色都解析不出模型）时才发送它的 `prompt`；判定失败（judge 链与回退角色都失败）或 90s 超时时记一次 warning，不补发 `form` 提醒。
- **`form` 通道（启发式语法解析与计数）**：
  - 解析管道、`;`/`&&`/`||`、引号、heredoc、`$(…)`/反引号命令替换与重定向（含 `>|`、`&>`），并把每条命令还原为实际运行的程序：跳过 `NAME=value` 前缀、保留字 `if`/`elif`/`while`/`until`/`do`/`then`/`else`/`!`/`{`，以及带自身选项的包装命令（`timeout`、`env`、`nice`、`stdbuf`、`time`、`nohup`、`command`、`exec`、`builtin`、`xargs`）；跳过 `sudo`/`doas`/`su`/`ssh`，字面量 `bash|sh|zsh|dash -c '…'`、`eval '…'` 与 `find -exec … ;` 的命令体就地分析。统计六类 shell 违规：列目录（`ls`、`tree`、`fd`、不带动作的 `find`、`rg --files`、`ag -g`）、读文件（`cat`/`bat`/`nl`/`head`/`tail`/`less`/`more`/`zcat`、`sed -n`、awk 行范围与 `/start/,/end/` 区段、对单个 JSON 文件的 `jq`、单条只读 `sqlite3` 查询与 `.tables`/`.schema`、`tar -t`/`tar -xO`、`unzip -l`/`-p`）、搜索（带文件或 `-r` 的 `grep`；`rg`/`ag`/`ack` 无路径时搜当前目录，stdin 来自管道时除外；awk `/re/`；工作树上的 `git grep`）、编辑（`sed -i`、`perl -i`、`awk -i inplace`、`mv`）、写入自拟内容（`echo`/`printf`/heredoc `cat` 重定向到文件或经管道交给 `tee`）、内联脚本（`node`/`bun`/`deno`/`python`/`ruby` 在脚本参数之前带 `-e`/`-c`/`-p`/`--eval`，或 `-` 读 stdin）；另加 `eval` 文件/目录操作（`Path.read_text`、`open`、`glob`、`os.listdir`、`readFileSync`、`Bun.file`、`readdir`、`Bun.Glob`）。输出交给 shell 的列目录/读/搜不计数：`$(…)` 捕获、只经 stdin 过滤器流入 `wc`/`uniq -c`/`grep -c` 的管道、`xargs` 的参数，以及作为 `if`/`while` 条件的 `grep -q`。`/dev/*` 豁免读/搜/改/写。与 OMP 拦截器不同，`tail -f`、`locate`、带 `-delete`/`-exec rm` 的 `find`、`git ls-files` 与读 stdin 的无路径 `grep` 不计违规。
  - 前 `form.afterHits`（`3`）次违规仅记录；超过后每次违规以 steer 发送配置的 `form.prompt`（不得为空）并弹 UI 警告，每个 context 最多发 `form.maxNags`（`3`）条，之后停止，直至下次 compaction、`/clear` 或 `branch_summary`（在配置里调高 `maxNags` 立即恢复）。三个字段均必填。状态存于会话条目 `mouriya.omp.tool-policy-nag.state`，随分支切换自动重建。
- **`intent` 通道（原生 JUDGE 工具路由分类）**：
  - 每次调用并行发起一次不阻塞命令的 JUDGE `choice` 请求，题目与 12 个选项判据定义在同目录 `INTENT-policy.md`（选项：`list`、`read`、`search`、`edit`、`write`、`move`、`eval`、`ast`、`pty`、`shell`、`mixed`、`none`，内含针对 `km ls actions`、`ssh host 'cat x'`、`npm test > log`、`curl -I`、管道过滤等真实误报类的反例）。
  - Shell 调用选中非 `none`、或 `eval` 调用选中非 `eval`/`none` 且概率 $\ge$ `threshold`（`0.5`）时，在下一个 step 边界以 `aside` 插入具体提醒（点名中文意图名、应替用的内置工具及调用原文），不计数、不封顶，并记 `Tool-policy intent verdict` info 日志。
- **`risk` 通道（无模型确定性风险检测，仅看 shell）**：
  - 在 `tool_call` 内同步完成，与工具路由完全独立。同时满足三项即触发：① 简单命令段数 $\ge$ `minCommands`（`4`）或总字符数 $\ge$ `minChars`（`600`）；② 去掉 shell 内建管道件（`cd`/`echo`/`printf`/`export`/`source`/`test`/`mkdir` 等）后涉及的不同外部程序数 $\ge$ `minPrograms`（`3`）；③ 含写入步骤（重定向/`tee`/就地编辑、`rm`/`cp`/`mv`/`chmod`/`dd`/`tar -c|-x`/`rsync`/`scp`/`make`/`install`/`patch` 等写程序，或 `git add|commit|push|reset`、`gh … create|delete|download|upload`、`docker run|build|push|rm|exec`、`kubectl apply|delete|exec`、`orb push|create|delete`、`npm|pnpm|yarn|bun install|add`、`tofu|terraform apply|destroy|state|init`、`curl -o|-O|-T|-d|-X POST`、`wget -O` 等写子命令，仅取前两个非 `-` 参数词）。
  - 命中即发送拆解提醒（列出段数、字符数、外部程序与写步骤），弹 UI 警告并记 `Tool-policy risk` info 日志。

### watchdog-agent

按目标会话投放的独立运行时审阅器，由 `WATCHDOG-<label>.md` 驱动（扫描 `~/.omp/agent/extensions/watchdog-agent/` 及 `cwd` 向上至 git 根各层的 `<dir>/WATCHDOG-*.md` 与 `<dir>/.omp/WATCHDOG-*.md`，属于本机文件，不同步）：

| Frontmatter 字段 | 取值与默认值 | 行为说明 |
|---|---|---|
| `target`（必填） | `main`、子代理名（如 `task:low`）、`*`、`subagents` 或逗号列表 | 决定哪些会话运行该 watchdog |
| `name`、`enabled` | `name` 默认取文件名标签；`enabled` 默认 `true` | `/watchdog` 按 `name` 寻址；多个文件重名时命令报错并列出路径 |
| `delivery` | `aside`（默认）、`steer`、`nextTurn`、`followUp` | 提醒注入方式（`nextTurn` 等待用户下次真实输入或子代理下次 `before_agent_start`） |
| `every`、`scope` | `every` 默认 `30`；`scope` 为 `full`（默认）或 `window` | 每个工具调用与每条非空文字回复各计 1 步；满 `every` 立即后台审阅，回合结束（非 `willContinue`）对余数补跑一次。`window` 只看游标之后的新消息 |
| `maxPerContext` | 正整数，默认不限 | 两次 compaction 之间最多注入几条提醒；compaction 后清零封顶计数，不重置操作计数与 `window` 游标 |
| `model`、`tools` | 聊天 reviewer 后端（默认） | 在禁加载扩展、`taskDepth: 1` 的内存会话中运行；`model` 缺省依次试 `@advisor`、`advisor`、`@slow`、会话模型；`tools` 默认 `[read, grep, glob]`（可授 `ast_grep, web_search, edit, write, bash, eval`）。首行 `PASS`/`OK`/`LGTM`/`NONE` 为通过，其余作为 `<watchdog name=… severity=…>` 注入 |
| `instructions`、`option.<标签>[.prompt\|.delivery]` | JUDGE 后端（声明 $\ge 2$ 个 `option.*` 即启用） | 不可与 `model`/`tools`/`note` 同用；先经 OMP 的 JUDGE 角色链、再经 `judge` 段的回退角色，按正文准则从声明的小写标签选项中选一个，选中带 `.prompt` 的选项时注入该文本（无 `.prompt` 为静默通过）。失败或 90s 超时不回退聊天 reviewer |

- **游标持久化与恢复**：每次审阅得出结论后推进游标并写入会话条目 `mouriya.omp.watchdog-agent.cursor`，切换分支或恢复会话时从分支重建游标、封顶计数与未审操作数。
- **管理命令与三轮交互起草协议**：
  - `/watchdog [list]` 查看列表；`/watchdog on|off <name> [session|global]` 切换本会话覆盖或改写文件 `enabled`；`/watchdog rm <name>` 弹窗确认后删除。
  - `/watchdog add <需求>` 与 `/watchdog edit <name> [改动]` 自身不写文件，而是向当前模型发送一条 `attribution: "agent"` 消息（附完整字段说明、项目/全局路径、当前默认 reviewer 模型与已有名称），要求模型不使用 `ask`、严格按 **1. 起草（给预期行为、设置表、完整文件内容与绝对路径，本轮不写盘）→ 2. 按用户反馈修改 → 3. 用户显式确认后写盘** 三轮推进。任何触碰 `WATCHDOG-*.md` 的 `write`/`edit` 工具结果末尾都会自动附上一行即时重读识别状态（已识别 / 未识别及原因 / 合法但不在搜索路径 / 已删除）。

### turn-judge

扫描扩展目录及 `cwd` 至 git 根各层的 `TURN-JUDGE-<label>.md`，在文件所指向的会话里，每轮正常结束（assistant 消息 `stopReason: "stop"` 且有非空文字）后，每个适用文件发一次 JUDGE 请求（仓库自带 `TURN-JUDGE-gpt-talk-only.md`，见下；本机自建的文件归本机；无适用文件，或 JUDGE 角色链与回退角色都解析不出模型时静默不运行）。`task.structured` 关闭时（OMP 默认），子代理的最终报告及其对 IRC 唤醒的回复都属于这种回合。

- **适用范围**：`target` 沿用 `watchdog-agent` 的写法——逗号分隔的 `main`、`subagents`（别名 `subagent`/`sub`/`subs`）、`*`（别名 `all`/`any`）或子代理定义名 / 注册 id（如 `task:mid`），不写时默认 `main`；`model` 与 `provider` 同 `append-system-model`，为不加锚点的 JavaScript 正则，匹配被判定消息自身的 `model`/`provider`；`skipTools` 是逗号分隔的工具名，这一轮调用过其中任何一个时，该文件不判定这一轮（用于 `wt`、`harness_restart` 这类回合结束后才执行的工具）。仅当 `target` 覆盖当前会话、所写正则全部匹配且没有调用跳过工具时文件才适用；不适用的文件不发 JUDGE 请求。`target`、`skipTools` 或正则为空，或正则非法时文件无效（每进程警告一次）。
- **配置字段与输入**：frontmatter 支持 `name`、`enabled`（默认 `true`）、`target`、`model`、`provider`、`skipTools`、`maxChars`（默认 `30000`）、`option.<标签>`（至少 2 个，禁含 `.` 或空白）、`option.<标签>.prompt` 与对应的必填 `option.<标签>.threshold` $\in (0, 1]$，正文为问题原文。JUDGE 接收 `{ 时间线: [{ 类型, 内容 }], 本轮回复 }`。`时间线` 只覆盖被判定回合所属的这件工作：从分支上最后一条人类输入开始，按发生顺序列出 `用户说`（那条人类输入：非 synthetic，主会话为 `attribution: "user"`，子代理不限归属、含派发任务）、`提醒`（之后的非人类 prompt，如 harness 提醒或 turn-judge 纠偏，每条只取前 400 字）、`模型想`（思考文字：GPT、Gemini 的推理摘要，Claude 的推理；redacted 块不收）、`模型说`（assistant 文字）、`模型调用工具`（`工具名：intent`，取调用携带的 harness intent；参数和结果不收）。被判定消息自身的思考排在 `时间线` 末尾，它的文字是 `本轮回复`；超 `maxChars` 字时，从 `用户说` 之后最早的条目整条丢弃。`skipTools` 只看模型上一次以 `stop` 结束之后的工具调用，所以由纠偏 prompt 或提醒开启的新一轮从零算起。
- **仓库自带的 `TURN-JUDGE-gpt-talk-only.md`**：`target: main`、`model: (^|/)[Gg][Pp][Tt]`（任意 GPT 模型）、`skipTools: wt, harness_restart`；选项为 `做完在汇报` / `只需文字` / `只说不做`，`只说不做` 概率 $\ge 0.8$ 时自动输入一条 prompt，要求模型别再宣布下一步或认错，直接用工具继续做。针对的是 GPT 当主 agent 时，交代的工作没做完就只用文字结束回合的习惯；列出计划、方案或选项等用户确认属于正当的纯文字。阈值用 2026-10-10 至 2026-10-25 经 `skipTools` 过滤后的 329 个 GPT 主会话回合、在 JUDGE 角色 `futureppo-jev/decision-model-preview` 下校准：能抓住道歉认错、复述要求后就停的回合（19 个人工标注正例中抓到 6 个），23 个标注反例和 287 个未标注回合都未误判，抓不到“正在进入示例运行验证”这类中途进度说明；标注是维护者自己对会话记录的判断，没有留出集；判定模型跟随本机 JUDGE 角色。
- **主会话触发与合并通知**：判定在后台运行。在所有带 `.prompt` 且概率 $\ge$ `.threshold` 的选项中，取概率最高者将其 prompt 以 `attribution: "agent"` 自动发出（引起的新一轮同样会被判定，无上限）；其余未触发文件等本轮全部判定返回后合并弹出一条 UI info 通知 `turn-judge <name>：<选中标签>（<各选项概率>）`。判定返回前若用户已输入或切换了会话/分支，则只弹 info 不再自动输入。
- **子代理触发**：`message_end` 处理器在 20 秒总时限内等待判定（OMP 等待扩展处理器的上限是 30 秒），因此 task 执行器不会先于判定收走结果。若有文件按时触发且被判定消息之后分支没有新消息，处理器等子代理空闲后，把全部触发的 prompt 合成一条 `attribution: "agent"` 消息发出、开启新回合，确认新回合已开始后返回。子代理对它的回复会替换原报告成为父代理收到的结果，所以面向子代理的 prompt 应要求给出完整修订报告；反复触发的文件会让子代理一直不返回。超时或过期的判定只记录、不发送。子代理没有 UI，判定与警告只写入 OMP 日志。

### lang-nag

仅作用于主会话。在 `agent_end` 取最后一条有正文回复的最后一段（前 200 个字符），向上述 JUDGE 角色链发一道选择题，判断是否主要为 `language`（仓库配置：`language: 中文`、`instruction: 说中文`，会话开始或切换时读取；没有可用候选或全部候选失败时不提醒）。若判定为否，在用户下一条真实输入前拼接 `"说中文\n\n"`（斜杠命令清掉待用判定；若用户发送时判定尚未完成则中止判定并原样放行）。

---

## 宿主资源监控、交互工具与会话控制

### child-memory-warning

macOS（Darwin）专属，完整模式与轻量模式均启用。首个主会话在 `session_start` 通过 Bun FFI 调用系统 LP64 `libproc`/`sysctl` ABI，启动每进程唯一的 2 s 采样定时器（主会话切换只刷新投递上下文，主会话关闭时先清定时器再关句柄；非 Darwin 平台仅记一条 `未启用` info 日志）：

- **物理内存口径与孤儿归属**：读取 `proc_pid_rusage` 的 `ri_phys_footprint`（含压缩与换出内存，非 RSS），以 `PID + 内核启动时间` 标识进程身份。经两遍进程表核对后追踪本 OMP 进程的全部后代及由后代组长创建的进程组；已被观测到的后代即使父进程退出变成孤儿（`PPID === 1`）仍保留归属直至进程结束（仅在两次采样间隔内出生并立即变成无存活组锚点孤儿的短命进程无法追溯）。
- **阈值配置**：`omomp.yml#child-memory-warning.thresholdGiB`（仓库配置 `4`，任意正数，可带小数）。主会话 cwd 下 `.omp/omomp.*` 的同名段优先于 agent 目录的段；每次采样都重读，改动从下一次 2 s 采样起生效，无需重启。没有有效配置段时继续追踪进程归属但暂停告警；每出现一个新的配置问题（配置段缺失或无效、项目副本被跳过）记一条 warning 日志并弹一次主 UI warning。
- **告警投递**：当任一归属后代的 `phys_footprint` 超过阈值时，每个进程身份告警一次（弹主 UI warning，并向主 agent 发送含 PID、PPID、是否孤儿、GiB/bytes 读数、阈值与 240 字符命令的 `attribution: "agent"` 消息），**只告警、不发信号杀进程**。

### input-polish

仅作用于主会话交互式 TUI。在输入框按下配置组合键（默认 `Ctrl+Enter`；不支持 Kitty 键盘协议或 `modifyOtherKeys` 的终端可配为 `alt+enter`）时，通过 raw terminal-input 监听器拦截按键，用 OMP 模型角色 `@input-polish`（在 `/model` 中指定；思考强度取角色条目的 `:level`，否则关闭），再用 `fallbackRole` 所指的角色（`omomp.yml#input-polish` 仓库配置：`key: ctrl+enter`、`instruction: 在不改变原意的前提下，改写到听起来会让人更加想努力、能激动人心，但不要太夸张。`、`fallbackRole: smol`）在 `taskDepth: 1` 无工具内存辅助会话中流式润色草稿，并将改写流式显示在覆盖输入框的只读 overlay 浮层中（输入框始终保留原草稿）；某个模型失败时换角色链中的下一个模型，并先清空预览：

- **按键与占位符保真**：润色和预览期间吞掉其他按键；润色完成后按 `Enter` 关闭浮层、将润色稿写入输入框并放行同一次回车走原生提交流程，按 `Esc` / `Ctrl+C` 中止并关闭浮层且原草稿不变。空白草稿或以 `/`、`!`、`$` 开头的草稿不润色。若改写稿中 `[Paste #N …]` 或 `[Image #N …]` 占位符数量或内容与原文不一致，直接按失败处理并在浮层显示原因。

### doc-polish

注册 `polish_doc` 工具与 `/polish-doc <path…>` 命令，在不改变原意的前提下重排、润色 `.md` / `.txt` 文档。**绝不修改源文件**，而是在 `/tmp/doc-polish/<时间戳>-<文件名>/` 下生成原文副本、切分索引 `split.json` 与逐组对照审校报告 `review.md`：

- **三阶段内存子代理流水线**（均传 `taskDepth: 1`、禁加载扩展防递归）：
  1. **拆分（Split）**：仅持 `[read, write]` 工具，自行读取原文并写出带起止行号的段落块索引与全文术语表。
  2. **润色（Polish）**：无工具，按每批正文 $\le 5000$ 码点（超长单段单独成批，不截断）及该批相关术语表并发重写，返回润色文本与术语变更；随后用并查集按 `sourceIndices` 识别跨段合并并重新编组。
  3. **校验（Check）**：无工具，按同一并发上限逐组判断改写是否保持原意。
- **模型与本机配置**：每个阶段从各自的 OMP 模型角色取模型，在 `/model` 中指定：`@doc-polish.split`、`@doc-polish.polish`、`@doc-polish.check`，各自之后再接 `omomp.*` 中 `doc-polish` 段 `fallbackRole` 所指的角色（项目 `.omp/omomp.*` 优先于 agent 目录）。角色条目的 `:level` 决定该阶段的思考强度；`@doc-polish.check` 没有自己的模型时使用拆分角色链；并发默认 `6`。`doc-polish` 段属于本机（仓库不带，`/update-omp` 在缺失时会询问是否创建），典型本机配置示例：

```yaml
doc-polish:
  fallbackRole: default
  concurrency: 8
```

- **失败处理与接收方硬约束**：开始处理前先解析拆分与润色两个角色，任一解析不出模型立即报错退出（不写 `/tmp/doc-polish/`，并列出需要指定的角色）；子代理请求所用模型失败时换该角色链中的下一个模型（每次尝试前先清掉切分索引），润色输出无法解析的批次保留原文并在报告中标出。`review.md` 记录每个阶段实际作答的模型。返回结果附有硬性指令：接收方（主 agent）必须亲自处理并完整通读每份 `review.md`，严禁转交子代理或只读摘要/分页截断。

### wt-tool

仅在交互式 TUI 主会话中启用 `wt` 与 `wt_remove` 工具（默认 `defaultInactive`，主会话 `session_start`/`session_switch` 时激活）。由于 OMP 的 `/wt` 与 `/move` 在流式生成期间拒绝运行，且 `ExtensionAPI` 不暴露 `InteractiveMode` 实例，扩展在单次同步 `ctx.ui.setEditorComponent(undefined)` 调用中临时替换 `InteractiveMode.prototype.setEditorComponent` 捕获活体 `InteractiveMode` 实例，将请求排入单槽队列并要求模型立即结束本轮；待回合真正结束（非 `willContinue` 的 `agent_end`）且会话空闲时，调用 TUI 内置的 `executeBuiltinSlashCommand` 原样执行（期间临时包装 `showError`/`showWarning`/`showStatus`/`present` 捕获提示文字并屏蔽 `editor.addToHistory`，执行后以 `attribution: "agent"` 消息开启新一轮回传结果；若用户按 Esc 中断回合则取消请求）：

- **`wt`（创建并切入 linked worktree）**：调用内置 `/wt [<branch>]`。若当前会话已在某个 linked worktree 中，首次调用**什么都不建**，仅返回当前 worktree 路径、分支、HEAD、未提交项数、主 checkout、强行再建的后果及状态 `confirm` 哈希；确需再分叉时须带该 `confirm` 二次调用才入队。
- **`wt_remove`（移回主 checkout 并强制删除当前 linked worktree，保留分支）**：必须分两步调用：
  1. **不带 `confirm`（只读检查）**：报告 worktree 与主 checkout 路径、判定（`SAFE` / `UNSAFE` / `BLOCKED`）、删除将永久丢失的文件清单（staged、unstaged、untracked、ignored，每类最多列 50 条及总数）、主 checkout HEAD 不可达的分支提交（保留在分支上）、阻塞项（本会话运行中的后台任务、运行中或 cwd 在该 worktree 内的活跃 task subagent），以及绑定当前工作区指纹（HEAD、分支 tip、porcelain 状态、改动文件大小/mtime、ignore 清单）的确定性 `confirm` 哈希。
  2. **带 `confirm`（确认执行）**：再次核对指纹与阻塞项，一致才入队；空闲执行时按 **重检指纹 → 执行 `/move <主 checkout>` → 确认新 cwd → 再检指纹 → 调用宿主 `worktreeRemove(path, true)` 强制删除目录** 顺序执行，任何一步状态变化或出现阻塞即刻停下并如实回传停在哪一步。

### harness-restart

仅在交互式 TUI 主会话中启用 `harness_restart` 工具（轻量模式同样保留）。采用与 `wt-tool` 相同的队列与 `InteractiveMode` 原型捕获机制：调用后登记请求并要求模型立即结束本轮；会话空闲后，在调用活体 `InteractiveMode.restart()` 前一刻向当前分支追加持久化自定义条目 `mouriya.omp.harness-restart.request`（记录 `reason` 与时间戳）；重启后的新进程恢复会话时，在 `session_start` 扫描到该标记并自动发送一条 `attribution: "agent"` 消息 `"Harness restart completed（<时间>）。Reason was: <原因>。Continue what you were doing."`。

### commandcode-model-spec

修复通过 `--model` 启动参数指定 `commandcode` 模型时出现的两类宿主认证失败：① **缓存遮蔽**（`models.db` 将发现的 commandcode 模型缓存为 `openai-completions`/`anthropic-messages`，导致 `--model` 走宿主 transport 而非插件的 `commandcode-custom` 报 401）；② **前缀冲突**（如 `google/gemini-3.5-flash-lite` 被切分到无凭据的内置 `google` provider 报缺 API key）。扩展在 `session_start` 读取 `<agentDir>/commandcode-models.json`（可由 `COMMANDCODE_MODELS_CACHE` 覆盖），当所选模型在目录中且当前 `api !== "commandcode-custom"`（且非内置已授权可用模型）时，调用 `setModel` 将其重选回 `pi-commandcode-provider` 插件实时注册的模型。

### antigravity-wire-profiles

让每个 Antigravity（`google-antigravity`）请求的 `generationConfig.maxOutputTokens` 与 `labels.model_enum` 以后端模型列表为准，而不是 OMP 手工抓包的 `ANTIGRAVITY_MODEL_WIRE_PROFILES` 表（`@oh-my-pi/pi-catalog/wire/gemini-headers`）。provider 只对表里有的 wire id 替换调用方的 `maxTokens`；抓包之后新增的 id（`gemini-4-argon-*`）不在表里，于是 compaction 的 short summary 以 512 输出 token、high thinking 发出，报 `thought-only response without final output`。扩展在根会话 `session_start`（同步等待，预算 20 s；`before_agent_start` 等待同一次加载）用本会话凭据和全部已存 Antigravity 账号调用 `POST <baseUrl>/v1internal:fetchAvailableModels`，合并在服的行（非 internal、非 disabled、`maxOutputTokens` 为正整数），原地写入导出的表。只新增或覆盖条目、从不删除，因为一个账号的列表不能证明别的账号没有该模型。provider 每次请求都读这张表，所以普通轮次、compaction 和同进程子代理都用后端值；表里有的 wire id 会忽略调用方的 `maxTokens`（这张表原有的约定）。所有账号都拿不到可用列表时，表保持原内容，日志与主 UI 各出一条警告，下次根会话启动时重试。

### omomp-lang

决定本地扩展与 omp 插件所有面向人的文字使用的语言（`en` 或 `zh`）：通知、widget、状态栏条目、对话框、浮层、命令与快捷键说明、工具标签和渲染器。发给模型的文字（prompt、steer、工具描述、工具结果内容）、日志和用户数据保持原文。

- **配置**：`omomp.yml#omomp-lang.language`（仓库值 `zh`），只读 agent 目录的 `omomp.*`：语言属于整个进程，因此不读项目 `.omp/` 副本。修改从下次 OMP 启动起生效。
- **导出**：扩展在模块加载时把 `process.env.OMOMP_LANG` 设为该值，除非启动环境已指定语言（`OMOMP_LANG=en omp`，或 omp-playbooks 以自身语言启动的 Tern 面板）；显式的启动值优先。子进程继承该变量。第一个主会话把无效的 `omomp.*` 副本报告一次（日志 + 界面警告）。
- **解析**（`_shared/i18n.ts` 的 `tr(en, zh)`，在文字产生处调用）：`OMOMP_LANG` 为 `en`/`zh`（不分大小写）→ `omomp-lang` 配置段 → `LC_ALL`、`LC_MESSAGES`、`LANG` 中第一个非空值（以 `zh` 开头为中文）→ 英文。每个使用方除了读导出的变量，还会自己读配置段，因为 OMP 并发导入扩展模块，且在交互模式下把不注册 provider、快捷键、composer 形态或文件回退的扩展推迟到首帧之后才绑定（`startup-deferral.ts`）；`omomp-lang` 加载之前产生的文字同样遵循 `omomp.yml`。
- **插件**：只运行在 OMP 中的插件（`omp-todo-more`、`omp-playbooks`、`omp-thinking-translator`、`omp-codex-image-gen`、`omp-remote-build`）在各自的 i18n 模块中按同一条链解析。兼容 Pi 的插件（`omp-unified-exec`、`pi-bansos`）只读环境变量，因此它们在 `omomp-lang` 加载前注册的文字跟随 locale。omp-playbooks 把自身语言传给它启动的 Tern 面板（`env OMOMP_LANG=…`）。npm 插件 `pi-commandcode-provider` 与 `pi-package-search` 属于第三方，只显示英文。

## 本地扩展总览表

| 序号 | 扩展目录 | 所属章节 | 作用域 | 轻量模式 | 配置源（`omomp.yml` 段或同目录文件） |
|---|---|---|---|---|---|
| 1 | `system-prompt-replace` | [提示词与上下文](prompts-and-context.zh-CN.md#system-prompt-replace) | 主 + 子 | 否 | `omomp.yml#system-prompt-replace`（仓库托管） |
| 2 | `append-system-model` | [提示词与上下文](prompts-and-context.zh-CN.md#append-system-model) | 主 + 子 | 是 | `APPEND_SYSTEM_MODEL.md`（本机独占） |
| 3 | `repo-rules` | [提示词与上下文](prompts-and-context.zh-CN.md#repo-rules) | 主 + 子 | 是 | 扫描 `.claude/rules`、`.agents/rules`、`.pi/rules`（cwd 向上至 git 根）、`~/.claude/rules`，并读取 OMP 原生规则的 `paths` |
| 4 | `fork-task` | [提示词与上下文](prompts-and-context.zh-CN.md#fork-task) | 主 + 子 | 否 | 无配置文件 |
| 5 | `model-compaction` | [提示词与上下文](prompts-and-context.zh-CN.md#model-compaction) | 主写 / 子读 | 是 | `omomp.yml#model-compaction`（本机独占） |
| 6 | `user-prompt-inject` | [子代理与顾问](agents.zh-CN.md#user-prompt-inject) | 子代理 | 否 | `PROMPT-INJECT-*.md`（仓库带 `user-goal.md`） |
| 7 | `isolation-nudge` | [硬门禁](#isolation-nudge) | 主 + 子 | 否 | 无配置文件 |
| 8 | `task-split-check` | [硬门禁](#task-split-check) | 主 (`split`) / 主+子 (`report-limit`) | 否 | `omomp.yml#task-split-check`（仓库托管） |
| 9 | `task-completion-judge` | [硬门禁](#task-completion-judge) | `task:low/mid/free` | 否 | `omomp.yml#task-completion-judge`（仓库托管） |
| 10 | `tool-policy-nag` | [旁路判定](#tool-policy-nag) | 主会话 | 否 | `omomp.yml#tool-policy-nag` + `INTENT-policy.md`（仓库托管） |
| 11 | `watchdog-agent` | [旁路判定](#watchdog-agent) | 主 + 子 | 否 | `WATCHDOG-*.md`（本机独占） |
| 12 | `turn-judge` | [旁路判定](#turn-judge) | 主 + 子（按文件 `target`） | 否 | `TURN-JUDGE-*.md`（`gpt-talk-only` 仓库托管；其余本机自建） |
| 13 | `lang-nag` | [旁路判定](#lang-nag) | 主会话 | 否 | `omomp.yml#lang-nag`（仓库托管） |
| 14 | `child-memory-warning` | [宿主与 TUI](#child-memory-warning) | 主进程全局 | 是 | `omomp.yml#child-memory-warning`（仓库托管） |
| 15 | `input-polish` | [宿主与 TUI](#input-polish) | 主 TUI | 是 | `omomp.yml#input-polish`（仓库托管） |
| 16 | `doc-polish` | [宿主与 TUI](#doc-polish) | 主 + 子 | 否 | `omomp.yml#doc-polish`（本机独占） |
| 17 | `wt-tool` | [宿主与 TUI](#wt-tool) | 主 TUI | 是 | 无配置文件 |
| 18 | `harness-restart` | [宿主与 TUI](#harness-restart) | 主 TUI | 是 | 无配置文件 |
| 19 | `commandcode-model-spec` | [宿主与 TUI](#commandcode-model-spec) | 主 + 子 | 是 | 读取本机 `commandcode-models.json` |
| 20 | `antigravity-wire-profiles` | [宿主与 TUI](#antigravity-wire-profiles) | 根主会话（表为进程全局） | 是 | 后端 `fetchAvailableModels` 列表；无文件 |
| 21 | `omp-config-autoupdate` | [同步与运维](operations.zh-CN.md#omp-config-autoupdate) | 根主会话 | 是 | `omomp.yml#omp-config-autoupdate`（本机独占） |
| 22 | `omomp-lang` | [宿主与 TUI](#omomp-lang) | 进程全局（模块加载） | 是 | `omomp.yml#omomp-lang`（仓库托管） |
