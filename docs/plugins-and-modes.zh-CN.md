# 插件与运行模式

[返回首页](../README.zh-CN.md) · [English](plugins-and-modes.md) | 简体中文

## 插件（`install-plugins.sh`）

轻量策略与生命周期钩子放在 `agent/extensions/`，而带持久状态的引擎、模型 provider 适配层、跨平台 PTY 终端与 Tern 侧边栏界面则作为独立插件通过 `install-plugins.sh` 安装到 `~/.omp/plugins/`（必装项加默认注释掉的可选项，不固定版本号，`~/.omp/plugins/` 不纳入本仓库）。

- 每次运行更新器都会对全部必装项执行 `omp install`，安装缺失插件并升级已安装插件。
- 启动自动更新在远端配置提交未变时，仍会对每个不带 `#ref` 的 GitHub 条目（必装项及已安装的可选项）执行 `omp install`，使其跟随各自仓库的默认分支。
- `./plugin-audit.sh` 以 `omp install` 在 `~/.omp/plugins/package.json` 中记录的包名（下表第二列）比对 Git/URL 条目；本机已安装的可选插件列在 `[保留]` 下，不算缺失也不进卸载候选。

| `install-plugins.sh` 条目 | `omp plugin list` 包名 | 类别 | 提供的工具 / 命令 / 技能 / 界面 | 用途与关联配置 | 控制面与行为闭包 | 可定制项与定制时机 |
|---|---|---|---|---|---|---|
| `https://github.com/oh-my-omp/omp-todo-more` | `omp-todo-more` | 必装（GitHub） | 工具：`todo`, `ctx`；命令：`/todo-more`；事件：`omp-todo-more:read`；Tern 面板 | 替代 `config.yml` 关闭的原生 Todo（见下方 [todo-more](#todo-more)） | 长程状态与压缩（必选基底 `todo-continuity`；与 `config.yml#todo.enabled: false`、`system-prompt-replace` 及 `task-completion-judge` 耦合） | 无需配置：`todo.enabled: false` 时不可省略 |
| `https://github.com/oh-my-omp/omp-unified-exec` | `omp-unified-exec` | 必装（GitHub fork） | `xd://` 工具：`exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions` | `iamwrm/pi-unified-exec` 的维护分支：启动长生命周期 PTY 会话并将输出写入 `/tmp/pi-unified-exec-*.log`，跳过 OMP 不支持的 `createCodemodeExtension`，在 Bun 下使用 `Bun.Terminal`（仅 Node.js 下加载 `@homebridge/node-pty-prebuilt-multiarch`）。安装前需先卸载 `pi-unified-exec` | 执行与工作区控制（必选基底 `pty-routing`；与 `config.yml#launch.enabled: false` 及 `TOPIC-exec_command-*` 耦合） | 无需配置：`launch.enabled: false` 时不可省略 |
| `https://github.com/mouriya-s-lab/pi-bansos` | `pi-bansos` | 必装（GitHub fork） | Provider：`bansos`；命令：`/bansos` | `mannnrachman/pi-bansos` 的分支：在 `127.0.0.1:18080` 启动本地代理，为 `task:free` 提供免费模型。读写 `~/.pi/agent/pi-bansos-relay-state.json`（本机插件状态，不进本仓库）；安装前需先卸载 npm 版 `pi-bansos` | 供应商与生命周期（条件必选 `free-tier-bansos`；与 `task:free` 模型绑定耦合） | 按需当场：通过 `/bansos` 管理 relay（`~/.pi/agent/pi-bansos-relay-state.json`）；`task:free` 使用 `bansos/...` 时需要 |
| `https://github.com/oh-my-omp/omp-thinking-translator` | `omp-thinking-translator` | 必装（GitHub） | 助手 thinking 块实时中文翻译渲染；命令：`/thinking-translator` | 按 `~/.omp/agent/thinking-translator.json` 逐行流式翻译思考块（见下方 [思考翻译](#思考翻译)） | 人机交互与 TUI（可选增强 `thinking-translator`） | 当场定制（首次安装后归本机）：用 `/thinking-translator` 切换；仓库默认链需 `futureppo-pool`（并在本机 `models.yml` 加 `supportsReasoningEffort: true`）或 OMP 内置的 `commandcode` provider（`/login commandcode`），否则修改本机的模型链 |
| `https://github.com/oh-my-omp/omp-codex-image-gen` | `omp-codex-image-gen` | 必装（GitHub） | `xd://` 工具：`codex_generate_image`；Skill：`imagegen` | 使用本机 ChatGPT Codex 订阅凭据调用 `gpt-image-2` 生成或根据 1–5 张参考图修改 PNG | 供应商与工作流扩展（可选增强 `workflow-extras`） | 条件可用：依赖本机 ChatGPT Codex 订阅凭据，无需额外配置 |
| `pi-package-search` | `pi-package-search` | 必装（npm） | `xd://` 工具：`search_pi_packages`, `install_pi_package`；Skill：`pi-package-search` | 检索 npm 上的 `pi-package` 扩展包，并在用户要求时安装 | 供应商与工作流扩展（可选增强 `workflow-extras`） | 无需配置 |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | 必装（npm） | TUI `Markdown.prototype.render` patch | 隐藏 TUI 中 Markdown 代码块的围栏行并去掉默认 2 列缩进，保留源码缩进与语法高亮 | 人机交互与 TUI（可选增强 `tui-tern`） | 无需配置 |
| `https://github.com/oh-my-omp/omp-playbooks` | `omp-playbooks` | 必装（GitHub） | `xd://` 工具：`playbook_open`, `playbook_read`, `playbook_edit`, `playbook_compile`, `playbook_check`, `playbook_run`, `playbook_timeline`, `playbook_launch`；CLI：`omp-playbook` | YAML Playbook 文档服务与 Tern 侧边栏界面。`PATH` 上有 Tern 桌面应用提供的 `tern` 时链接其 Tern 插件；没有时安装照样成功，只是不链接。不在 Tern pane 中运行的 omp（没有数字 `TERN_PANE`）不会从它得到工具、专题或命令 | 人机交互与 TUI（可选增强 `tui-tern`） | 条件激活：仅在 Tern pane（`TERN_PANE`）内生效；`PATH` 上有 `tern` 时自动链接 |
| `https://github.com/oh-my-omp/omp-ask-more` | `omp-ask-more` | 必装（GitHub） | 工具：`ask`（替换原生 `ask`）；设置：`config.yml` 中的 `askMore.*` | 在原生 `ask` 参数上增加每题的 `brief`（where/what/how、打开时从磁盘读取的代码证据、图、演示、风险）与每个选项的 `tradeoff`，以全屏页面（Tern 中为浮层）作答；结果保持原生格式，`turn-judge` 与 `user-prompt-inject` 无需改动即可读取。无人操作时在 `askMore.timeout`（1800 秒）后通知，再过 `askMore.returnTimeout`（1200 秒）把未答问题交给模型决定。无 TUI 的会话回退到原生 `ask`，因此原生 `ask` 须保持启用。Tern 样式插件需另行安装（可选）：`tern plugin install github.com/oh-my-omp/omp-ask-more/tern` | 人机交互与 TUI（可选增强 `ask-more`；原生 `ask` 须保持开启作无 TUI 回退） | 延后：保持默认 `askMore.timeout`（`1800` 秒）与 `askMore.returnTimeout`（`1200` 秒） |
| `# https://github.com/oh-my-omp/omp-remote-build` | `omp-remote-build` | 可选（默认注释） | `xd://` 工具：`container_exec`, `container_write_stdin`, `container_list_sessions`, `container_kill_session`, `remote_env_init`, `remote_env_build_image` | 按 git worktree 在远端 Docker 主机维护 Mutagen 同步副本与 Komodo 构建容器。依赖 `omp-unified-exec`、Mutagen、`km` CLI 与 SSH 构建主机 | 供应商与工作流扩展（可选增强 `workflow-extras`；依赖 `omp-unified-exec`） | 按需手动启用：默认注释不装，仅在具备 Mutagen、`km` 与 SSH 构建主机时手动安装 |

### todo-more

[omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) 在 `omp` 和 `omp-light` 中均由插件发现机制加载，原生 Todo 保持关闭（`agent/config.yml` 中 `todo.enabled: false`）。该工具定位介于普通会话与 `/goal` 之间：保留 `/goal` 对目标、验收条件（`objective`/`measure`/`doneWhen`）与未完成项的督促，同时允许在执行过程中调整阶段、任务、耗时预估与阻塞状态；任务完成与提交构成逻辑检查点（checkpoint），并在跨 compact 轮次时重新注入上下文：

- **分支快照、逻辑 checkpoint 与督促提醒**：当前分支上的自定义条目 `mouriya.omp.todo-more` 保存 `{objective, measure, doneWhen}` 及每项的 `{title, explanation}`、分钟预算与 `DONE` 提交记录的 git commit SHA（宿主 `TodoTracker`、`/todo` 与历史卡片均从该条目派生）。`planning.ts` 在列表为空时拦截 `edit`，其空列表提醒只在工作阶段（请求会改动文件、配置、git 或外部状态）要求建 todo，讨论与调查不建；`reminders.ts` 在回合结束且仍有未完成项（非向用户提问）时自动提醒继续；在有未提交改动的 git 工作区中 `DONE` 必须携带 git commit 子句（非 git 目录或工作区干净时不触发），将 commit SHA 记在完成项上并写入 [`Task log`](prompts-and-context.zh-CN.md#task-log) 形成逻辑 checkpoint；跨 compact 轮次时，`omp-todo-more` 会重新注入 Todo 快照与 [`compact 后注入`](prompts-and-context.zh-CN.md#compact-后注入)（`ctx list` 与 `ctx show`）；`before_agent_start` 则为 `task:*` 子代理挂回 `todo` 工具。
- **`/todo-more` 编辑器**：输入 `/todo-more` 直接修改 goal 或各项 explanation（Enter 换行、Tab/Shift+Tab 切换字段、Ctrl+Enter 保存、Esc 取消），只更新当前分支上的文字字段，不改动任务状态或触发模型回合。
- **旧本地文件清理**：更新器确认 `omp-todo-more` 在 OMP 插件目录中已启用且 `./index.ts` 存在后，会 unlink 旧本地 Todo 文件（`extensions/todo-more/{index,tool,render,reminders,planning}.ts`、`extensions/_shared/todo-more.ts`、`extensions/subagent-todo.ts`、`extensions/subagent-todo/index.ts`），并在插件含 `src/ctx` 时一并 unlink 旧本地 ctx 文件（`extensions/ctx-tool/{index,inventory,post-compact-hint}.ts`、`extensions/ctx-tasklog/index.ts`、`extensions/_shared/task-log.ts`）。`/sync-omp-config` 同样排除这些路径。

### 思考翻译

`omp-thinking-translator` 从 `~/.omp/agent/thinking-translator.json` 读取有序模型链，每次翻译请求从第 1 项开始尝试，失败才换下一项（下一条消息开始时重读文件）。更新器只在本机缺少 `enabled`、`targetLanguage`、`translatorModels` 时写入仓库值（`SEED_TRANSLATOR_FIELDS`），之后保留本机的值。仓库配置的模型链先试 `futureppo-pool` 中所有能翻译的对话模型（又快又稳的排前面），最后回退到 Command Code 的免费模型：

1. `futureppo-pool/grok-4.7`（`effort: "low"`）
2. `futureppo-pool/minimax-m3.1-flash`（`effort: "low"`）
3. `futureppo-pool/nemotron-3.5-bolt-e4b`
4. `futureppo-pool/nemotron-3-nano-omni-30b-a3b-reasoning`
5. `futureppo-pool/glm-4.6v-flash`
6. `futureppo-pool/nemotron-3.5-lightning`（`effort: "minimal"`）
7. `futureppo-pool/nemotron-3.5-lightning-30b-a3b`
8. `futureppo-pool/nemotron-3-ultra-550b-a55b`
9. `futureppo-pool/nemotron-3.5-super-vl-120b-a12b`
10. `commandcode/poolside/laguna-s-2.1-free`（`effort: "minimal"`）
11. `commandcode/stealth/glyph-cluster:free`（`effort: "minimal"`）
12. `commandcode/reflection/beam:free`

没写 `effort` 的条目用模型默认值。`glm-4.6v-flash` 不带 `reasoning_effort` 时约 1.5 秒出结果，带上后要思考约 30 秒，所以不设。不在链中：`glm-5.3-flash` 与 `deepseek-v4.1-flash` 已从该池下架；`nemotron-3-ultra` 对 OMP 的请求返回 `400 invalid_request`；`elephant-1` 是判定模型；`Index-Translate-35B-A3B` 无法通过 OMP 的 `max_completion_tokens` 请求体；Command Code 已不再提供 `inclusionai/ling-3.1-flash:free`。

`futureppo-pool` 自动发现的模型默认不带 `reasoning_effort` 支持，池内条目的 `effort` 只有在本机 `~/.omp/agent/models.yml`（本机文件，不同步）的 `providers.futureppo-pool` 下为该模型加上 `supportsReasoningEffort: true` 后才生效。改完重启 `omp`，用 `/thinking-translator status` 检查：

```yaml
providers:
  futureppo-pool:
    modelOverrides:
      grok-4.7:
        compat:
          supportsReasoningEffort: true
      minimax-m3.1-flash:
        compat:
          supportsReasoningEffort: true
      nemotron-3.5-lightning:
        compat:
          supportsReasoningEffort: true
```

---

## 完整模式（`omp`）与轻量模式（`omp-light`）

`omp` 加载全部本地扩展、派发/交付检查与顾问钩子，适合复杂多步任务；日常简单问答或小改动不需要这些额外检查。`omp-light` 在启动进程时叠加 `agent/config-light.yml` 与 `agent/APPEND_SYSTEM_LIGHT.md`，不改动磁盘上的配置文件：

| 配置项 | `omp`（完整模式） | `omp-light`（轻量模式） |
|---|---|---|
| 追加系统提示词 | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md`（空文件） |
| `task.eager` | `preferred` | `default` |
| `disabledExtensions` | 无 | 禁用以下本地扩展：`doc-polish`、`fork-task`、`isolation-nudge`、`lang-nag`、`task-completion-judge`、`task-split-check`、`tool-policy-nag`、`turn-judge`、`user-prompt-inject`、`watchdog-agent` |
| `config.yml` 的 `extensions` 路径列表 | 加载 `extensions-last/system-prompt-replace` | `config-light.yml` 将 `extensions` 设为空列表以跳过 `extensions-last/system-prompt-replace`（`disabledExtensions` 只按模块名过滤，不能过滤文件路径）；`omp-light.ts` 读取本机 `config.yml`，把不含 `/extensions-last/` 的本机条目（如 `~/.claude`）通过 `-e` 传回 |
| 其余本地扩展 | 启用 | 保留：`antigravity-wire-profiles`、`append-system-model`、`child-memory-warning`、`delete-guard`、`harness-restart`、`input-polish`、`model-compaction`、`omomp-lang`、`omp-config-autoupdate`、`repo-rules`、`session-urls`、`tool-topic-injection`、`tool-topics`、`wt-tool`（轻量模式下工具说明同样有表层文本与 `Topics` 索引） |
| 已安装插件 | 全部加载 | 全部加载（`disabledExtensions` 不影响插件） |
| 轻量模式减少的工具 | — | 仅少 `polish_doc` 与 `fork_task`；`todo`、`ctx`、`wt`、`wt_remove`、`harness_restart` 仍可用 |

**启动器安装**：`/update-omp` 和启动自动更新会把 `agent/omp-light.ts` 安装到 `PATH` 上 `omp` 所在目录（POSIX/macOS/Linux 为可执行文件 `omp-light`；Windows 为 `omp-light.ts` 加生成的 `omp-light.cmd`）。`omp-light` 从 `PI_CODING_AGENT_DIR`（未设置时为 `~/.omp/agent`）读取 `config-light.yml` 和 `APPEND_SYSTEM_LIGHT.md`，任一文件缺失即退出，其余命令行参数原样传给 `omp`。
