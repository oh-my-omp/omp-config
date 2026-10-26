# omp-config

[English](README.md) | 简体中文

`omp-config` 是将前沿大语言模型从自由对话生成器改造为受控多级工程状态机的 Oh My Pi（`omp`）运行时配置与扩展仓库。它只纳管可代码审查、可跨机器确定性重放的策略、提示词、子代理定义与本地 TypeScript 扩展；数据库（`*.db*`）、会话历史、模型缓存、日志、锁文件、插件安装包（`~/.omp/plugins/`）与供应商凭据严禁入库。

## Wiki 导航

| 页面 | 内容范围 |
|---|---|
| **[1. 系统定位与控制论架构](docs/architecture.zh-CN.md)** | 四条控制论工程假设、运行时控制流程图、20 行失效模式与运行时对策全景矩阵 |
| **[2. 提示词四层解耦与上下文经济学](docs/prompts-and-context.zh-CN.md)** | 四层提示词解耦（`SYSTEM_TEMPLATE.md`、`PERSONALITY.md`、`APPEND_SYSTEM.md`）、`system-prompt-replace`、`append-system-model`、`repo-rules`、`fork-task`、`model-compaction`、`ctx` 与任务日志状态重建 |
| **[3. 多代理拓扑、顾问与成本信任分档](docs/agents.zh-CN.md)** | 7 个自定义子代理与模型绑定矩阵、防回声室顾问（`user-prompt-inject`、`discuss:steady` vs `discuss:divergent`、无工具 `mentor:default`）、派发经济学与并行写入隔离 |
| **[4. 运行期门禁、旁路判定器与本地扩展](docs/extensions.zh-CN.md)** | 派发前/交付前硬门禁、共享原生 `JUDGE` 旁路纠偏、宿主/TUI 交互工具，以及 22 项 [本地扩展总览表](docs/extensions.zh-CN.md#本地扩展总览表) |
| **[5. 插件生态与双轨运行模式](docs/plugins-and-modes.zh-CN.md)** | 8 个必装 + 2 个可选外部插件（`omp-todo-more`、`omp-thinking-translator` 等）及 Full 模式（`omp`）与轻量模式（`omp-light`）对比 |
| **[6. 归属边界、双单向同步与工程维护](docs/operations.zh-CN.md)** | 仓库与本机所有权矩阵、两条单向同步工作流、`omp-config-autoupdate`、`_shared` 基础设施、CI 检查与宿主升级核对清单 |
| **[CI 配置检查（`ci/README.zh-CN.md`）](ci/README.zh-CN.md)** | 零凭据真实 RPC 会话检查（`bun ci/check.ts`）、影子模型接入与诊断去重判据 |
| **[末尾加载扩展（`agent/extensions-last/README.zh-CN.md`）](agent/extensions-last/README.zh-CN.md)** | 扩展加载顺序规则及 `system-prompt-replace` 独立于 `agent/extensions/` 的原因 |
| **[子代理编写备忘（`agent/agents/README.zh-CN.txt`）](agent/agents/README.zh-CN.txt)** | 子代理 frontmatter、`spawns` 白名单、depth 2 递归上限与 `yield` 常见陷阱 |

## 快速上手与常用命令

在仓库根目录启动 `omp` 后执行斜杠维护命令：

```text
/update-omp [check]                          # 仓库工作区 -> 本机（~/.omp/agent、~/.pi/agent、omp-light 与插件）
/sync-omp-config [check]                     # 本机 -> 仓库（按字段比对修改、校验、提交并推送）
/omp-config-autoupdate [status|on|off|run]   # 本机启动自动更新开关（默认关闭）或当场从 GitHub 拉取更新
/migrate-omp-keys <target>                   # 经 SSH 将本机 auth_credentials 表迁移至远端主机 agent.db
```

在仓库根目录执行的终端与校验命令：

```bash
omp                           # Full 模式：挂载全部 22 个本地扩展、派发/交付门禁、旁路判定器与强制顾问
omp-light                     # 轻量模式：跳过 10 个流程治理扩展与 system-prompt-replace
bun run check                 # Biome 格式/lint + 严格 tsc --noEmit（检查 agent/**/*.ts 与 ci/**/*.ts）
./plugin-audit.sh             # 只读比对 install-plugins.sh 与 `omp plugin list`
bun ci/check.ts               # 隔离 HOME 安装 + 免费模型跑真实 Full / Light 双模式 RPC 会话检查
```

新机器首次部署、纯空环境手动复制及仓库 ↔ 本机归属矩阵详见 **[归属边界、双单向同步与工程维护](docs/operations.zh-CN.md#日常维护工作流)**。

## 组件速查索引

| 类别 | 组件与直达 Wiki 链接 |
|---|---|
| **提示词与规则** | [`SYSTEM_TEMPLATE.md`](docs/prompts-and-context.zh-CN.md#提示词四层解耦) · [`PERSONALITY.md`](docs/prompts-and-context.zh-CN.md#提示词四层解耦) · [`APPEND_SYSTEM.md`](docs/prompts-and-context.zh-CN.md#提示词四层解耦) · [`system-prompt-replace`](docs/prompts-and-context.zh-CN.md#system-prompt-replace) · [`append-system-model`](docs/prompts-and-context.zh-CN.md#append-system-model) · [`repo-rules`](docs/prompts-and-context.zh-CN.md#repo-rules) |
| **上下文与状态重建** | [`fork-task`](docs/prompts-and-context.zh-CN.md#fork-task) · [`model-compaction`](docs/prompts-and-context.zh-CN.md#model-compaction) · [`ctx`](docs/prompts-and-context.zh-CN.md#ctx) · [`Task log`](docs/prompts-and-context.zh-CN.md#task-log) · [`compact 后注入`](docs/prompts-and-context.zh-CN.md#compact-后注入) |
| **子代理与顾问** | [`task:high` · `task:mid` · `task:low` · `task:free`](docs/agents.zh-CN.md#七个自定义子代理与模型绑定矩阵) · [`discuss:steady` · `discuss:divergent` · `mentor:default`](docs/agents.zh-CN.md#七个自定义子代理与模型绑定矩阵) · [`user-prompt-inject`](docs/agents.zh-CN.md#user-prompt-inject) |
| **派发与交付硬门禁** | [`isolation-nudge`](docs/extensions.zh-CN.md#isolation-nudge) · [`task-split-check`](docs/extensions.zh-CN.md#task-split-check) · [`task-completion-judge`](docs/extensions.zh-CN.md#task-completion-judge) |
| **运行期旁路判定** | [`tool-policy-nag`](docs/extensions.zh-CN.md#tool-policy-nag) · [`watchdog-agent`](docs/extensions.zh-CN.md#watchdog-agent) · [`turn-judge`](docs/extensions.zh-CN.md#turn-judge) · [`lang-nag`](docs/extensions.zh-CN.md#lang-nag) |
| **宿主、TUI 与同步扩展** | [`child-memory-warning`](docs/extensions.zh-CN.md#child-memory-warning) · [`input-polish`](docs/extensions.zh-CN.md#input-polish) · [`doc-polish`](docs/extensions.zh-CN.md#doc-polish) · [`wt-tool`](docs/extensions.zh-CN.md#wt-tool) · [`harness-restart`](docs/extensions.zh-CN.md#harness-restart) · [`commandcode-model-spec`](docs/extensions.zh-CN.md#commandcode-model-spec) · [`antigravity-wire-profiles`](docs/extensions.zh-CN.md#antigravity-wire-profiles) · [`omomp-lang`](docs/extensions.zh-CN.md#omomp-lang) · [`omp-config-autoupdate`](docs/operations.zh-CN.md#omp-config-autoupdate) |
| **外部插件** | [`omp-todo-more`](docs/plugins-and-modes.zh-CN.md#todo-more) · [`omp-thinking-translator`](docs/plugins-and-modes.zh-CN.md#思考翻译) · [`omp-unified-exec` · `pi-bansos` · `pi-commandcode-provider` · `omp-codex-image-gen` · `pi-package-search` · `pi-pretty-codeblocks` · `omp-remote-build` · `omp-playbooks`](docs/plugins-and-modes.zh-CN.md#插件生态与外部能力底座) |
