# 插件生态与双轨运行模式

[返回首页](../README.zh-CN.md) · [English](plugins-and-modes.md) | 简体中文

## 插件生态与外部能力底座

仓库将轻量级的“策略与生命周期钩子”留在 `agent/extensions/`，而把重状态的持久化引擎、模型网关协议适配层、跨平台 PTY 终端与 Tern 分屏 UI 面板下沉为通过 `install-plugins.sh` 安装到 `~/.omp/plugins/` 的独立插件（共 8 个必装 + 2 个注释态可选，均不钉版本；每次更新器运行都会对必装项执行 `omp install` 以安装缺失项并升级已装项；配置提交未变的自动更新仍会对每个不带 `#ref` 的 GitHub 条目（必装项与已装的可选项）执行 `omp install`，所以它们不等配置提交也会跟上各自的默认分支）。`plugin-audit.sh` 以 `omp install` 在 `~/.omp/plugins/package.json` 中为每个 Git/URL 条目记下的包名（第二列）作为对比键，已装的可选插件归入 `[保留]`，既不算缺失也不进卸载候选：

| 声明源（`install-plugins.sh`） | `omp plugin list` 包名 | 类别 | 暴露的工具 / 命令 / 技能 / 界面 | 核心机制及与本配置的耦合契约 |
|---|---|---|---|---|
| `https://github.com/oh-my-omp/omp-todo-more` | `omp-todo-more` | 必装（GitHub） | 工具：`todo`, `ctx`；命令：`/todo-more`；事件：`omp-todo-more:read`；Tern 面板 | 全面接管被 `config.yml` 关闭的原生 Todo（详见下方 [todo-more](#todo-more)） |
| `https://github.com/oh-my-omp/omp-unified-exec` | `omp-unified-exec` | 必装（GitHub fork） | `xd://` 工具：`exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions` | `iamwrm/pi-unified-exec` 的自维护 fork：每次 `exec_command` 启动长生命周期会话并将全量输出落盘至 `/tmp/pi-unified-exec-*.log`；跳过 OMP 不支持的 `createCodemodeExtension`，并在 Bun 1.4+ 下统一使用原生 `Bun.Terminal` 实现 macOS/Linux/Windows PTY（仅 Node.js 下按需加载 `@homebridge/node-pty-prebuilt-multiarch`）。装前须先 `omp plugin uninstall pi-unified-exec` |
| `https://github.com/mouriya-s-lab/pi-bansos` | `pi-bansos` | 必装（GitHub fork） | Provider：`bansos`；命令：`/bansos` | `mannnrachman/pi-bansos` 的 fork：在本地 `127.0.0.1:18080` 启动代理，构造 OpenCode Desktop 客户端指纹与 KiloCode 网关路由，为 `task:free` 提供零成本模型。状态文件 `~/.pi/agent/pi-bansos-relay-state.json` 随仓库双向同步；装前须先卸载 npm 版 `pi-bansos` |
| `pi-commandcode-provider` | `pi-commandcode-provider` | 必装（npm） | Provider：`commandcode`（`api: "commandcode-custom"`）；命令：`/commandcode-quota` | 接入 Command Code API 并生成本机 `~/.omp/agent/commandcode-models.json`，为思考翻译与 `doc-polish` 提供免费/高速模型池，配合本地扩展 `commandcode-model-spec` 使用 |
| `https://github.com/oh-my-omp/omp-thinking-translator` | `omp-thinking-translator` | 必装（GitHub） | 助手 thinking 块实时中文翻译渲染器 + 迟到译文补发通知；命令：`/thinking-translator` | 按行去重并流式翻译思考块，读取受管配置 `~/.omp/agent/thinking-translator.json`（详见下方 [思考翻译](#思考翻译)） |
| `https://github.com/oh-my-omp/omp-codex-image-gen` | `omp-codex-image-gen` | 必装（GitHub） | `xd://` 工具：`codex_generate_image`；Skill：`imagegen` | 复用本机 ChatGPT Plus/Pro Codex 订阅凭据调用 `gpt-image-2` 生成或基于 1–5 张本地参考图编辑 PNG |
| `pi-package-search` | `pi-package-search` | 必装（npm） | `xd://` 工具：`search_pi_packages`, `install_pi_package`；Skill：`pi-package-search` | 在会话内检索 npm 上的 `pi-package` 扩展包，并在用户明确要求时调用安装 |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | 必装（npm） | TUI `Markdown.prototype.render` 补丁 | 隐藏 TUI Markdown 代码块的起止围栏行并移除默认 2 列缩进，保留源码内部缩进与 ANSI 语法高亮 |
| `# https://github.com/oh-my-omp/omp-remote-build` | `omp-remote-build` | 可选（默认注释不装） | `xd://` 工具：`container_exec`, `container_write_stdin`, `container_list_sessions`, `container_kill_session` | 为每个 git worktree 在远端 Docker 主机维护 Mutagen 实时同步副本与 Komodo 构建容器（写工具执行后自动触发 `Mutagen flush`）。依赖 `omp-unified-exec`、Mutagen、km CLI 与 SSH 构建主机 |
| `# https://github.com/oh-my-omp/omp-playbooks` | `omp-playbooks` | 可选（默认注释不装） | `xd://` 工具：`playbook_open`, `playbook_read`, `playbook_edit`, `playbook_compile`, `playbook_check`, `playbook_run`, `playbook_timeline`, `playbook_launch`；CLI：`omp-playbook` | 协同式 YAML Playbook 文档服务与 Tern 侧边栏表单卡片：支持 `task`/`design` 块共同编辑、外部引用展开、结合 `eval` `judge` 双重校验、Run 时间线及子代理 Launch 绑定（人类改块时实时推送 `block_changed`）。安装校验要求 PATH 上有 Tern 的 `tern` 命令（由 Tern 桌面应用提供），安装失败会让整次更新器 apply 中止，因此默认不装；装了 Tern 的机器取消注释即可 |

### todo-more

[omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) 在完整模式与轻量模式下均由普通插件发现机制加载，原生 Todo 保持 `todo.enabled: false`：

- **分支快照与投影分离**：当前会话分支上的 `mouriya.omp.todo-more` 快照条目是主状态记录（包含 `{objective, measure, doneWhen}` 目标，以及每项 `{title, explanation}`、分钟级预算与 `DONE` 提交记录的 git commit SHA）；宿主 `TodoTracker`、`/todo` 与历史卡片仅是派生投影。插件的 `planning.ts` 在列表为空时拦截 `edit`，并在 `before_agent_start` 为被宿主剥离 `todo` 的 `task:*` 子代理重新挂回独立 `todo`。
- **原生 `/todo-more` 编辑器**：在 OMP/Tern 中输入 `/todo-more` 可直接编辑 goal 或各项 explanation（Enter 换行、Tab/Shift+Tab 切换、Ctrl+Enter 保存、Esc 丢弃），仅在当前分支提交目标字段，不改变任务状态/顺序，也不触发模型回合。
- **旧本地模块安全退休**：更新器在确认 `omp-todo-more` 已在宿主 catalog 启用且入口 `./index.ts` 存在后，自动 unlink 旧版 8 个 Todo 路径（`extensions/todo-more/{index,tool,render,reminders,planning}.ts`、`extensions/_shared/todo-more.ts`、`extensions/subagent-todo.ts`、`extensions/subagent-todo/index.ts`），并在插件含 `src/ctx` 时一并 unlink 旧版 5 个 ctx 路径（`extensions/ctx-tool/{index,inventory,post-compact-hint}.ts`、`extensions/ctx-tasklog/index.ts`、`extensions/_shared/task-log.ts`）。仅 unlink 已知叶文件/叶链接，不删目录或链接目标；逆向同步同样排除这 13 个路径。

### 思考翻译

`omp-thinking-translator` 从 `~/.omp/agent/thinking-translator.json` 读取有序翻译模型链，每行思考文本的每次请求均从第 1 项开始尝试，失败才换下一项（下一条消息开始时重读配置）。仓库当前配置的 5 级候选链依次为：

1. `futureppo-pool/deepseek-v4.1-flash`（`effort: "low"`）
2. `futureppo-pool/grok-4.7`（`effort: "minimal"`）
3. `commandcode/inclusionai/ling-3.1-flash:free`（`effort: "minimal"`）
4. `commandcode/poolside/laguna-s-2.1-free`（`effort: "minimal"`）
5. `commandcode/stealth/glyph-cluster:free`（`effort: "minimal"`）

由于 `futureppo-pool` 自动发现的模型兼容信息默认省略 `reasoning_effort`，使用前两项时需在本机 `~/.omp/agent/models.yml`（本机文件，不同步）的既有 provider 下补充逐模型覆盖，重启 OMP 后用 `/thinking-translator status` 与真实翻译请求验证：

```yaml
providers:
  futureppo-pool:
    modelOverrides:
      deepseek-v4.1-flash:
        compat:
          supportsReasoningEffort: true
      grok-4.7:
        compat:
          supportsReasoningEffort: true
```

---

## 双轨运行模式：Full 模式与 omp-light

Full 模式（直接运行 `omp`）挂载了全套派发门禁、旁路判定器与强制顾问，适合重型长程工程；而日常简单问答或小修小补不需要承担这套流程税。`omp-light` 启动一个仅对当前进程生效、不改写任何磁盘文件的精简模式，将全部 22 个本地扩展精确划分为 **10 个禁用 + 1 个路径排除 + 11 个保留**：

| 维度 | Full 模式（`omp`） | 轻量模式（`omp-light`） |
|---|---|---|
| 追加系统提示词 | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md`（当前为空） |
| 主动委派倾向 (`task.eager`) | `preferred` | `default`（减弱主动派工，但不关闭 subagent） |
| 经 `disabledExtensions` 禁用的 **10** 个本地扩展 | 全部启用 | 禁用：`doc-polish`、`fork-task`、`isolation-nudge`、`lang-nag`、`task-completion-judge`、`task-split-check`、`tool-policy-nag`、`turn-judge`、`user-prompt-inject`、`watchdog-agent` |
| 经 `extensions: []` 排除的 **1** 个末尾扩展 | 启用 `system-prompt-replace` | `config-light.yml` 将 `extensions` 置空以排除 `extensions-last/system-prompt-replace`（`disabledExtensions` 按模块名过滤，管不到写成文件路径的条目）；启动器 `omp-light.ts` 读取本机 `config.yml`，将其余路径不含 `/extensions-last/` 的本机条目（如 `~/.claude`）通过 `-e` 补回 |
| 保留启用的 **11** 个本地扩展 | 启用 | 启用：`antigravity-wire-profiles`、`append-system-model`、`child-memory-warning`、`commandcode-model-spec`、`harness-restart`、`input-polish`、`model-compaction`、`omomp-lang`、`omp-config-autoupdate`、`repo-rules`、`wt-tool` |
| 已安装插件（含 `omp-todo-more` 的 `todo` 与 `ctx`） | 全部加载 | 全部加载（`disabledExtensions` 不作用于插件） |
| 工具差异 | 全量工具 | 仅 `polish_doc` 与 `fork_task` 消失；`todo`、`ctx`、`wt`、`wt_remove`、`harness_restart` 均照常可用 |

**跨平台入口安装：** 自动更新与 `/update-omp` 会将 `agent/omp-light.ts` 安装到 PATH 上 `omp` 所在目录（POSIX 为 `0755` 可执行文件 `omp-light`；Windows 为 `omp-light.ts` 加生成的 `omp-light.cmd`）。`omp-light` 从 `PI_CODING_AGENT_DIR`（未设则 `~/.omp/agent`）读取 `config-light.yml` 与 `APPEND_SYSTEM_LIGHT.md`，任一缺失即直接退出，后续命令行参数原样传给 `omp`。
