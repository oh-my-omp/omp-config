---
description: 渐进式引导理解 omp-config 的长程任务正确性设计、当场调查运行时控制面并完成本机定制与安装
argument-hint: "[check|<plane>]"
---

以渐进式交互引导用户理解 `omp` 与 `omp-config` 的设计取舍、当场调查各运行时控制面的真实配置与内置文档、划分必选基底与可选/可定制行为闭包，并在保持仓库工作树干净的前提下完成本机配置定制与安装。不使用 subagent，在主会话中直接执行。

## 核心定位与执行守则

1. **为什么需要一次引导**：
   - 与 `omp` 相比，Claude Code 和 Codex CLI 接近最小工具循环（毛坯房）；但 `omp` 原生默认状态关闭或未配置大量关键能力（`github`、`astGrep`、`checkpoint`、`extendedContext`、`inlineToolDescriptors`、`edit.mode: hashline`、`readLineNumbers` 等）。
   - `omp-config` 不仅打开这些原生底座，而且**围绕长程任务的正确性（而非节省 token）构建运行时控制层**——这与主流 harness 提倡“尽早压缩上下文、用 grep/sed 跳过上下文读取、限制子代理汇报字数以省 token”的做法相反。
   - 本命令只需由 AI 带着用户跑一次：不预先堆砌静态说明书，而是按控制面**当场调查** `omp://` 内置文档、`tool://` 专题与本仓库配置，只向用户呈现**运行时如何控制 AI（触发信号 → 拦截/注入/裁决 → 模型可观测行为）**，不讲内部 TypeScript 代码实现细节。
2. **冷启动安全与工具纪律（自举约束）**：
   - 本命令可能在尚未安装 `omp-config` 的原生 `omp` 中运行：不得假定 `omp-ask-more`、`omp-unified-exec`（`exec_command`）、`tool-topics`（`tool://`）、`session-urls`（`session://`）、`wt-tool` 或 `harness-restart` 已加载。
   - 在核对并完成模型角色绑定前，不得调用任何依赖特定模型角色或作者订阅的扩展工具（如 `polish_doc`、`task`、`fork_task`）。
   - **文件与目录检查必须使用 `read`、`glob`、`grep` 工具**：严禁在 `bash` 中运行 `ls`、`cat`、`head`、`tail`、`find`、`grep` 或用 `python3 -c` 解析本地文件（会直接触发 `tool-policy-nag`）。`bash` 仅用于执行 `omp` CLI、`bun` 更新器脚本、`./plugin-audit.sh` 与 `git status`。
   - **阶段 0–2 及 `check` 模式属于调查与讨论阶段（非工作阶段），严禁初始化 `todo`**：只有用户在 `ask` 中明确确认要执行安装或写入本机配置、正式进入阶段 3 时，才初始化 `todo`。
   - 每完成一个阶段的现场调查，必须使用 `ask` 工具（原生或 `omp-ask-more`）让用户选择下一步深挖的控制面、确认本机定制项或决定是否执行安装；严禁一次性倾倒全部 26 个扩展与 11 个插件的细节。
3. **所有权红线（仅改本机所有项，仓库项默认只诊断不改工作树）**：
   - 任何写入前，先用 `read` 从 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 读取 `LOCAL_CONFIG_FIELDS`、`LOCAL_OMOMP_SECTIONS`、`MACHINE_LIST_FIELDS`、`STRUCTURED` 与 `managedPlain`。
   - **本机所有项**（`<agentDir>/config.yml` 的 `LOCAL_CONFIG_FIELDS` 与 `extensions` 本机前置项、`<agentDir>/omomp.yml` 的 `LOCAL_OMOMP_SECTIONS`、`<agentDir>/models.yml`、`<agentDir>/commandcode-models.json`、`APPEND_SYSTEM_MODEL.md`、`WATCHDOG-*.md`）：在用户确认后直接写入本机 `<agentDir>`（由 `omp config path` 或 `PI_CODING_AGENT_DIR` / `~/.omp/agent` 决定），更新器与启动自动更新不会覆盖它们。
   - **仓库所有项**（`agent/config.yml` 的 `task.agentModelOverrides` 等非本机字段、`agent/omomp.yml` 的仓库段、`agent/thinking-translator.json`、`install-plugins.sh`、`agent/agents/*.md`、仓库自带的 `PROMPT-INJECT-user-goal.md` / `TURN-JUDGE-gpt-talk-only.md`）：**默认只做当场可用性诊断并输出定制片段，不修改仓库工作树，也不直接改 `<agentDir>` 中会被 `/update-omp` 覆盖的同名字段**。这样工作树保持干净，可安全开启 `/omp-config-autoupdate on`。只有用户明确要求维护个人分支/fork 并修改工作树时，才编辑工作树并提醒关闭上游自动更新。
4. **当前全量安装与可选划分的诚实边界**：
   - 当前更新器 `omp-config-update.ts` 对仓库受管文件与 `install-plugins.sh` 未注释插件执行**全量安装**；日常轻量会话通过 `omp-light` 在进程启动时跳过 10 个长程监督/子代理治理扩展与 `system-prompt-replace`。
   - 引导中对“必选基底 / 条件必选 / 可选增强”的划分，一方面帮用户决定当前启用哪些本机开关、使用 `omp` 还是 `omp-light`，另一方面作为后续可选安装器（selective installer）的行为闭包规格；不得向用户谎称当前更新器会按勾选跳过文件写入。

当前传入参数：`$ARGUMENTS`
- 参数为空：按阶段 0 → 阶段 4 渐进执行完整引导、本机定制与安装。
- 参数为 `check`：只读诊断模式（非工作阶段，不建 `todo`、不调 `ask`、不修改任何本机或仓库文件）。依次执行阶段 0 现场盘点、`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source . --check` 与 `./plugin-audit.sh`，直接输出完整的《本机兼容性与原子行为闭包诊断报告》并结束。
- 参数为 `<plane>`（`1`–`8` 或控制面关键词）：执行阶段 0 盘点后直接跳转至指定控制面的深度现场调查与定制。
---

## 阶段 0：现场盘点（只读调查，不改文件、不建 `todo`）

在向用户提问前，用 `read`/`glob`/`grep` 与必要的 `omp` CLI 并行建立当前机器与仓库的基线事实：

1. **本机环境与已安装状态**：
   - 在 `bash` 中运行 `omp config path`、`omp config list --scope global --json`、`omp plugin list --json`；用 `glob` 检查 `<agentDir>/*`、`~/.pi/agent/*` 与 `~/.claude/*` 是否存在，用 `read` 读取 `<agentDir>/omomp.yml`（若存在）。
   - 检查本机已配置凭据的 provider（通过 `omp models` 或 `omp config list --scope global --json`；**严禁直接 `read` `<agentDir>/models.yml` 全文以免暴露其中的 `apiKey:` 字段**，如需检查 `supportsReasoningEffort` 仅对该词执行 `grep`；严禁打印或解密任何凭据原文、严禁触碰 macOS Keychain）。
2. **OMP 原生默认与 `agent/config.yml` 差分**：
   - 读取 `agent/config.yml`、`agent/config-light.yml`、`agent/omomp.yml`、`install-plugins.sh`，并对照 `omp://settings.md`、`omp://compaction.md`、`omp://tools/edit.md`。
   - 提炼出两组核心对比：
     - **原生默认关闭或未配、`omp-config` 显式打开的底座**：`github.enabled: true`、`astGrep.enabled: true`、`fetch.enabled: true`、`checkpoint.enabled: true`、`extendedContext: true`、`inlineToolDescriptors: "on"`、`tools.xdevDocs: inline`、`edit.mode: hashline`、`readLineNumbers: true`、`textVerbosity: high`、`expandThinkingBlocks: true`、`task.eager: preferred`、`task.isolation: { enabled: true, merge: branch }`、`task.maxConcurrency: 64`。
     - **原生默认开启、`omp-config` 显式关闭并替换的机制**：`todo.enabled: false`（由 `omp-todo-more` 替换）、`launch.enabled: false`（由 `omp-unified-exec` 的 `exec_command` 替换）、`eval.tools.enabled: false`、`compaction.asyncEnabled: false`（关闭提前 32k token 的后台有损预摘要）、`task.disabledAgents: [task, scout, sonic, reviewer, security-reviewer]`（禁用内置人设子代理，改用无状态 `task:high/mid/low/free` 加受边界约束的 3 个顾问）。
3. **本机与仓库配置的冲突预检**：
   - 对照 `agent/config.yml#task.agentModelOverrides`（`anthropic`、`openai-codex`、`bansos`、`opencode-go`）与 `agent/thinking-translator.json`（`futureppo-pool`、`commandcode`），找出当前机器缺少凭据或未配置 `models.yml` 兼容项的模型引用。

完成盘点后，先向用户展示简明的**基线诊断摘要**（当前机器状态、原生 OMP vs `omp-config` 的长程正确性设计反转、检测到的模型/语言待适配项），再用 `ask` 询问：
- 希望按推荐顺序渐进了解八个运行时控制面，还是只看关心的控制面，或直接进入本机定制与安装？
- 用户日常使用的主力模型订阅/provider 与界面/回复语言偏好是什么？

---

## 阶段 1：八个运行时控制面的渐进式现场调查

按用户在 `ask` 中选择的路径推进（建议每次 2–3 个相关控制面，每轮末尾用 `ask` 确认是否展开细节或进入下一组）。对每个控制面，AI **当场读取表中列出的权威源**，按统一结构向用户讲解：
- **运行时控制链**：`什么信号触发 → 哪个钩子/工具/判定器介入 → 拦截、改写还是注入什么消息 → AI 在当前回合/下一回合/压缩后表现出什么行为`；
- **为何这样设计（长程正确性 vs 省 token）**；
- **行为闭包（哪些组件耦合在一起，不能单拆）**。

| 控制面 | 现场调查入口（按需读取，勿背诵） | 核心运行时控制机制与行为闭包 |
|---|---|---|
| **1. 原生引擎底座与文件读写纪律** | `agent/config.yml`、`omp://tools/edit.md`、`omp://tools/eval.md`、`agent/extensions/tool-topics/TOPIC-edit-hashline-*.md` | **触发链**：编辑文件前必须先经非 `:raw` `read` 拿到 `[PATH#TAG]` 快照锚点才允许 `edit`（`edit.mode: hashline`）；`eval` 工具说明与 `bashInterceptor` 禁止在 Python/JS 或 shell 中用 `cat`/`grep`/`sed -i`/`open()` 盲搜盲改本地文件。<br>**设计取舍**：长程任务中多读几十行邻近上下文的 token 成本极低，而在无编译保护的脚本/配置中脱离上下文盲改会直接造成破坏。属于**必选基底**。 |
| **2. 提示词分层与按需知识注入** | `agent/SYSTEM_TEMPLATE.md`、`agent/PERSONALITY.md`、`agent/APPEND_SYSTEM.md`、`agent/omomp.yml#system-prompt-replace`、`agent/extensions/tool-topics/`、`agent/extensions/repo-rules/index.ts`、`omp://system-prompt-customization.md` | **触发链**：`SYSTEM_TEMPLATE.md` 剔除重复工具说明；`tool-topics` 在每次 `before_agent_start` 把工具说明压成表层说明加 `Topics` 索引，写操作前由模型按需读 `tool://<tool>/<topic>`，只读调用（`read`/`grep` 及误用的 `ssh cat`）后由 `tool-topic-injection` 在 `tool_result` 注入对应专题（同一活动分支只注入一次）；`repo-rules` 扫描 `.claude/rules`、`.pi/rules` 并把带 `paths` 的规则推迟到触及匹配文件时才通过 `additionalContext` 注入；`system-prompt-replace` 在最后统一修正冲突措辞。<br>**行为闭包**：`SYSTEM_TEMPLATE.md` + `tool-topics` + `tool-topic-injection` + `repo-rules` 构成**必选基底（`prompt-topics`）**；`APPEND_SYSTEM.md` 与 `system-prompt-replace` 随完整模式开启（`omp-light` 跳过）。 |
| **3. 长程状态、Todo 检查点与压缩恢复** | `docs/plugins-and-modes.zh-CN.md#todo-more`、`docs/prompts-and-context.zh-CN.md#上下文与压缩`、`agent/extensions/model-compaction/index.ts`、`agent/extensions/fork-task/index.ts`、`agent/extensions/session-urls/index.ts`、`omp://compaction.md` | **触发链**：工作阶段（会改动文件/配置/git/外部状态）未初始化 Todo 时，`omp-todo-more` 在 `tool_call` 拦截 `edit`；有未提交改动的 git 仓库中执行 `DONE` 必须附带 commit 子句，形成带 SHA 的逻辑检查点并写入 `Task log`；回合结束仍有未完成项时自动提醒继续。压缩按损耗从低到高排序（`remote → soft → snapcompact → handoff → shake`），关闭 `asyncEnabled` 提前 32k 摘要，并在主会话压缩后自动 steer 注入 `<post-compact-ctx>`（`ctx list` + `ctx show`）。子代理需要完整历史背景时由 `fork-task` 复刻当前分支请求前缀（共享缓存前缀）。<br>**行为闭包**：`config.yml#todo.enabled: false` + `omp-todo-more` + `system-prompt-replace`（删去子代理禁止 Todo 的句子）+ `task-completion-judge`（读取 `omp-todo-more:read`）构成**不可拆分的 `todo-continuity` 必选闭包**。 |
| **4. 子代理编排、顾问隔离与交付裁决** | `docs/agents.zh-CN.md`、`agent/agents/*.md`、`agent/extensions/user-prompt-inject/`、`agent/extensions/isolation-nudge/index.ts`、`agent/extensions/task-split-check/index.ts`、`agent/extensions/task-completion-judge/index.ts` | **触发链**：禁用内置人设子代理，执行侧统一用无状态 `task:high/mid/low/free`（按成本与可信度分档，跨订阅分摊）；顾问侧仅设 `discuss:steady`（只读保守审查）、`discuss:divergent`（只读发散替代方案）和 `mentor:default`（无工具计划/交付会商），并由 `user-prompt-inject` 在每次模型请求开头直接注入根会话用户原话与 `ask` 回答，防止主代理转述偏差。派发时 `isolation-nudge` 拦截 $\ge 2$ 个并发可写任务共用 cwd，`task-split-check` 拦截多主题塞同一 worker 及限制汇报字数（`report-limit`）；交付时 `task-completion-judge` 核对 Todo `goal`、验证工具调用记录与未完成项，不达标则退回。<br>**行为闭包**：`APPEND_SYSTEM.md` 顾问规则 + 3 个顾问定义 + `user-prompt-inject` 构成**顾问治理闭包（`advisor-governance`）**；`task:*` 定义 + `fork-task` + 三个派发/交付检查扩展构成**子代理治理闭包（`subagent-gates`）**。两者在 `omp-light` 中整体跳过。 |
| **5. 运行时偏离纠偏与回合监督** | `agent/extensions/tool-policy-nag/`、`agent/extensions/turn-judge/`、`agent/extensions/watchdog-agent/`、`agent/extensions/lang-nag/index.ts`、`docs/extensions.zh-CN.md#基于-judge-角色的扩展` | **触发链**：前沿模型在长会话中会逐步忽略静态 system prompt。`tool-policy-nag` 将主会话在 shell/eval 中查改本地文件的违规调用当作偏离信号：默认 `detector: heuristic` 会在运行时将 `bashInterceptor.enabled` 覆写为 `false`（让命令不被硬拦而进入计数器），累计 `afterHits: 3` 次后注入伪装成用户观察的 user 角色 steer 消息（`"你为什么不遵守system prompt，反思自己以后继续。"`，利用厂商对 user 消息更高的注意力权重把模型拉回 system prompt）。`turn-judge`（`TURN-JUDGE-gpt-talk-only.md`）在 GPT 主会话只说不做停下时自动发消息督促继续调工具；`watchdog-agent` 按 `WATCHDOG-*.md` 每 `every` 步后台审阅；`lang-nag` 在回复非目标语言时于下一轮用户输入前拼上 `"说中文\n\n"`。<br>**行为闭包**：构成**长程纠偏包（`drift-monitors`）**，在 `omp-light` 中整体禁用；注意 `tool-policy-nag`（`heuristic`）与 `bashInterceptor` 在运行时的联动覆盖关系。 |
| **6. 命令执行、安全删除与工作区控制** | `agent/extensions/delete-guard/`、`agent/extensions/wt-tool/index.ts`、`agent/extensions/harness-restart/index.ts`、`agent/extensions/child-memory-warning/index.ts`、`agent/extensions/tool-topics/TOPIC-exec_command-*.md` | **触发链**：`config.yml#launch.enabled: false` 关闭原生后台服务模式，所有长生命周期/交互式进程统一走 `omp-unified-exec` 的 `exec_command` PTY 会话。`delete-guard` 在 `tool_call` 解析 `bash`（含 `xd://bash`、嵌套 shell、Windows `powershell`/`cmd`）与 `eval`（Python/JS），拦截任何删除命令（`rm`/`unlink`/`rmdir`/`shred`/`find -delete`/`rmtree`/`rmSync` 等）和非字面命令，引导模型改用只收字面路径的 `delete` 工具（默认进系统回收站 `trash`；`permanent` 每次弹窗确认，无 UI 会话禁止永久删除）。`wt-tool` 与 `harness-restart` 将 `/wt`、`/move` 与进程重启排入回合空闲队列，重启后自动发恢复消息继续任务；`child-memory-warning`（仅 macOS）每 2 秒采样后代进程物理内存，超 `4 GiB` 告警。<br>**行为闭包**：`launch.enabled: false` + `omp-unified-exec` + `TOPIC-exec_command-*` 构成**PTY 执行路由必选闭包（`pty-routing`）**；`delete-guard` 构成**安全删除必选闭包（`safe-deletion`）**。 |
| **7. 人机交互、润色与展示** | `docs/plugins-and-modes.zh-CN.md`、`agent/extensions/input-polish/index.ts`、`agent/extensions/doc-polish/index.ts`、`agent/extensions/omomp-lang/index.ts`、`agent/thinking-translator.json` | **触发链**：`omp-ask-more` 将 `ask` 升级为带 `brief`（where/what/how、磁盘实时读取的代码 `evidence`、图表、演示）和选项 `tradeoff` 的全屏决策页（保持原生返回格式供 `turn-judge` 与 `user-prompt-inject` 读取，无 TUI 时回退原生 `ask`）。`input-polish` 在输入框按 `ctrl+enter` 时调 `@input-polish` 流式润色草稿；`doc-polish` 提供三阶段（Split → Polish → Check）不改原意的文档重排工具 `polish_doc`；`omp-thinking-translator` 按 `thinking-translator.json` 模型链实时流式翻译思考块；`pi-pretty-codeblocks` 优化代码块渲染；`omp-playbooks` 在 Tern 桌面端提供 YAML Playbook 协同面板；`omomp-lang` 控制面向人的 UI 语言（`zh`/`en`）。<br>**行为闭包**：除 `omomp-lang` 外均为**可选增强（Optional）**；若卸载 `omp-ask-more`，原生 `ask` 必须保持开启。 |
| **8. 供应商适配、外部能力与配置同步** | `install-plugins.sh`、`agent/extensions/commandcode-model-spec/index.ts`、`agent/extensions/antigravity-wire-profiles/index.ts`、`agent/extensions/omp-config-autoupdate/`、`docs/operations.zh-CN.md` | **触发链**：`pi-bansos` 在本地 `127.0.0.1:18080` 提供免费模型代理供 `task:free` 使用；`pi-commandcode-provider` + `commandcode-model-spec` 修复 `--model` 选 Command Code 时的 provider 绑定；`antigravity-wire-profiles` 启动时拉取 Antigravity 模型的真实 `maxOutputTokens`，避免压缩摘要因 512 token 预算被 thinking 耗尽而报错；`omp-codex-image-gen` 用 Codex 订阅调 `gpt-image-2` 生图；`pi-package-search` 搜索 npm 扩展包；默认注释的 `omp-remote-build` 提供远端 Docker + Mutagen 构建环境。`omp-config-autoupdate`、`/update-omp`、`/sync-omp-config` 与 `omp-light` 管理配置生命周期。<br>**行为闭包**：供应商与工作流扩展属于**条件必选（Conditional）或可选工作流（Optional）**。 |

### 面向后续可选安装器的原子行为闭包总表（Bundle Closure Matrix）

未来的可选安装器（selective installer）必须按**原子行为闭包（Bundle）**而非单个文件开关裁剪。引导用户决定“启用哪些行为”时，以此表为准：

| 闭包 ID | 必要性层级 | 包含的全部构件（配置键 / 提示词 / 子代理 / 扩展 / 插件） | 替换与依赖关系（`replaces` / `requires` / 拆卸后果） | `omp-light` 状态 |
|---|---|---|---|---|
| `engine-baseline` | **必选基底（Core）** | `config.yml`：`edit.mode: hashline`、`readLineNumbers: true`、`github.enabled: true`、`astGrep.enabled: true`、`fetch.enabled: true`、`checkpoint.enabled: true`、`extendedContext: true`、`inlineToolDescriptors: "on"`、`tools.xdevDocs: inline`、`eval.tools.enabled: false`、`textVerbosity: high`、`expandThinkingBlocks: true` | 关闭 `hashline` 或 `inlineToolDescriptors` 会使 `tool-topics` 与 `TOPIC-edit-hashline-*` 失效 | 启用 |
| `prompt-topics` | **必选基底（Core）** | `SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`tool-topics`（`SURFACE-*` / `TOPIC-*`）、`tool-topic-injection`（`omomp.yml#tool-topic-injection`）、`repo-rules` | `requires: engine-baseline`；拆分会导致工具说明缺失或规则无法按路径触发 | 启用 |
| `todo-continuity` | **必选基底（Core）** | `config.yml#todo.enabled: false`、插件 `omp-todo-more`（`todo`、`ctx`、`Task log`、compact 后注入）、`system-prompt-replace`（删除子代理禁止 Todo 的句子）、`task-completion-judge`（读取 `omp-todo-more:read`） | `replaces: 原生 todo`；若不装 `omp-todo-more` 必须同时恢复 `todo.enabled: true` 并移除子代理 Todo 要求与 `omp-todo-more:read` 检查，否则会话完全丧失 Todo 能力 | 插件启用（`system-prompt-replace` 跳过） |
| `pty-routing` | **必选基底（Core）** | `config.yml#launch.enabled: false`、`config.yml#bashInterceptor`、插件 `omp-unified-exec`（`exec_command` 等 6 个 `xd://` 设备）、`tool-topics` 的 `TOPIC-exec_command-*.md` | `replaces: 原生 launch 服务模式`；若不装 `omp-unified-exec` 必须恢复 `launch.enabled: true` 并移除 `TOPIC-exec_command-*`，否则长生命周期命令无处执行 | 启用 |
| `safe-deletion` | **必选基底（Core）** | 扩展 `delete-guard`（拦截 `bash`/`eval` 删除与非字面命令，注册字面路径 `delete` 工具）、`TOPIC-bash-policy.md` | 独立安全闭包；移除后模型可在 `bash`/`eval` 中直接执行不可逆 `rm -rf` | 启用 |
| `compaction-baseline` | **必选基底（Core）** | `config.yml#compaction`（`methodOrder: [remote, soft, snapcompact, handoff, shake]`、`asyncEnabled: false`、`thresholdTokens`）、`model-compaction`（本机 `omomp.yml#model-compaction`）、`session-urls`（`session://`） | 与 `omp-todo-more` 的 compact 后恢复协同保护长程约束 | 启用 |
| `workspace-lifecycle` | **必选基底（Core）** | `wt-tool`（`wt`、`wt_remove`）、`harness-restart`（`harness_restart`）、`omp-config-autoupdate`、`omomp-lang`、`omp-light.ts` | 提供工作树隔离切换、自举重启、界面语言与更新器入口 | 启用 |
| `advisor-governance` | **长程治理包（Full-mode Pack，可整体选装）** | `APPEND_SYSTEM.md` 顾问规则、`agent/agents/{discuss-steady,discuss-divergent,mentor-default}.md`、`config.yml#task.agentModelOverrides` 顾问绑定、`user-prompt-inject`、`PROMPT-INJECT-user-goal.md` | 必须成组启用或成组移除：仅留 `APPEND_SYSTEM.md` 而缺顾问定义/模型绑定会导致主会话调用不存在的角色；仅卸 `user-prompt-inject` 会使顾问丧失用户原话与 `ask` 决策上下文 | 整体跳过（用空 `APPEND_SYSTEM_LIGHT.md`） |
| `subagent-gates` | **长程治理包（Full-mode Pack，可整体选装）** | `config.yml#task.disabledAgents`（禁用 `task, scout, sonic, reviewer, security-reviewer`）、`agent/agents/task-{high,mid,low,free}.md`、`fork-task`（含 `fork:self`）、`isolation-nudge`、`task-split-check`、`task-completion-judge` | `replaces: 内置人设子代理`；`requires: todo-continuity`（`task-completion-judge` 依赖 `omp-todo-more`） | 跳过 `fork-task` 与三个检查扩展 |
| `drift-monitors` | **长程治理包（Full-mode Pack，可整体选装）** | `tool-policy-nag`（`omomp.yml#tool-policy-nag` + `INTENT-policy.md`）、`turn-judge`（`TURN-JUDGE-gpt-talk-only.md`）、`lang-nag`（`omomp.yml#lang-nag`）、`watchdog-agent`（本机 `WATCHDOG-*.md`） | `tool-policy-nag` 在默认 `detector: heuristic` 下将运行期 `bashInterceptor.enabled` 设为 `false`；关闭 `tool-policy-nag` 后 `bashInterceptor` 恢复硬拦截 | 整体跳过 |
| `provider-adapters` | **条件必选（Conditional）** | `pi-bansos`（配 `~/.pi/agent/pi-bansos-relay-state.json`，供 `task:free` 首选链使用）、`pi-commandcode-provider` + `commandcode-model-spec`（配本机 `commandcode-models.json`）、`antigravity-wire-profiles` | 按用户实际使用的 provider 条件启用：不用 `bansos` 时需改绑 `task:free`；不用 `commandcode` 或 `google-antigravity` 时对应组件空转无害，可选安装器可省略 | 启用 |
| `ui-workflow-extras` | **可选增强（Optional）** | 插件 `omp-ask-more`（`requires: 原生 ask 保持开启`）、`omp-thinking-translator`（配 `thinking-translator.json` + 本机 `models.yml` `supportsReasoningEffort`）、`pi-pretty-codeblocks`、`omp-playbooks`（仅 `TERN_PANE` 内激活）、`omp-codex-image-gen`、`pi-package-search`、`omp-remote-build`（默认注释，`requires: omp-unified-exec`）；扩展 `input-polish`、`doc-polish`（本机 `omomp.yml#doc-polish`）、`append-system-model`（本机 `APPEND_SYSTEM_MODEL.md`）、`child-memory-warning`（仅 macOS） | 均可按个人工作流独立选装或省略，不影响长程任务正确性基底 | 除 `doc-polish` 跳过外其余启用 |

---

## 阶段 2：可定制项分类、定制思路与当场定制（仅写本机项）

向用户展示以下三类定制划分（这也是后续可选安装器的配置分类基准），并通过 `ask` 收集用户的当场定制决定：

### 1. 需要当场定制并写入本机的配置（本机所有，更新器永不覆盖）

| 定制项 | 本机写入位置 | 定制思路（为什么需要根据用户环境决定） |
|---|---|---|
| **通用与扩展模型角色（`modelRoles`）** | `<agentDir>/config.yml#modelRoles`（属于 `LOCAL_CONFIG_FIELDS`） | 决定主模型与各扩展的调用链：`default`、`smol`（`input-polish`/`task-split-check`/`task-completion-judge` 的默认回退）、`slow`、`plan`、`judge`（`openJudge` 主链）、`tiny`（`judge` 回退链），以及可选的专用角色 `@input-polish`、`@task-split-check`、`@task-completion-judge`、`@doc-polish.split`、`@doc-polish.polish`、`@doc-polish.check`。必须绑定到用户本机已有凭据的 provider/model。 |
| **按模型匹配的长上下文压缩阈值（`model-compaction`）** | `<agentDir>/omomp.yml#model-compaction`（属于 `LOCAL_OMOMP_SECTIONS`） | 不同模型的有效上下文窗口与计费阶梯不同（例如 Claude Opus 适合在 `150000`–`180000` 压缩，而支持大窗口的 GPT/Gemini 模型可设到 `500000`–`650000`）。用正则按 `provider`/`model` 精细设定 `thresholdTokens`。 |
| **文档润色本机配置（`doc-polish`）** | `<agentDir>/omomp.yml#doc-polish`（属于 `LOCAL_OMOMP_SECTIONS`） | 若用户需要使用 `/polish-doc` 或 `polish_doc` 工具，需配置 `fallbackRole`（如 `default` 或 `smol`）与 `concurrency`（如 `6` 或 `8`）；不使用则跳过不创建。 |
| **启动自动更新开关（`omp-config-autoupdate`）** | `<agentDir>/omomp.yml#omp-config-autoupdate`（属于 `LOCAL_OMOMP_SECTIONS`） | 保持仓库工作树干净时，可开启 `enabled: true` 让 OMP 每次启动自动跟随 GitHub `main` 更新配置与插件；若后续打算自行修改工作树则保持 `false`。 |
| **本机扩展加载项与界面偏好** | `<agentDir>/config.yml` 的 `extensions` 前置项及 `LOCAL_CONFIG_FIELDS` | 若本机使用 `~/.claude`，需在 `<agentDir>/config.yml` 的 `extensions` 列表最前面保留 `~/.claude`；另可按需设置 `defaultThinkingLevel`、`theme`、`terminal`、`tui`、`statusLine`、`worktree`。 |
| **模型特定提示词与周期审阅（可选初始化）** | `<agentDir>/extensions/append-system-model/APPEND_SYSTEM_MODEL.md`、`<agentDir>/extensions/watchdog-agent/WATCHDOG-*.md` | 仅当用户对特定模型有专属附加指令，或需要开启后台步数审阅时才在本机创建；默认无需创建。 |
| **供应商模型兼容项（`models.yml`）** | `<agentDir>/models.yml`（本机运行时配置） | 若用户使用 `futureppo-pool` 等需要显式开启 `supportsReasoningEffort: true` 的 provider（供 `omp-thinking-translator` 等使用），写入本机 `models.yml`。 |

### 2. 当场诊断但默认不改工作树的仓库配置（仓库所有）

对以下仓库受管项，AI **当场对比用户本机实际可用的 provider 与语言偏好，输出诊断结论与可复制的配置片段**，但默认不改仓库文件（避免污染 git 工作树或被自动更新冲掉）：

- **子代理模型绑定（`agent/config.yml#task.agentModelOverrides`）**：
  - 仓库默认将 `task:high` / `discuss:divergent` 绑到 `anthropic/claude-opus-5-5`，将 `task:mid` / `discuss:steady` / `mentor:default` 绑到 `openai-codex/gpt-*-sol`，将 `task:low` 及回退链绑到 `openai-codex/gpt-*-luna`，将 `task:free` 绑到 `bansos` / `opencode-go` / `openai-codex`。
  - **诊断要求**：逐个检查这 7 个子代理绑定的模型在本机是否有可用凭据。若有缺失，向用户列出受影响的子代理及用本机现有 provider 替换的 YAML 片段，说明：若要在全局长期改绑，需在个人 fork/工作树修改 `agent/config.yml` 并保持上游自动更新关闭；若只想在单个项目覆盖扩展配置，可使用项目 `.omp/` 配置。
- **界面与监督语言（`agent/omomp.yml` 的 `omomp-lang`、`lang-nag`、`input-polish.instruction`、`tool-policy-nag.form.prompt`）**：
  - 仓库默认设为中文（`language: zh`、`lang-nag: 说中文`）。
  - **诊断要求**：若用户偏好英文或其他语言，说明界面语言可通过环境变量 `OMOMP_LANG=en` 无侵入覆盖，而 `lang-nag`、`input-polish`、`tool-policy-nag` 支持在具体项目的 `<cwd>/.omp/omomp.yml` 中按项目覆盖（项目 `.omp/omomp.*` 优先于 `<agentDir>/omomp.*`）。
- **思考翻译模型链（`agent/thinking-translator.json`）**：
  - 检查本机是否具备 `futureppo-pool` 或 `commandcode` 凭据；若均无，提示用户可通过 `/thinking-translator` 命令关闭或了解如何在个人分支调整模型链。
- **可选与条件插件（`install-plugins.sh`）**：
  - 诊断本机是否具备 `omp-playbooks`（`PATH` 上是否有 `tern`）、`omp-codex-image-gen`（是否有 Codex 订阅）、`omp-remote-build`（默认注释；是否需要 Mutagen + `km` + 远端构建机）的运行前提，并记录用户的可选偏好。

### 3. 建议延后定制的参数（默认保留仓库值，有实测体感后再调）

向用户明确说明以下参数**不建议在首次安装时凭直觉修改**，应保持仓库经过校准的默认值：
- `tool-policy-nag` 的 `afterHits: 3`、`maxNags: 3`、`intent.threshold: 0.5` 与 `risk` 阈值（启发式高误报率是有意设计，只消耗少量自检 thinking token，不会阻断命令）。
- `TURN-JUDGE-gpt-talk-only.md` 的 `threshold: 0.8`（基于真实 GPT 会话样本校准为 0 误报）。
- `compaction.methodOrder`（`remote → soft → snapcompact → handoff → shake`）与 `compaction.asyncEnabled: false`。
- `child-memory-warning.thresholdGiB: 4`、`tool-topic-injection.rules`、`system-prompt-replace.replacements`。

---

## 阶段 3：执行安装与写入本机定制

当用户在 `ask` 中确认安装与本机定制方案后，初始化 `todo` 并按顺序执行（当传入参数为 `check` 时跳过本阶段写入，仅跑 `--check` 与 `./plugin-audit.sh`）：

1. **执行仓库 → 本机更新器**：
   - 在仓库根目录运行：`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source .`（命名 profile 加 `--agent-dir <omp config path 输出>`）。
   - 若脚本报告 ` errors` 或 `Cutover incomplete; do not restart OMP`，立即停止后续步骤，协助排查修复后重跑。
2. **执行插件审计**：
   - 运行 `./plugin-audit.sh`。若出现 `[卸载候选]`，用 `ask` 询问用户是否执行 `omp plugin uninstall <name>`。
3. **写入用户在阶段 2 确认的本机所有项**：
   - 对 `<agentDir>/config.yml` 中的本机字段（如 `modelRoles`、`defaultThinkingLevel`、`extensions` 中的 `~/.claude` 等），使用 `omp config set` 或在读取 `<agentDir>/config.yml` 后用 `edit` 精确修改对应本机键。
   - 对 `<agentDir>/omomp.yml` 中的本机段（`model-compaction`、`doc-polish`、`omp-config-autoupdate`），先 `read` `<agentDir>/omomp.yml`，再用 `edit` 写入或更新对应本机段，严禁触碰仓库管理段。
   - 若用户确认创建 `<agentDir>/models.yml` 兼容项（如 `futureppo-pool` 的 `supportsReasoningEffort: true`）或 `<agentDir>/commandcode-models.json`：若 `<agentDir>/models.yml` 已存在，严禁整文件重写或读取/回显含 `apiKey` 的行，只做最小字段追加或给出 YAML 片段由用户合入，保留文件中所有既有 provider 与未知字段。
4. **校验落盘状态与工作树干净度**：
   - 用 `Bun.YAML.parse` / `JSON.parse` 校验修改过的 `<agentDir>/config.yml`、`<agentDir>/omomp.yml`（不打印 `models.yml` 凭据内容）。
   - 运行 `omp config list --scope global --json`、`omp plugin list --json` 与 `git status --short`，确认本机配置已生效且仓库工作树未被意外污染。

---

## 阶段 4：激活边界说明与最终交付报告

安装与本机定制完成后，向用户输出结构化的最终报告（严格区分**已落盘**、**当前会话已生效**与**需重启后生效**）：

1. **本机已安装与已定制项**：
   - 更新器写入的文件、已安装/升级的插件、`omp-light` 安装位置。
   - 已写入 `<agentDir>` 的本机所有项（`modelRoles`、`model-compaction`、`doc-polish`、`omp-config-autoupdate` 等）及其当前实际值。
2. **仓库所有项的兼容性诊断与定制备忘**：
   - `task.agentModelOverrides` 各子代理档位在本机凭据下的可用状态，以及未改动工作树的替换参考片段（如有不可用项）。
   - 语言与思考翻译链在本机的可用状态与项目级 `.omp/omomp.yml` / 环境变量覆盖方式。
3. **全量安装与日常模式选择（面向后续可选安装器的映射）**：
   - 汇总用户在本轮表达的可选组件偏好（哪些属于必选基底、哪些属于条件启用、哪些当前虽随全量更新器安装但未激活或可在轻量模式跳过）。
   - 说明日常如何选择入口：复杂多步工程任务运行 `omp`（完整模式，含全部子代理治理与偏离纠偏）；简单问答或小改动运行 `omp-light`（轻量模式，跳过 10 个治理扩展与 `system-prompt-replace`）。
4. **生效时机与重启提示**：
   - **当前会话已热重载生效**：`<agentDir>/config.yml` 中的设置（如 `modelRoles`）、从下一条 prompt/调用起按需重读的 `APPEND_SYSTEM_MODEL.md`、`WATCHDOG-*.md`、`TURN-JUDGE-*.md`。
   - **必须重启 `omp` 后才加载生效**：`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、新安装或更新的本地扩展与外部插件、`tool-topics`（`SURFACE-*` / `TOPIC-*`）、`omomp-lang` 界面语言。若當前会话有 `harness_restart` 工具且用户希望立即重启恢复会话，可提示或调用 `harness_restart`；否则提醒用户手动退出并重新启动 `omp`。
