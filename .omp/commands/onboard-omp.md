---
description: 渐进式引导理解 omp-config 的长程任务正确性设计、当场调查运行时控制面并完成本机定制与安装
argument-hint: "[check|<plane>]"
---

以渐进式交互引导用户理解 `omp` 与 `omp-config` 的设计取舍、当场调查各运行时控制面的真实配置与内置文档、划分必选基底与可选/可定制行为闭包，并在保持仓库工作树干净的前提下完成本机配置定制与安装。不使用 subagent，在主会话中直接执行。

## 核心定位与执行守则

1. **为什么需要一次引导**：
   - 与 `omp` 相比，Claude Code 和 Codex CLI 接近最小工具循环（毛坯房）；但 `omp` 原生默认状态关闭或未配置大量关键能力（`github`、`astGrep`、`checkpoint`、`extendedContext`、`inlineToolDescriptors`、`readLineNumbers` 等）。
   - `omp-config` 不仅打开这些原生底座，而且**围绕长程任务的正确性（而非节省 token）构建运行时控制层**——这与主流 harness 提倡“尽早压缩上下文、用 grep/sed 跳过上下文读取、限制子代理汇报字数以省 token”的做法相反。
   - 本命令只需由 AI 带着用户跑一次：不预先堆砌静态说明书，而是按控制面**当场调查** `omp://` 内置文档、`tool://` 专题与本仓库配置，只向用户呈现**运行时如何控制 AI（触发信号 → 拦截/注入/裁决 → 模型可观测行为）**，不讲内部 TypeScript 代码实现细节。
2. **冷启动安全与工具纪律（自举约束）**：
   - 本命令可能在尚未安装 `omp-config` 的原生 `omp` 中运行：不得假定 `omp-ask-more`、`omp-unified-exec`（`exec_command`）、`tool-topics`（`tool://`）、`session-urls`（`session://`）、`wt-tool` 或 `harness-restart` 已加载。
   - 在核对并完成模型角色绑定前，不得调用任何依赖特定模型角色或作者订阅的扩展工具（如 `polish_doc`、`task`、`fork_task`）。
   - **文件与目录检查必须使用 `read`、`glob`、`grep` 工具**：严禁在 `bash` 中运行 `ls`、`cat`、`head`、`tail`、`find`、`grep` 或用 `python3 -c` 解析本地文件（会直接触发 `tool-policy-nag`）。`bash` 仅用于执行 `omp` CLI、`bun` 更新器脚本、`./plugin-audit.sh` 与 `git status`。
   - **阶段 0–3 中的调查、讲解与诊断（及 `check` 模式）属于非工作阶段，严禁初始化 `todo`**：只有用户在 `ask` 中明确确认要写入本机配置文件（如阶段 1 写入 `<agentDir>/models.yml` 中转站配置，或进入阶段 4 执行安装与本机定制）时，才初始化 `todo`。冷启动时会话里的 `todo` 是原生工具：阶段 4 的更新器把 `todo.enabled: false` 写进 `<agentDir>/config.yml` 后 OMP 热重载设置，原生 `todo` 立即从本会话消失，替代它的 `omp-todo-more` 要重启 `omp` 才加载；因此阶段 4 的 `todo` 只列更新器运行之前的步骤，并在运行更新器之前全部完成。
   - 每完成一个阶段的现场调查，必须使用 `ask` 工具（原生或 `omp-ask-more`）让用户选择下一步深挖的控制面、确认本机定制项或决定是否执行安装；严禁一次性倾倒全部扩展与插件的细节。
3. **所有权红线（只改本机副本，默认不改仓库工作树）**：
   - 任何写入前，先用 `read` 从 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 读取文件头的 OWNERSHIP 与 CUSTOMIZATIONS 说明，以及 `LOCAL_CONFIG_FIELDS`、`SEED_CONFIG_FIELDS`、`LOCAL_OMOMP_SECTIONS`、`SEED_OMOMP_FIELDS`、`SEED_TRANSLATOR_FIELDS`、`MACHINE_LIST_FIELDS`、`STRUCTURED` 与 `managedPlain`。
   - **本机所有项**（`<agentDir>/config.yml` 的 `LOCAL_CONFIG_FIELDS` 与 `extensions` 本机前置项、`<agentDir>/omomp.yml` 的 `LOCAL_OMOMP_SECTIONS`、首次安装后已归本机的播种路径 `SEED_*`（如 `task.agentModelOverrides`、`omomp-lang`、`lang-nag`、`thinking-translator.json` 的 `translatorModels`）、`<agentDir>/models.yml`、`<agentDir>/commandcode-models.json`、`APPEND_SYSTEM_MODEL.md`、`WATCHDOG-*.md`）：在用户确认后直接写入本机 `<agentDir>`（由 `omp config path` 或 `PI_CODING_AGENT_DIR` / `~/.omp/agent` 决定），更新器与启动自动更新不会覆盖它们。
   - **受管但可在本机定制的项**（`agent/config.yml` 与 `agent/omomp.yml` 中其余仓库键、`agent/agents/*.md`、系统提示词文件、仓库自带的 `PROMPT-INJECT-*.md` / `TURN-JUDGE-*.md` / `INTENT-*.md`）：在用户确认后可以直接改本机副本。更新器按记录的基准三方合并，保留本机修改；上游同处也改了时报告冲突，由 `/omp-config-autoupdate adapt`（或 `/update-omp` 当场）逐项适配。仓库工作树默认不改，可安全开启 `/omp-config-autoupdate on`。
   - **代码与插件列表**（`agent/extensions/**/*.ts`、`omp-light.ts`、`install-plugins.sh`）：以仓库为准，本机改动会在下次更新时被覆盖（报告列入 `overwritten`）。只有用户明确要求维护个人分支/fork 时才编辑工作树，并提醒关闭上游自动更新。
4. **当前全量安装与可选划分的诚实边界**：
   - 当前更新器 `omp-config-update.ts` 对仓库受管文件与 `install-plugins.sh` 未注释插件执行**全量安装**；日常轻量会话通过 `omp-light` 在进程启动时跳过 `agent/config-light.yml` 的 `disabledExtensions` 列出的长程监督/子代理治理扩展与 `system-prompt-replace`。
   - 引导中对“必选基底 / 条件必选 / 可选增强”的划分，一方面帮用户决定当前启用哪些本机开关、使用 `omp` 还是 `omp-light`，另一方面作为后续可选安装器（selective installer）的行为闭包规格；不得向用户谎称当前更新器会按勾选跳过文件写入。

当前传入参数：`$ARGUMENTS`
- 参数为空：按阶段 0 → 阶段 5 渐进执行完整引导、提供商扩充、本机定制与安装。
- 参数为 `check`：只读诊断模式（非工作阶段，不建 `todo`、不调 `ask`、不修改任何本机或仓库文件）。依次执行阶段 0 现场盘点、`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source . --check` 与 `./plugin-audit.sh`，直接输出完整的《本机兼容性与原子行为闭包诊断报告》并结束。
- 参数为 `<plane>`（控制面编号或关键词）：执行阶段 0 盘点后直接跳转至阶段 2 指定控制面的深度现场调查与定制。
---

## 阶段 0：现场盘点（只读调查，不改文件、不建 `todo`）

在向用户提问前，用 `read`/`glob`/`grep` 与必要的 `omp` CLI 并行建立当前机器与仓库的基线事实：

1. **本机环境与已安装状态**：
   - 在 `bash` 中运行 `omp config path`、`omp config list --scope global --json`、`omp plugin list --json`；用 `glob` 检查 `<agentDir>/*`、`~/.pi/agent/*` 与 `~/.claude/*` 是否存在，用 `read` 读取 `<agentDir>/omomp.yml`（若存在）。
   - 检查本机已配置凭据的 provider（通过 `omp models` 或 `omp config list --scope global --json`；**严禁直接 `read` `<agentDir>/models.yml` 全文以免暴露其中的 `apiKey:` 字段**，如需检查 `supportsReasoningEffort` 仅对该词执行 `grep`；严禁打印或解密任何凭据原文、严禁触碰 macOS Keychain）。
2. **OMP 原生默认与 `agent/config.yml` 差分**：
   - 读取 `agent/config.yml`、`agent/config-light.yml`、`agent/omomp.yml`、`install-plugins.sh`，并对照 `omp://settings.md`、`omp://compaction.md`、`omp://tools/edit.md`。
   - 提炼出两组核心对比：
     - **原生默认关闭或未配、`omp-config` 显式打开的底座**：`github.enabled: true`、`astGrep.enabled: true`、`fetch.enabled: true`、`checkpoint.enabled: true`、`extendedContext: true`、`inlineToolDescriptors: "on"`、`tools.xdevDocs: inline`、`readLineNumbers: true`、`textVerbosity: high`、`expandThinkingBlocks: true`、`task.eager: preferred`、`task.isolation: { enabled: true, merge: branch }`、`task.maxConcurrency: 64`；`edit.mode: hashline` 已是原生默认，仓库显式写入以固定它。
     - **原生默认开启、`omp-config` 显式关闭并替换的机制**：`todo.enabled: false`（由 `omp-todo-more` 替换）、`launch.enabled: false`（由 `omp-unified-exec` 的 `exec_command` 替换）、`eval.tools.enabled: false`、`compaction.asyncEnabled: false`（关闭提前 32k token 的后台有损预摘要）、`task.disabledAgents: [task, scout, sonic, reviewer, security-reviewer]`（禁用内置人设子代理，改用无状态 `task:high/mid/low/free` 加受边界约束的顾问 `discuss:steady`、`discuss:divergent`、`mentor:default`）。
3. **本机与仓库配置的冲突预检**：
   - 对照 `agent/config.yml#task.agentModelOverrides`（`anthropic`、`openai-codex`、`bansos`、`opencode-go`）与 `agent/thinking-translator.json`（`futureppo-pool`、`commandcode`），找出当前机器缺少凭据或未配置 `models.yml` 兼容项的模型引用。

完成盘点后，先向用户展示简明的**基线诊断摘要**（当前机器已激活的 provider 与模型数量、原生 OMP vs `omp-config` 的长程正确性设计反转、检测到的模型/语言待适配项），立即进入**阶段 1**，用 `ask` 询问用户是否需要先多配置几个 AI 提供商（内置 `/login` 渠道、`pi-package` 补充包或第三方中转站接入）。

---

## 阶段 1：扩充 AI 提供商与中转站接入（在进入控制面与角色绑定前优先询问）

`omp-config` 的子代理分档（`task:high/mid/low/free`）、独立顾问（`discuss:steady/divergent`、`mentor:default`）、判定与润色角色（`judge`、`tiny`、`smol`）以及思考翻译均建立在**跨模型特性互补与多订阅分摊成本**之上。在阶段 0 盘点后，先通过 `ask` 询问用户是否需要扩充 AI 提供商，并按用户选择提供以下现场协助（用户选择跳过则直接进入阶段 2）：

1. **确认并接入内置 `/login` 与环境变量支持的提供商（当场读取 `omp://providers.md`）**：
   - 对照阶段 0 盘点出的本机已有 provider，从 `omp://providers.md` 中为用户分类梳理尚未配置但常用的内置渠道，帮用户确认有哪些是他想启用的：
     - **OAuth / 订阅直连（通过 `/login <provider>` 或终端 `omp login <provider>` 登录；`anthropic` 与 `openai-codex` 支持同一邮箱下的个人订阅与 Team/Enterprise 席位分别登录并自动轮转额度）**：`anthropic`（Claude）、`openai-codex`（ChatGPT Codex）、`google-antigravity`、`google-gemini-cli`、`github-copilot`、`cursor`、`factory-droid`、`cline-pass`、`qwen-portal`、`kimi-code`、`xai-oauth`、`ollama-cloud`、`gitlab-duo` / `gitlab-duo-agent`、`snowflake`、`devin`、`muse-code`、`wafer-serverless`。
     - **API Key / Coding Plan / 原生判定网关（支持 `/login <provider>` 交互存库，或在 `~/.omp/agent/.env` / `<cwd>/.env` / 环境变量中设置对应 `*_API_KEY`）**：`openrouter`、`opencode-go` / `opencode-zen`、`deepseek`、`siliconflow` / `siliconflow-cn`、`zai` / `zhipu-coding-plan`、`minimax-code` / `minimax-code-cn` / `minimax`、`alibaba-coding-plan` / `alibaba-token-plan`、`moonshot`、`stepfun`、`xiaomi` / `xiaomi-token-plan-{cn,sgp,ams}`、`groq`、`cerebras`、`fireworks`、`together`、`baseten`、`coreweave`、`singularityapi-dev` / `singularityapi-tech`、`charm-hyper`、`inception`（Mercury 3）、`cloudflare-ai-gateway`，以及提供原生 `judge` 判定模型的 `typesafe`（Jev）与 `cloudflare-workers-ai`（Clef）。
     - **本地免密推理引擎**：`ollama`（`127.0.0.1:11434`）、`lm-studio`（`127.0.0.1:1234/v1`）、`llama.cpp`（`127.0.0.1:8080`）、macOS arm64 原生 `apple`（`apple/on-device`）。
   - **协助方式**：告知用户对应的 `/login <provider>`（或在另一终端运行 `omp login <provider>`）命令，或引导其将环境变量写入 `~/.omp/agent/.env`（**严禁让用户在对话中直接粘贴明文 API Key 或 Token**）；完成后运行 `omp models find <provider>` 确认模型已解锁。
2. **检索并安装补充的 `pi-package` 提供商扩展包**：
   - 先说明本仓库 `install-plugins.sh` 已内置的提供商插件：`pi-bansos`（在 `127.0.0.1:18080` 提供免费模型代理供 `task:free` 使用，配 `/bansos` 命令）和 `pi-commandcode-provider`（接入 `commandcode` API 与 `/login commandcode`、`/commandcode-quota`，配合本地扩展 `commandcode-model-spec`）。
   - 若用户想寻找其他第三方平台或社区封装的 provider 扩展包：
     - 若当前会话已加载 `search_pi_packages`（写 `xd://search_pi_packages`），按关键词（如 `provider`、`auth`、`relay` 或目标厂商名）搜索 npm 上的 `pi-package`；若冷启动尚未安装该插件，可在 `bash` 中运行 `npm search keywords:pi-package <关键词>`（或先运行 `omp install pi-package-search`）检索。
     - 向用户列出候选包名、用途与安装命令；经用户在 `ask` 中明确选中确认后，运行 `omp install <package-name>`（或写 `xd://install_pi_package`）完成安装。
3. **协助接入自定义中转站 / 聚合网关 / 反向代理（写入本机 `<agentDir>/models.yml`）**：
   - 当场读取 `omp://models.md` 与 `omp://providers.md#custom-providers-in-modelsyml`，询问用户是否有第三方中转站（如 NewAPI / OneAPI / LiteLLM / OpenAI 或 Anthropic 兼容反代 / 标准按量 BigModel `https://open.bigmodel.cn/api/paas/v4` / 自建 System One `typesafe` 判定网关等）需要接入。
   - 若用户需要接入中转站，通过 `ask` 收集以下非敏感配置项（**严禁让用户在对话中粘贴明文 API Key**）：
     - 自定义 `<provider-id>` 名称与 `baseUrl`（例如 `https://api.example.com/v1`）；
     - 协议类型 `api`（`openai-completions`、`openai-responses`、`openai-codex-responses`、`anthropic-messages`、`google-generative-ai`，或判定协议 `typesafe` / `openrouter-decisions` / `openai-decisions`）；
     - 凭据引用方式：约定一个环境变量名（如 `MY_RELAY_API_KEY`，由用户写入 `~/.omp/agent/.env` 或 shell 环境）或 `!command` 动态取密命令（如 `!op read ...`），在 `models.yml` 的 `apiKey:` 字段只写该环境变量名或 `!command`（OMP 会自动解析同名非空环境变量，且 `models.yml` 的 `apiKey` 优先级高于已存 OAuth，避免将官方 OAuth token 误发给中转站）；
     - 模型声明与兼容项：选择动态发现（`discovery: { type: proxy }`、`openai-models-list` 或 `litellm`；非 `/v1` 根路径加 `injectV1: false`）还是静态声明 `models: [{ id, name, contextWindow, maxTokens }]`，并按需加上 `authHeader: true`、`disableStrictTools: true`（针对拒绝 `strict` 字段的 Anthropic 兼容中转）或 `modelOverrides.<id>.compat.supportsReasoningEffort: true`。
   - **安全写入与验证**：`<agentDir>/models.yml` 属于本机所有文件（更新器与自动更新永不覆盖，`/sync-omp-config` 永不收回仓库）。在用户确认后（此时先初始化 `todo`），在不读取/不回显既有 `apiKey` 行的前提下将新 provider 块追加写入 `<agentDir>/models.yml`，再用 `Bun.YAML.parse` 语法校验并运行 `omp models find <provider-id>` 验证中转站模型已正常加载。

完成提供商扩充（或用户确认跳过）后，用 `ask` 询问用户：希望按推荐顺序渐进了解各运行时控制面，还是只看关心的控制面，或直接进入本机定制与安装？

---

## 阶段 2：运行时控制面的渐进式现场调查
按用户在 `ask` 中选择的路径推进（建议每次 2–3 个相关控制面，每轮末尾用 `ask` 确认是否展开细节或进入下一组）。对每个控制面，AI **当场读取表中列出的权威源**，按统一结构向用户讲解：
- **运行时控制链**：`什么信号触发 → 哪个钩子/工具/判定器介入 → 拦截、改写还是注入什么消息 → AI 在当前回合/下一回合/压缩后表现出什么行为`；
- **为何这样设计（长程正确性 vs 省 token）**；
- **行为闭包（哪些组件耦合在一起，不能单拆）**。

| 控制面 | 现场调查入口（按需读取，勿背诵） | 核心运行时控制机制与行为闭包 |
|---|---|---|
| **1. 原生引擎底座与文件读写纪律** | `agent/config.yml`、`omp://tools/edit.md`、`omp://tools/eval.md`、`agent/extensions/tool-topics/TOPIC-edit-hashline-*.md` | **触发链**：编辑文件前必须先经非 `:raw` `read` 拿到 `[PATH#TAG]` 快照锚点才允许 `edit`（`edit.mode: hashline`）；`eval` 工具说明与 `bashInterceptor` 禁止在 Python/JS 或 shell 中用 `cat`/`grep`/`sed -i`/`open()` 盲搜盲改本地文件。<br>**设计取舍**：长程任务中多读几十行邻近上下文的 token 成本极低，而在无编译保护的脚本/配置中脱离上下文盲改会直接造成破坏。属于**必选基底**。 |
| **2. 提示词分层与按需知识注入** | `agent/SYSTEM_TEMPLATE.md`、`agent/PERSONALITY.md`、`agent/APPEND_SYSTEM.md`、`agent/omomp.yml#system-prompt-replace`、`agent/extensions/tool-topics/`、`agent/extensions/repo-rules/index.ts`、`omp://system-prompt-customization.md` | **触发链**：`SYSTEM_TEMPLATE.md` 剔除重复工具说明；`tool-topics` 在每次 `before_agent_start` 把工具说明压成表层说明加 `Topics` 索引，写操作前由模型按需读 `tool://<tool>/<topic>`，只读调用（`read`/`grep` 及误用的 `ssh cat`）后由 `tool-topic-injection` 在 `tool_result` 注入对应专题（同一活动分支只注入一次）；`repo-rules` 扫描 `.claude/rules`、`.pi/rules` 并把带 `paths` 的规则推迟到触及匹配文件时才通过 `additionalContext` 注入；`system-prompt-replace` 在最后统一修正冲突措辞。<br>**行为闭包**：`SYSTEM_TEMPLATE.md` + `tool-topics` + `tool-topic-injection` + `repo-rules` 构成**必选基底（`prompt-topics`）**；`APPEND_SYSTEM.md` 与 `system-prompt-replace` 随完整模式开启（`omp-light` 跳过）。 |
| **3. 长程状态、Todo 检查点与压缩恢复** | `docs/plugins-and-modes.zh-CN.md#todo-more`、`docs/prompts-and-context.zh-CN.md#上下文与压缩`、`agent/extensions/model-compaction/index.ts`、`agent/extensions/fork-task/index.ts`、`agent/extensions/session-urls/index.ts`、`omp://compaction.md` | **触发链**：工作阶段（会改动文件/配置/git/外部状态）未初始化 Todo 时，`omp-todo-more` 在 `tool_call` 拦截 `edit`；有未提交改动的 git 仓库中执行 `DONE` 必须附带 commit 子句，形成带 SHA 的逻辑检查点并写入 `Task log`；回合结束仍有未完成项时自动提醒继续。压缩按损耗从低到高排序（`remote → soft → snapcompact → handoff → shake`），关闭 `asyncEnabled` 提前 32k 摘要，并在主会话压缩后自动 steer 注入 `<post-compact-ctx>`（`ctx list` + `ctx show`）。子代理需要完整历史背景时由 `fork-task` 复刻当前分支请求前缀（共享缓存前缀）。<br>**行为闭包**：`config.yml#todo.enabled: false` + `omp-todo-more` + `system-prompt-replace`（删去子代理禁止 Todo 的句子）+ `task-completion-judge`（读取 `omp-todo-more:read`）构成**不可拆分的 `todo-continuity` 必选闭包**。 |
| **4. 子代理编排、顾问隔离与交付裁决** | `docs/agents.zh-CN.md`、`agent/agents/*.md`、`agent/extensions/user-prompt-inject/`、`agent/extensions/isolation-nudge/index.ts`、`agent/extensions/task-split-check/index.ts`、`agent/extensions/task-completion-judge/index.ts` | **触发链**：禁用内置人设子代理，执行侧统一用无状态 `task:high/mid/low/free`（按成本与可信度分档，跨订阅分摊）；顾问侧仅设 `discuss:steady`（只读保守审查）、`discuss:divergent`（只读发散替代方案）和 `mentor:default`（无工具计划/交付会商），并由 `user-prompt-inject` 在每次模型请求开头直接注入根会话用户原话与 `ask` 回答，防止主代理转述偏差。派发时 `isolation-nudge` 拦截 $\ge 2$ 个并发可写任务共用 cwd，`task-split-check` 拦截多主题塞同一 worker 及限制汇报字数（`report-limit`）；交付时 `task-completion-judge` 核对 Todo `goal`、验证工具调用记录与未完成项，不达标则退回。<br>**行为闭包**：`APPEND_SYSTEM.md` 顾问规则 + 顾问定义 + `user-prompt-inject` 构成**顾问治理闭包（`advisor-governance`）**；`task:*` 定义 + `fork-task` + 派发/交付检查扩展构成**子代理治理闭包（`subagent-gates`）**。两者在 `omp-light` 中整体跳过。 |
| **5. 运行时偏离纠偏与回合监督** | `agent/extensions/tool-policy-nag/`、`agent/extensions/turn-judge/`、`agent/extensions/watchdog-agent/`、`agent/extensions/lang-nag/index.ts`、`docs/extensions.zh-CN.md#基于-judge-角色的扩展` | **触发链**：前沿模型在长会话中会逐步忽略静态 system prompt。`tool-policy-nag` 将主会话在 shell/eval 中查改本地文件的违规调用当作偏离信号：默认 `detector: heuristic` 会在运行时将 `bashInterceptor.enabled` 覆写为 `false`（让命令不被硬拦而进入计数器），累计 `afterHits: 3` 次后注入伪装成用户观察的 user 角色 steer 消息（`"你为什么不遵守system prompt，反思自己以后继续。"`，利用厂商对 user 消息更高的注意力权重把模型拉回 system prompt）。同一扩展的 `pty` 通道（`omomp.yml#tool-policy-nag.pty`）在主会话和子会话中，于执行前拒绝经 `bash`/eval 发出的远程/容器透传、需要终端、常驻等待等命令，改走 `exec_command`（见第 6 项）。`turn-judge`（`TURN-JUDGE-gpt-talk-only.md`）在 GPT 主会话只说不做停下时自动发消息督促继续调工具；`watchdog-agent` 按 `WATCHDOG-*.md` 每 `every` 步后台审阅；`lang-nag` 在回复非目标语言时于下一轮用户输入前拼上 `"说中文\n\n"`。<br>**行为闭包**：构成**长程纠偏包（`drift-monitors`）**，在 `omp-light` 中整体禁用（`pty` 通道随之不运行）；注意 `tool-policy-nag`（`heuristic`）与 `bashInterceptor` 在运行时的联动覆盖关系。 |
| **6. 命令执行、安全删除与工作区控制** | `agent/extensions/delete-guard/`、`agent/extensions/wt-tool/index.ts`、`agent/extensions/harness-restart/index.ts`、`agent/extensions/child-memory-warning/index.ts`、`agent/extensions/tool-topics/TOPIC-exec_command-*.md`、`agent/extensions/tool-policy-nag/pty.ts` | **触发链**：`config.yml#launch.enabled: false` 关闭原生后台服务模式，所有长生命周期/交互式进程统一走 `omp-unified-exec` 的 `exec_command` PTY 会话；`tool-policy-nag` 的 `pty` 通道在 `exec_command` 已挂载时，于执行前拒绝 `bash`/eval 中的 passthrough（`ssh`、`docker exec`、`zsh -c` 等）、terminal（REPL、TUI、`sudo` 无 `-n`）、open-ended（`tail -f`、`sleep` 轮询、`&`）命令，并在拒绝信息里给出 heredoc / 交互 / `shell` 参数等改写方法。`delete-guard` 在 `tool_call` 解析 `bash`（含 `xd://bash`、嵌套 shell、Windows `powershell`/`cmd`）与 `eval`（Python/JS），拦截任何删除命令（`rm`/`unlink`/`rmdir`/`shred`/`find -delete`/`rmtree`/`rmSync` 等）和非字面命令，引导模型改用只收字面路径的 `delete` 工具（默认进系统回收站 `trash`；`permanent` 每次弹窗确认，无 UI 会话禁止永久删除）。`wt-tool` 与 `harness-restart` 将 `/wt`、`/move` 与进程重启排入回合空闲队列，重启后自动发恢复消息继续任务；`child-memory-warning`（仅 macOS）每 2 秒采样后代进程物理内存，超 `4 GiB` 告警。<br>**行为闭包**：`launch.enabled: false` + `omp-unified-exec` + `TOPIC-exec_command-*` + `tool-policy-nag` 的 `pty` 通道构成**PTY 执行路由必选闭包（`pty-routing`）**；`delete-guard` 构成**安全删除必选闭包（`safe-deletion`）**。 |
| **7. 人机交互、润色与展示** | `docs/plugins-and-modes.zh-CN.md`、`agent/extensions/input-polish/index.ts`、`agent/extensions/doc-polish/index.ts`、`agent/extensions/omomp-lang/index.ts`、`agent/thinking-translator.json` | **触发链**：`omp-ask-more` 将 `ask` 升级为带 `brief`（where/what/how、磁盘实时读取的代码 `evidence`、图表、演示）和选项 `tradeoff` 的全屏决策页（保持原生返回格式供 `turn-judge` 与 `user-prompt-inject` 读取，无 TUI 时回退原生 `ask`）。`input-polish` 在输入框按 `ctrl+enter` 时调 `@input-polish` 流式润色草稿；`doc-polish` 提供三阶段（Split → Polish → Check）不改原意的文档重排工具 `polish_doc`；`omp-thinking-translator` 按 `thinking-translator.json` 模型链实时流式翻译思考块；`pi-pretty-codeblocks` 优化代码块渲染；`omp-playbooks` 在 Tern 桌面端提供 YAML Playbook 协同面板；`omomp-lang` 控制面向人的 UI 语言（`zh`/`en`）。<br>**行为闭包**：除 `omomp-lang` 外均为**可选增强（Optional）**；若卸载 `omp-ask-more`，原生 `ask` 必须保持开启。 |
| **8. 供应商适配、外部能力与配置同步** | `install-plugins.sh`、`agent/extensions/commandcode-model-spec/index.ts`、`agent/extensions/antigravity-wire-profiles/index.ts`、`agent/extensions/omp-config-autoupdate/`、`docs/operations.zh-CN.md` | **触发链**：`pi-bansos` 在本地 `127.0.0.1:18080` 提供免费模型代理供 `task:free` 使用；`pi-commandcode-provider` + `commandcode-model-spec` 修复 `--model` 选 Command Code 时的 provider 绑定；`antigravity-wire-profiles` 启动时拉取 Antigravity 模型的真实 `maxOutputTokens`，避免压缩摘要因 512 token 预算被 thinking 耗尽而报错；`omp-codex-image-gen` 用 Codex 订阅调 `gpt-image-2` 生图；`pi-package-search` 搜索 npm 扩展包；默认注释的 `omp-remote-build` 提供远端 Docker + Mutagen 构建环境。`omp-config-autoupdate`、`/update-omp`、`/sync-omp-config` 与 `omp-light` 管理配置生命周期。<br>**行为闭包**：供应商与工作流扩展属于**条件必选（Conditional）或可选工作流（Optional）**。 |

### 面向后续可选安装器的原子行为闭包总表（Bundle Closure Matrix）

未来的可选安装器（selective installer）必须按**原子行为闭包（Bundle）**而非单个文件开关裁剪。引导用户决定“启用哪些行为”时，以此表为准：

| 闭包 ID | 必要性层级 | 包含的全部构件（配置键 / 提示词 / 子代理 / 扩展 / 插件） | 替换与依赖关系（`replaces` / `requires` / 拆卸后果） | `omp-light` 状态 |
|---|---|---|---|---|
| `engine-baseline` | **必选基底（Core）** | `config.yml`：`edit.mode: hashline`、`readLineNumbers: true`、`github.enabled: true`、`astGrep.enabled: true`、`fetch.enabled: true`、`checkpoint.enabled: true`、`extendedContext: true`、`inlineToolDescriptors: "on"`、`tools.xdevDocs: inline`、`eval.tools.enabled: false`、`textVerbosity: high`、`expandThinkingBlocks: true` | 关闭 `hashline` 或 `inlineToolDescriptors` 会使 `tool-topics` 与 `TOPIC-edit-hashline-*` 失效 | 启用 |
| `prompt-topics` | **必选基底（Core）** | `SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`tool-topics`（`SURFACE-*` / `TOPIC-*`）、`tool-topic-injection`（`omomp.yml#tool-topic-injection`）、`repo-rules` | `requires: engine-baseline`；拆分会导致工具说明缺失或规则无法按路径触发 | 启用 |
| `todo-continuity` | **必选基底（Core）** | `config.yml#todo.enabled: false`、插件 `omp-todo-more`（`todo`、`ctx`、`Task log`、compact 后注入）、`system-prompt-replace`（删除子代理禁止 Todo 的句子）、`task-completion-judge`（读取 `omp-todo-more:read`） | `replaces: 原生 todo`；若不装 `omp-todo-more` 必须同时恢复 `todo.enabled: true` 并移除子代理 Todo 要求与 `omp-todo-more:read` 检查，否则会话完全丧失 Todo 能力 | 插件启用（`system-prompt-replace` 跳过） |
| `pty-routing` | **必选基底（Core）** | `config.yml#launch.enabled: false`、`config.yml#bashInterceptor`、插件 `omp-unified-exec`（`exec_command` 等 `xd://` 设备）、`tool-topics` 的 `TOPIC-exec_command-*.md` 与 `SURFACE-bash.md`、`tool-policy-nag` 的 `pty` 通道（`omomp.yml#tool-policy-nag.pty`） | `replaces: 原生 launch 服务模式`；若不装 `omp-unified-exec` 必须恢复 `launch.enabled: true` 并移除 `TOPIC-exec_command-*`，否则长生命周期命令无处执行；会话里没有 `exec_command` 时 `pty` 通道自动放行 | 启用（轻量模式禁用 `tool-policy-nag`，`pty` 通道不运行） |
| `safe-deletion` | **必选基底（Core）** | 扩展 `delete-guard`（拦截 `bash`/`eval` 删除与非字面命令，注册字面路径 `delete` 工具）、`TOPIC-bash-policy.md` | 独立安全闭包；移除后模型可在 `bash`/`eval` 中直接执行不可逆 `rm -rf` | 启用 |
| `compaction-baseline` | **必选基底（Core）** | `config.yml#compaction`（`methodOrder: [remote, soft, snapcompact, handoff, shake]`、`asyncEnabled: false`、`thresholdTokens`）、`model-compaction`（本机 `omomp.yml#model-compaction`）、`session-urls`（`session://`） | 与 `omp-todo-more` 的 compact 后恢复协同保护长程约束 | 启用 |
| `workspace-lifecycle` | **必选基底（Core）** | `wt-tool`（`wt`、`wt_remove`）、`harness-restart`（`harness_restart`）、`omp-config-autoupdate`、`omomp-lang`、`omp-light.ts` | 提供工作树隔离切换、自举重启、界面语言与更新器入口 | 启用 |
| `advisor-governance` | **长程治理包（Full-mode Pack，可整体选装）** | `APPEND_SYSTEM.md` 顾问规则、`agent/agents/{discuss-steady,discuss-divergent,mentor-default}.md`、`config.yml#task.agentModelOverrides` 顾问绑定、`user-prompt-inject`、`PROMPT-INJECT-user-goal.md` | 必须成组启用或成组移除：仅留 `APPEND_SYSTEM.md` 而缺顾问定义/模型绑定会导致主会话调用不存在的角色；仅卸 `user-prompt-inject` 会使顾问丧失用户原话与 `ask` 决策上下文 | 整体跳过（用空 `APPEND_SYSTEM_LIGHT.md`） |
| `subagent-gates` | **长程治理包（Full-mode Pack，可整体选装）** | `config.yml#task.disabledAgents`（禁用 `task, scout, sonic, reviewer, security-reviewer`）、`agent/agents/task-{high,mid,low,free}.md`、`fork-task`（含 `fork:self`）、`isolation-nudge`、`task-split-check`、`task-completion-judge` | `replaces: 内置人设子代理`；`requires: todo-continuity`（`task-completion-judge` 依赖 `omp-todo-more`） | 跳过 `fork-task` 与派发/交付检查扩展 |
| `drift-monitors` | **长程治理包（Full-mode Pack，可整体选装）** | `tool-policy-nag`（`omomp.yml#tool-policy-nag` + `INTENT-policy.md`）、`turn-judge`（`TURN-JUDGE-gpt-talk-only.md`）、`lang-nag`（`omomp.yml#lang-nag`）、`watchdog-agent`（本机 `WATCHDOG-*.md`） | `tool-policy-nag` 在默认 `detector: heuristic` 下将运行期 `bashInterceptor.enabled` 设为 `false`；关闭 `tool-policy-nag` 后 `bashInterceptor` 恢复硬拦截 | 整体跳过 |
| `provider-adapters` | **条件必选（Conditional）** | `pi-bansos`（配 `~/.pi/agent/pi-bansos-relay-state.json`，供 `task:free` 首选链使用）、`pi-commandcode-provider` + `commandcode-model-spec`（配本机 `commandcode-models.json`）、`antigravity-wire-profiles` | 按用户实际使用的 provider 条件启用：不用 `bansos` 时需改绑 `task:free`；不用 `commandcode` 或 `google-antigravity` 时对应组件空转无害，可选安装器可省略 | 启用 |
| `ui-workflow-extras` | **可选增强（Optional）** | 插件 `omp-ask-more`（`requires: 原生 ask 保持开启`）、`omp-thinking-translator`（配 `thinking-translator.json` + 本机 `models.yml` `supportsReasoningEffort`）、`pi-pretty-codeblocks`、`omp-playbooks`（仅 `TERN_PANE` 内激活）、`omp-codex-image-gen`、`pi-package-search`、`omp-remote-build`（默认注释，`requires: omp-unified-exec`）；扩展 `input-polish`、`doc-polish`（本机 `omomp.yml#doc-polish`）、`append-system-model`（本机 `APPEND_SYSTEM_MODEL.md`）、`child-memory-warning`（仅 macOS） | 均可按个人工作流独立选装或省略，不影响长程任务正确性基底 | 除 `doc-polish` 跳过外其余启用 |

---

## 阶段 3：可定制项分类、定制思路与当场定制（只写本机副本）

向用户展示以下定制划分（这也是后续可选安装器的配置分类基准），并通过 `ask` 收集用户的当场定制决定：

### 1. 需要当场定制并写入本机的配置（本机所有，或首次播种后归本机；更新器不覆盖）

| 定制项 | 本机写入位置 | 定制思路（为什么需要根据用户环境决定） |
|---|---|---|
| **通用与扩展模型角色（`modelRoles`）** | `<agentDir>/config.yml#modelRoles`（属于 `LOCAL_CONFIG_FIELDS`） | 决定主模型与各扩展的调用链：`default`、`smol`（`input-polish`/`task-split-check`/`task-completion-judge` 的默认回退）、`slow`、`plan`、`judge`（`openJudge` 主链）、`tiny`（`judge` 回退链），以及可选的专用角色 `@input-polish`、`@task-split-check`、`@task-completion-judge`、`@doc-polish.split`、`@doc-polish.polish`、`@doc-polish.check`。`openJudge` 的使用方各有可选专用角色 `@lang-nag`、`@tool-policy-nag`、`@turn-judge`、`@watchdog-agent`：绑定聊天模型后，该扩展改由这些模型作提示式判定，不再走 `judge` 链；适用于 `judge` 绑定的原生判定模型答不好该扩展问题的情况。必须绑定到用户本机已有凭据的 provider/model。 |
| **子代理模型绑定（`task.agentModelOverrides`）** | `<agentDir>/config.yml#task.agentModelOverrides`（属于 `SEED_CONFIG_FIELDS`） | 仓库默认值按作者订阅绑定：`task:high` / `discuss:divergent` 用 `anthropic/claude-opus-*`，`task:mid` / `discuss:steady` / `mentor:default` 用 `openai-codex/gpt-*-sol`，`task:low` 及回退链用 `openai-codex/gpt-*-luna`，`task:free` 用 `bansos` / `opencode-go` / `openai-codex`。逐个检查每个子代理绑定的模型在本机是否有可用凭据，缺失的改绑到本机现有 provider；首次安装后它归本机，之后的仓库改动不再覆盖。 |
| **界面与监督语言（`omomp-lang`、`lang-nag`、`input-polish.key` / `instruction`）** | `<agentDir>/omomp.yml` 对应段（属于 `SEED_OMOMP_FIELDS`） | 仓库默认中文（`language: zh`、`lang-nag: 说中文`）。用户偏好其他语言时直接改本机值；也可用环境变量 `OMOMP_LANG=en` 临时覆盖界面语言，或在具体项目的 `<cwd>/.omp/omomp.yml` 按项目覆盖（项目 `.omp/omomp.*` 优先于 `<agentDir>/omomp.*`）。终端不支持 `ctrl+enter` 时改 `input-polish.key`。 |
| **思考翻译（`thinking-translator.json`）** | `<agentDir>/thinking-translator.json` 的 `enabled`、`targetLanguage`、`translatorModels`（属于 `SEED_TRANSLATOR_FIELDS`） | 仓库默认链依赖 `futureppo-pool` 与 `commandcode` 凭据；本机没有时改用本机可用的模型，或用 `/thinking-translator` 关闭。 |
| **按模型匹配的长上下文压缩阈值（`model-compaction`）** | `<agentDir>/omomp.yml#model-compaction`（属于 `LOCAL_OMOMP_SECTIONS`） | 不同模型的有效上下文窗口与计费阶梯不同（例如 Claude Opus 适合在 `150000`–`180000` 压缩，而支持大窗口的 GPT/Gemini 模型可设到 `500000`–`650000`）。用正则按 `provider`/`model` 精细设定 `thresholdTokens`。 |
| **文档润色本机配置（`doc-polish`）** | `<agentDir>/omomp.yml#doc-polish`（属于 `LOCAL_OMOMP_SECTIONS`） | 若用户需要使用 `/polish-doc` 或 `polish_doc` 工具，需配置 `fallbackRole`（如 `default` 或 `smol`）与 `concurrency`（如 `6` 或 `8`）；不使用则跳过不创建。 |
| **启动自动更新与冲突处理（`omp-config-autoupdate`）** | `<agentDir>/omomp.yml#omp-config-autoupdate`（属于 `LOCAL_OMOMP_SECTIONS`） | `enabled: true` 让 OMP 每次启动自动跟随 GitHub `main` 更新配置与插件，本机定制靠三方合并保留；若后续打算自行修改仓库工作树则保持 `false`。`conflicts` 决定本机定制与上游冲突时的处理：`notify`（默认，只提示 `/omp-config-autoupdate adapt`）或 `agent`（刚应用新提交且会话还没有用户消息时自动发起适配）。 |
| **本机扩展加载项与界面偏好** | `<agentDir>/config.yml` 的 `extensions` 前置项、`LOCAL_CONFIG_FIELDS` 与 `SEED_CONFIG_FIELDS` | 若本机使用 `~/.claude`，需在 `<agentDir>/config.yml` 的 `extensions` 列表最前面保留 `~/.claude`；另可按需设置 `defaultThinkingLevel`、`theme`、`terminal`、`tui`、`statusLine`、`worktree`，以及播种后归本机的 `browser`、`task.maxConcurrency`、`retry.fallbackChains`。 |
| **模型特定提示词与周期审阅（可选初始化）** | `<agentDir>/extensions/append-system-model/APPEND_SYSTEM_MODEL.md`、`<agentDir>/extensions/watchdog-agent/WATCHDOG-*.md` | 仅当用户对特定模型有专属附加指令，或需要开启后台步数审阅时才在本机创建；默认无需创建。 |
| **供应商模型兼容项（`models.yml`）** | `<agentDir>/models.yml`（本机运行时配置） | 若用户使用 `futureppo-pool` 等需要显式开启 `supportsReasoningEffort: true` 的 provider（供 `omp-thinking-translator` 等使用），写入本机 `models.yml`。 |

**推荐值先核对再呈现**：给出 `modelRoles`、`task.agentModelOverrides`、思考翻译链与 `model-compaction` 的推荐值之前，先运行 `omp models <provider>`，取得每个候选模型的 `thinking` 与 `context` 列：
- 每个 `provider/model:effort` 的 effort 必须出现在该模型的 `thinking` 列。
- `model-compaction` 规则按文件顺序首个匹配生效；每条规则的 `thresholdTokens` 必须小于它作为首个匹配命中的每个本机模型的 `context`，兜底规则（如 `.*`）也要覆盖窗口最小的模型。等于或超过窗口的触发点不会按所写的值生效：会改变窗口档位的规则被扩展拒绝并告警，其余被截到窗口减去预留。
- 呈给用户批准的表就是阶段 4 要写入的值，不再另加批准表之外的键。

### 2. 受管但可在本机定制的仓库配置（三方合并保护）

以下项由仓库提供并持续更新。用户需要时，AI 在确认后直接改本机副本：更新器保留本机修改，上游改动不重叠时自动合并，重叠时报告冲突并在 `/omp-config-autoupdate adapt` 中逐项适配。不改仓库工作树。

- **监督提示词措辞（`agent/omomp.yml` 的 `tool-policy-nag.form.prompt` 等仓库键）**：用户偏好其他语言时改本机值。
- **子代理定义、系统提示词与模板（`agents/*.md`、`SYSTEM_TEMPLATE.md`、`APPEND_SYSTEM.md`、`PERSONALITY.md`、`PROMPT-INJECT-*.md`、`TURN-JUDGE-*.md`）**：只在用户有明确需求时修改，并说明修改在下次派发、下一轮或重启后生效。
- **可选与条件插件（`install-plugins.sh`）**：插件列表以仓库为准，不能在本机定制。诊断本机是否具备 `omp-playbooks`（`PATH` 上是否有 `tern`）、`omp-codex-image-gen`（是否有 Codex 订阅）、`omp-remote-build`（默认注释；是否需要 Mutagen + `km` + 远端构建机）的运行前提，并记录用户的可选偏好。

### 3. 建议延后定制的参数（默认保留仓库值，有实测体感后再调）

向用户明确说明以下参数**不建议在首次安装时凭直觉修改**，应保持仓库经过校准的默认值：
- `tool-policy-nag` 的 `afterHits: 3`、`maxNags: 3`、`intent.threshold: 0.5` 与 `risk` 阈值（启发式高误报率是有意设计，只消耗少量自检 thinking token；这些提醒通道不会阻断命令）。`pty: {}` 保持开启：它是确定性的入口路由，没有阈值可调，只在会话挂载了 `exec_command` 时拦截。
- `TURN-JUDGE-gpt-talk-only.md` 的 `threshold: 0.8`（基于真实 GPT 会话样本校准为 0 误报）。
- `compaction.methodOrder`（`remote → soft → snapcompact → handoff → shake`）与 `compaction.asyncEnabled: false`。
- `child-memory-warning.thresholdGiB: 4`、`tool-topic-injection.rules`、`system-prompt-replace.replacements`。

---

## 阶段 4：执行安装与写入本机定制

当用户在 `ask` 中确认安装与本机定制方案后，初始化 `todo` 并按顺序执行（当传入参数为 `check` 时跳过本阶段写入，仅跑 `--check` 与 `./plugin-audit.sh`）。冷启动时（`omp-todo-more` 未加载，会话里的 `todo` 是原生工具），`todo` 只列第 1 步，并在运行第 2 步的更新器之前全部完成；第 2–4 步不再调用 `todo`，结果写进阶段 5 的报告。

1. **写入用户在阶段 1 与阶段 3 确认的本机定制**（这些路径归本机或是播种路径，第 2 步的更新器保留已有值）：
   - 写入的值必须等于用户批准的方案。写入前发现批准值不可用（模型不存在、effort 不在 `thinking` 列、阈值不小于 `context`）时，不自行替换，先用 `ask` 说明差异并取得新的批准。
   - 对 `<agentDir>/config.yml` 中的本机字段与播种路径（如 `modelRoles`、`defaultThinkingLevel`、`task.agentModelOverrides`、`extensions` 中的 `~/.claude` 等）以及用户确认的其他键，使用 `omp config set` 或在读取 `<agentDir>/config.yml` 后用 `edit` 精确修改对应键。
   - 对 `<agentDir>/omomp.yml` 中的本机段（`model-compaction`、`doc-polish`、`omp-config-autoupdate`）、播种路径（`omomp-lang`、`lang-nag`、`input-polish.key` / `instruction`）及用户确认的其他键，先 `read` `<agentDir>/omomp.yml`，再用 `edit` 只改这些键，其余键保持原样。`<agentDir>/thinking-translator.json` 同理。文件尚不存在时只写入这些本机段或播种字段：第 2 步的更新器补齐仓库的其余内容，并保留已有的本机段与播种字段。
   - 若用户确认创建 `<agentDir>/models.yml` 兼容项（如 `futureppo-pool` 的 `supportsReasoningEffort: true`）或 `<agentDir>/commandcode-models.json`：若 `<agentDir>/models.yml` 已存在，严禁整文件重写或读取/回显含 `apiKey` 的行，只做最小字段追加或给出 YAML 片段由用户合入，保留文件中所有既有 provider 与未知字段。
   - 用 `Bun.YAML.parse` / `JSON.parse` 校验刚写的文件（不打印 `models.yml` 凭据内容）。
2. **执行仓库 → 本机更新器**：
   - 在仓库根目录运行：`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source .`（命名 profile 加 `--agent-dir <omp config path 输出>`）。
   - 若脚本报告 ` errors` 或 `Cutover incomplete; do not restart OMP`，立即停止后续步骤，协助排查修复后重跑。
   - 若报告 `conflict (…), local copy kept: <id>`，按 `/update-omp` 第 2 步与用户逐项适配（`conflicts --source .`，再 `resolve --source .`）：每个冲突只改冲突的那个键，不整文件重写本机配置来消除冲突。
3. **执行插件审计**：
   - 运行 `./plugin-audit.sh`。若出现 `[卸载候选]`，用 `ask` 询问用户是否执行 `omp plugin uninstall <name>`。
4. **校验落盘状态与工作树干净度**：
   - 用 `Bun.YAML.parse` / `JSON.parse` 校验更新器写过的 `<agentDir>/config.yml`、`<agentDir>/omomp.yml`（不打印 `models.yml` 凭据内容）。
   - 运行 `omp config list --scope global --json`、`omp plugin list --json` 与 `git status --short`，确认本机配置已生效、第 1 步写入的值仍等于批准方案，且仓库工作树未被意外污染。

---

## 阶段 5：激活边界说明与最终交付报告

安装与本机定制完成后，向用户输出结构化的最终报告（严格区分**已落盘**、**当前会话已生效**与**需重启后生效**）：

1. **本机已安装与已定制项**：
   - 更新器写入的文件、已安装/升级的插件、`omp-light` 安装位置。
   - 已写入 `<agentDir>` 的本机定制（`modelRoles`、`task.agentModelOverrides`、语言段、`model-compaction`、`doc-polish`、`omp-config-autoupdate` 等）及其当前实际值。
2. **定制在后续更新中的去向**：
   - 哪些定制属于本机所有或播种路径（更新器不再覆盖），哪些是受管项的本机修改（三方合并保留，冲突时适配），哪些是代码（会被覆盖）。
   - 语言与思考翻译链在本机的可用状态与项目级 `.omp/omomp.yml` / 环境变量覆盖方式。
3. **全量安装与日常模式选择（面向后续可选安装器的映射）**：
   - 汇总用户在本轮表达的可选组件偏好（哪些属于必选基底、哪些属于条件启用、哪些当前虽随全量更新器安装但未激活或可在轻量模式跳过）。
   - 说明日常如何选择入口：复杂多步工程任务运行 `omp`（完整模式，含全部子代理治理与偏离纠偏）；简单问答或小改动运行 `omp-light`（轻量模式，跳过 `agent/config-light.yml` 列出的治理扩展与 `system-prompt-replace`）。
4. **生效时机与重启提示**：
   - **当前会话已热重载生效**：`<agentDir>/config.yml` 中的设置（如 `modelRoles`；`todo.enabled: false` 也已生效，本会话不再有原生 `todo`）、从下一条 prompt/调用起按需重读的 `APPEND_SYSTEM_MODEL.md`、`WATCHDOG-*.md`、`TURN-JUDGE-*.md`。
   - **必须重启 `omp` 后才加载生效**：`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`、新安装或更新的本地扩展与外部插件（含 `omp-todo-more` 的 `todo`/`ctx`）、`tool-topics`（`SURFACE-*` / `TOPIC-*`）、`omomp-lang` 界面语言。若当前会话有 `harness_restart` 工具且用户希望立即重启恢复会话，可提示或调用 `harness_restart`；否则提醒用户手动退出并重新启动 `omp`。
