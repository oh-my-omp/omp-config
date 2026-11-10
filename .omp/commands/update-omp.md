---
description: 用本仓库工作区更新本机 OMP 配置（repo → 本机），保留本机定制并当场适配冲突
---

用当前仓库工作区（含未推送的改动）手动执行一次 repo → 本机更新，与 `/sync-omp-config` 方向相反。实际写入全部由更新器 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 完成，规则以它文件头的说明和代码为准；本命令只负责运行、补上脚本不做的插件卸载判断、报告结果。不使用 subagent，直接执行。

`omp-config-autoupdate` 扩展可以在每次 OMP 启动时从 GitHub 默认分支自动更新，但默认关闭，要执行 `/omp-config-autoupdate on` 打开。没打开时，repo → 本机靠本命令；打开后，本命令用于新机器首次安装更新器、自动更新报 `has no agent/omp-config-update.ts`（机器上还是更新器挪位置之前的旧版）时装上新位置的更新器，以及把未推送的本地改动先应用到本机。

`$ARGUMENTS`：
- 为空：执行更新。
- `check`：只读，报告会写入、移动、删除的文件、会保留的冲突和缺失的插件，并跑 `./plugin-audit.sh` 报告卸载候选；不写任何文件和基准，不装、升、卸插件，不做冲突适配。

## 步骤

1. 在仓库根目录运行：
   - 更新：`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source .`
   - `check`：`bun agent/extensions/omp-config-autoupdate/omp-config-update.ts apply --source . --check`

   agent 目录默认取 `PI_CODING_AGENT_DIR`，否则 `~/.omp/agent`；使用 named profile 时加 `--agent-dir <omp config path 的输出>`。脚本报告 `another update holds …` 时，说明有一次自动更新正在进行，稍后重跑。
   更新器先完整 preflight（含 `TODO_RETIREMENTS` 与 `CTX_RETIREMENTS` 的归属），再对每个必装声明插件执行 `omp install`（缺的补装，已装的升级），并重新向 OMP owner 核对 `omp-todo-more` 的 enabled、manifest entry 与实际入口；就绪后才写消费者并退休已知的旧 Todo 路径，ctx 路径还要求就绪插件携带 `src/ctx`，否则保留。插件无法安装或升级、disabled、坏 entry、app-managed/父链接/异常退休对象时不切换；退休归属出错会在安装插件前停止。报告 errors 时停止后续卸载、冲突适配和初始化项流程：保留实际部分结果，先修复并重跑；出现 `Cutover incomplete; do not restart OMP` 时不能重启混合状态。
   写入按更新器文件头的 CUSTOMIZATIONS 三方合并：本机没改过的受管项取工作区版本，改过的保留本机修改，文本文件两边都改时用 `git merge-file` 合并；`*.ts` 代码以仓库为准，被覆盖的本机修改列在 `overwrote customized code`。
   `agents/*.md` 子代理定义是本机级用户设置（更新器的 `MACHINE_OWNED_PLAIN`）：无基准记录时播种一次，本机未改仍随工作区更新和删除，本机改过的一律保留、不合并不报冲突，本机删掉或改名的不再重建。
   `thinking-translator.json` 不属于受管项：不会创建、重写或删除已有本机文件，旧结构化基准也不参与操作；翻译设置只参考 [插件 README](https://github.com/oh-my-omp/omp-thinking-translator#readme)。
   `omp-config` 插件的 `omp-config-autoupdate.exclude` 设置是本机设置（空白分隔的字符串，`/settings → Plugins → omp-config` 或 `omp plugin config` 读写）：列出的项（agent 目录相对路径/glob、结构化文件的 `file:字段路径`，以及 `omomp.yml:<section>` 让该段不参与 SETTINGS 迁移）在手动与自动更新中都不写、不建、不删，已记录的基准保持原样，报告里列为 skipped；无效条目让整个更新中止，写法示例见 `docs/operations.zh-CN.md` 的 `omp-config-autoupdate` 一节。
   更新器把 `extensions/_shared` link 为本机插件 `omp-config`（已在别处注册则保留并记 note），再把本机 `omomp.*`（yml/yaml/json；toml 无法改写则保留并记 note）里 omp-config 拥有的段一次性迁入它的插件设置：与 manifest 默认值不同的值写入设置，`judge.fallbackRole` 记 note 丢弃，已退役扩展的段（`doc-polish`）整段删除并记 note，其余 `fallbackRole` 在对应角色（`@<extension>`）尚未绑定时写成本机 `config.yml` `modelRoles` 里的 `@<role>` 引用，`task-split-check.agents` 写进对应 `agents/*.md` 的 `splitCheck: true` frontmatter，`model-compaction` 规则写成 `COMPACTION-*.md` 文件，`tool-topic-injection` 段与仓库自带规则相同才删除、不同则保留并记 note 提示手工迁到 TOPIC `inject:`。段缺失时才导入旧独立 JSON，成功后删除源。多个 omomp 文件带 omp-config 段、段无效或改写不安全时保留迁移源并记 note；omomp 文件只剩已迁移段时删除。`system-prompt-replace` 段/JSON 走它自己的迁移：与本机已接受基准或仓库某个已提交版本一致时移除，默认规则文件正常安装；仅定制规则转换并进入受管模板合并；目标占用、无效数据、歧义布局时保留迁移源并记 note，阻止默认模板安装。
2. 报告里有 `conflict (…), local copy kept: <id>` 时，与用户逐项适配：运行 `bun agent/extensions/omp-config-autoupdate/omp-config-update.ts conflicts --source .`（named profile 加同样的 `--agent-dir`），按它打印的步骤处理每个冲突，适配完用它给出的 `resolve --source .` 命令记录。用户选择以后再处理的冲突保持原样，在报告里列出。
3. 跑 `./plugin-audit.sh`，只处理 `[卸载候选]`：问用户是否 `omp plugin uninstall <name>`，并告知作者从脚本移除通常已经验证过，可以直接删。`[安装]` 已由更新器补装，`[保留]` 不动。没有安装任何插件时，审计仍正常输出分类报告并成功退出：`已安装` 为 `(无)`，`[安装]` 列出当前全部声明插件。
4. 报告脚本输出的写入、移动、删除、跳过（应用托管文件与 `omp-config-autoupdate.exclude` 列出的本机排除项）、被覆盖的代码修改、冲突及其适配结果、插件链接与 omomp 段迁入插件设置的结果（含记 note 保留的段）、安装和升级的插件、note 和 error，以及卸载结果。

## 手动更新与自动更新的差别

- 手动更新做 RELOCATIONS 的删除/移动及插件就绪后的精确退休（见更新器文件头）：旧平铺扩展、旧位置结构化配置和数据按迁移规则处理；根目录 `PROMPT-INJECT-*` / `TURN-JUDGE-*` 仓库模板仅在等于旧路径或新路径的仓库自带版本或本机已接受版本时删除，定制模板保留并记 note 提醒移植，符号链接不移动。`TODO_RETIREMENTS`、`CTX_RETIREMENTS` 与 `FORK_RETIREMENTS` 都在安装插件前预检归属；声明的 Todo 插件就绪后仅 unlink `TODO_RETIREMENTS` 列出的叶文件，`CTX_RETIREMENTS` 还要求就绪插件携带 `src/ctx`，否则保留；`FORK_RETIREMENTS` 在声明的 omp-subagent-more 插件就绪后同样 unlink。不删除目录、host-owned、app-managed 或链接 backing。其余删除与自动更新相同，依据记录的基准：基准里有、工作区已删除的受管文件，本机未改就删除，改过就报告冲突。本机还没有基准时，源中早已删除的文件保留：那需要自动更新才有的“上次应用的提交”。
- 手动更新不改写 `<agent 目录>/.omp-config-applied`，但会把基准记录为工作区版本。自动更新开着时，下次启动只要 GitHub 默认分支的提交与 `.omp-config-applied` 不同就会运行：本机此后没改过的项更新为 GitHub 版本，包括手动应用、尚未推送的内容；本机此后改过的项按定制合并或报告冲突。推送并合并后再启动即可保持一致。
- 自动更新遇到配置提交未变化时仍刷新 `install-plugins.sh` 中不带 `#ref` 的 GitHub 必装项及已安装的可选项。已安装源按 owner/repo 匹配，兼容 `github:`、HTTPS 与 Git URL 形式；npm 条目和带固定引用的 URL 等到配置提交变化时再更新。手动更新每次都安装或升级必装声明插件。
- `omomp` 段的迁移属于更新器本身，随每次 apply 检查一次；`--check` 与 `--no-plugins` 只报告不写。

## 生效时机

报告结束时，只有无 errors 且实际 `restartNeeded` 时提醒重启；出错先修复并重跑完整更新，不把部分切换当成完成。`SYSTEM_TEMPLATE.md`、`APPEND_SYSTEM.md`、`PERSONALITY.md`、扩展、`extensions/tool-topics/TOPIC-*.md` 与 `SURFACE-*.md`、插件在下次启动时加载；`config.yml` 与 `omp-light` 通过 `--config` 加载的 `config-light.yml` 由 OMP 实时重载，但不会重跑启动工作，进程从未导入的扩展源仍需重启；`omp-config` 插件的 `omomp-lang.language` 设置（界面语言）在下次启动时生效；`extensions/append-system-model/APPEND-SYSTEM-*.md`、`extensions-last/system-prompt-replace/REPLACE-SYSTEM-*.yml` / `REPLACE-SYSTEM-*.yaml` 从下一条 prompt 或下一次工具调用开始生效；`extensions/argon-long-output/ARGON_PROMPT.md` 从下一条 prompt 或下一次工具调用开始生效；`extensions/turn-judge/TURN-JUDGE-*.md` 从其 `target` 所指会话的下一轮结束时开始生效；`tool-policy-nag.*` 设置从下一次 shell / eval 调用开始生效（`pty` 通道在主会话和子会话，其余通道只在主会话）；`agents/*.md` frontmatter 的 `splitCheck` / `completionJudge` 从下一次 `task` 派发开始生效；`child-memory-warning.thresholdGiB` 从下一次 2 s 采样开始生效（项目 `.omp/plugin-overrides.json` 的同名设置优先）；`extensions/user-prompt-inject/PROMPT-INJECT-*.md` 和 `agents/` 从下一个派出的 subagent 开始生效。适配冲突时改过的文件按同样的时机生效。删除或移动了扩展文件时同样要重启，先确保更新完整成功。
