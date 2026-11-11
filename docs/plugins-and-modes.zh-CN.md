# 插件与运行模式

[返回首页](../README.zh-CN.md) · [English](plugins-and-modes.md) | 简体中文

## 插件（`install-plugins.sh`）

独立插件通过 `install-plugins.sh` 安装到 `~/.omp/plugins/`（必装项加默认注释掉的可选项，不固定版本号，`~/.omp/plugins/` 不纳入本仓库）。每个 omomp 插件声明为 `<url>#release`，机器安装的是它 `release` 分支的头，该分支由插件的每日发布移动，`main` 上未发布的改动不会装到机器上。下表只记录安装源与 omp-config 的集成关系；插件的用法与配置由链接指向的插件来源维护。

- 每次运行更新器都会按 `install-plugins.sh` 中声明的 spec，对全部必装项及每个已安装的可选项执行 `omp install`：缺失的必装插件被安装，已安装插件被升级并改记为声明的 spec（从不带 ref 的 URL 安装的可选插件改为 `#release`）。
- 启动自动更新在远端配置提交未变时，仍会对每个不带 `#ref` 或处在 `#release` 通道的 GitHub 条目（必装项及已安装的可选项）执行 `omp install`，使各插件跟随自己的发布（不带 ref 的跟随默认分支），不必等配置提交；钉在其他引用上的条目等到下次配置提交。已安装条目按 owner/repo 与声明的 GitHub 来源匹配，兼容 OMP 记录的 `github:`、HTTPS 和 git URL 等形式。
- `./plugin-audit.sh` 以 `omp install` 在 `~/.omp/plugins/package.json` 中记录的包名（下表第二列）比对 Git/URL 条目；本机已安装的可选插件列在 `[保留]` 下，不算缺失也不进卸载候选。

| `install-plugins.sh` 条目 | `omp plugin list` 包名 | 类别 | omp-config 集成关系 |
|---|---|---|---|
| [`https://github.com/oh-my-omp/omp-todo-more#release`](https://github.com/oh-my-omp/omp-todo-more) | `omp-todo-more` | 必装（GitHub） | 运行在原生 Todo 之上，原生 Todo 保持开启（`agent/config.yml` 中 `todo.enabled: true`）；见 [todo-more](#todo-more)。 |
| [`https://github.com/oh-my-omp/omp-unified-exec#release`](https://github.com/oh-my-omp/omp-unified-exec) | `omp-unified-exec` | 必装（GitHub fork） | 原生 launch 已关闭（`agent/config.yml` 中 `launch.enabled: false`）；本地 bash 表层说明指向 `xd://exec_command`。 |
| [`https://github.com/mouriya-s-lab/pi-bansos`](https://github.com/mouriya-s-lab/pi-bansos) | `pi-bansos` | 必装（GitHub fork） | `agent/config.yml` 的 `task:free` 绑定中包含 `bansos/...` 模型。 |
| [`https://github.com/oh-my-omp/omp-thinking-translator#release`](https://github.com/oh-my-omp/omp-thinking-translator) | `omp-thinking-translator` | 必装（GitHub） | 插件拥有的配置不由更新器或同步操作写入；见 [思考翻译](#思考翻译)。 |
| `pi-pretty-codeblocks` | `pi-pretty-codeblocks` | 必装（npm） | — |
| [`https://github.com/oh-my-omp/omp-playbooks#release`](https://github.com/oh-my-omp/omp-playbooks) | `omp-playbooks` | 必装（GitHub） | — |
| [`https://github.com/oh-my-omp/omp-ask-more#release`](https://github.com/oh-my-omp/omp-ask-more) | `omp-ask-more` | 必装（GitHub） | — |
| [`https://github.com/oh-my-omp/omp-peers#release`](https://github.com/oh-my-omp/omp-peers) | `omp-peers` | 必装（GitHub） | — |
| [`https://github.com/oh-my-omp/omp-sessions#release`](https://github.com/oh-my-omp/omp-sessions) | `omp-sessions` | 必装（GitHub） | — |
| [`https://github.com/oh-my-omp/omp-subagent-more#release`](https://github.com/oh-my-omp/omp-subagent-more) | `omp-subagent-more` | 必装（GitHub） | 提供 `fork_task`。 |
| [`# https://github.com/oh-my-omp/omp-remote-build#release`](https://github.com/oh-my-omp/omp-remote-build) | `omp-remote-build` | 可选（默认注释） | — |

### todo-more

插件运行在原生 Todo 之上，因此 `agent/config.yml` 保持原生 Todo 开启（`todo.enabled: true`）：插件的 `todo` 工具覆盖内置工具，并在进程内关闭原生提醒。仓库自带的轻量模式禁用列表仍保留 `omp-todo-more` 加载。本地 `task-completion-judge` 通过 `omp-todo-more:read` 事件请求会话的 Todo 状态。

更新器在安装插件之前，先检查 Todo、ctx 和 fork 清理目标的归属。OMP 插件目录确认 `omp-todo-more` 已启用且 `./index.ts` 存在后，更新器清理 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 中 `TODO_RETIREMENTS` 列出的本地 Todo 文件；只有就绪插件还包含 `src/ctx` 时，才会清理 `CTX_RETIREMENTS` 列出的文件。OMP 插件目录确认 `omp-subagent-more` 已启用且 `./extensions/fork-task/index.ts` 与 `agents/fork-self.md` 存在后，更新器清理 `FORK_RETIREMENTS` 列出的文件。`/sync-omp-config` 排除相同的路径。

插件工具文档：`xd://todo` 与 `xd://ctx`。

### 思考翻译

翻译设置见 [omp-thinking-translator README](https://github.com/oh-my-omp/omp-thinking-translator#readme)。配置和模型选择由插件与本机管理，不属于本仓库。更新器不会创建、重写或删除 `~/.omp/agent/thinking-translator.json`；`/sync-omp-config` 也不收回该文件。

---

## 完整模式（`omp`）与轻量模式（`omp-light`）

`omp` 加载全部本地扩展、派发/交付检查与顾问钩子，适合复杂多步任务；日常简单问答或小改动不需要这些额外检查。`omp-light` 在启动进程时叠加 `agent/config-light.yml` 与 `agent/APPEND_SYSTEM_LIGHT.md`，不改动磁盘上的配置文件：

| 配置项 | `omp`（完整模式） | `omp-light`（轻量模式） |
|---|---|---|
| 追加系统提示词 | `agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM_LIGHT.md`（空文件） |
| 环境变量 `OMOMP_MODE` | 未设置（视为 `full`） | `light`；[`append-system-model`](prompts-and-context.zh-CN.md#append-system-model) 片段用 `mode` / `exclude.mode` 按它选择，因此仓库自带的决策支持片段（`mode: full`）不注入 |
| `task.eager` | `preferred` | `default` |
| `bashInterceptor.enabled` | `true`（`config.yml` 的规则把 `cat`/`grep`/`find`/`sed -i`/`echo >` 等转向专用工具） | `false`：`bash` 直接执行这些命令，不拦截 |
| `disabledExtensions` | 无 | 禁用以下扩展：`fork-task`（插件 `omp-subagent-more` 的扩展入口）、`isolation-nudge`、`lang-nag`、`task-completion-judge`、`task-split-check`、`tool-policy-nag`、`turn-judge`、`user-prompt-inject`、`watchdog-agent` |
| `config.yml` 的 `extensions` 路径列表 | 加载 `extensions-last/system-prompt-replace` | `config-light.yml` 用自己的列表覆盖 `extensions`，同样最后加载 `extensions-last/system-prompt-replace`（其 `REPLACE-SYSTEM-*.yml` 规则用 `mode` / `exclude.mode` 区分模式，仓库自带规则写 `mode: full`）；`omp-light.ts` 读取本机 `config.yml`，把不含 `/extensions-last/` 的本机条目（如 `~/.claude`）通过 `-e` 传回 |
| 其余本地扩展 | 启用 | 保留：`append-system-model`、`argon-long-output`、`ast-top-level`、`child-memory-warning`、`delete-guard`、`harness-restart`、`input-polish`、`model-compaction`、`omomp-changelog`、`omomp-lang`、`omp-config-autoupdate`、`repo-rules`、`subagent-usage`、`tool-topics`、`wt-tool`（轻量模式下 OMP 自有工具的说明同样有表层文本与 `Topics` 索引；插件工具保留自身说明） |
| 已安装插件 | 全部加载 | 全部加载，除上面 `disabledExtensions` 列出的 `fork-task` 插件扩展入口外 |
| 轻量模式减少的本地工具 | — | 无（`fork_task` 是插件 `omp-subagent-more` 的工具，其 `fork-task` 扩展入口被 `config-light.yml` 禁用） |

**启动器安装**：`/update-omp` 和启动自动更新会把 `agent/omp-light.ts` 安装到 `PATH` 上 `omp` 所在目录（POSIX/macOS/Linux 为可执行文件 `omp-light`；Windows 为 `omp-light.ts` 加生成的 `omp-light.cmd`）。`omp-light` 从 `PI_CODING_AGENT_DIR`（未设置时为 `~/.omp/agent`）读取 `config-light.yml` 和 `APPEND_SYSTEM_LIGHT.md`，任一文件缺失即退出，其余命令行参数原样传给 `omp`。
