---
description: 把本机 ~/.omp/agent 配置同步进本仓库快照（单向）
---

把本机 `~/.omp/agent`（先展开为绝对路径）单向同步到仓库 `agent/`，再提交推送。只读本机，绝不写 `~/.omp`、`omp` 安装目录、PATH 或 shell 配置；本机文件 mtime 前后不变。不使用 subagent，直接执行。

`$ARGUMENTS`：为空执行完整流程；`check` 只做第 1 步并报告差异。

## 同步范围

本机 `~/.omp/agent` 与仓库 `agent/` 按同名一一对应，范围与更新器 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 的 `managedPlain` 和 `STRUCTURED` 一致，改一边就要改另一边：

- 根目录：`config.yml`、`SYSTEM_TEMPLATE.md`、`APPEND_SYSTEM.md`、`PERSONALITY.md`、`config-light.yml`、`APPEND_SYSTEM_LIGHT.md`、`omp-light.ts`，以及 `agents/` 目录下的 `.txt` 文件（如 `README*.txt`）。
- 扩展目录里只有这些属于仓库：`extensions/<名字>/*.ts`（含 `extensions/_shared/*.ts` 和更新器 `extensions/omp-config-autoupdate/omp-config-update.ts`）、`extensions/_shared/package.json`（`omp-config` 插件 manifest，`omp.settings` 声明全部扩展设置及默认值）、`extensions-last/<名字>/*.ts`、`extensions/user-prompt-inject/PROMPT-INJECT-*.md`、`extensions/turn-judge/TURN-JUDGE-*.md`、`extensions/tool-policy-nag/INTENT-*.md`、`extensions/tool-topics/TOPIC-*.md`、`extensions/tool-topics/SURFACE-*.md`、`extensions/append-system-model/APPEND-SYSTEM-*.md`、`extensions-last/system-prompt-replace/REPLACE-SYSTEM-*.yml` / `REPLACE-SYSTEM-*.yaml`、`extensions/argon-long-output/ARGON_PROMPT.md`。
- 扩展的实际设置值是本机状态，不进仓库也不收回：它们是 `omp-config` 插件设置（`/settings → Plugins → omp-config` 或 `omp plugin config` 读写，项目级覆盖在 `<项目>/.omp/plugin-overrides.json`），以及各对象的自有数据（`agents/*.md` frontmatter、`TOPIC-*.md` 的 `inject:`、`COMPACTION-*.md`）。本机还留有 `omomp.*` 文件或旧独立 JSON 时不收回；先执行 `/update-omp`，更新器把其中 omp-config 拥有的段一次性迁入插件设置，无法迁入的保留并记 note。
- 扩展目录里的其他文件属于本机，不收回：`extensions/watchdog-agent/WATCHDOG-*.md`，以及仓库没有的同名模式模板（如本机自建或由旧 `APPEND_SYSTEM_MODEL.md` 拆出的 `APPEND-SYSTEM-*.md`）。`subagent-usage` 的本机数据（`subagent-usage/calibration.json` 与 `cache/subagent-usage/`）同样属于本机，不收回。
- 已退休的 Todo 源码不收回，即使旧机器仍有文件，也不进入“仓库缺失/不同/已删除”候选：`extensions/todo-more/{index,tool,render,reminders,planning}.ts`、`extensions/_shared/todo-more.ts`、`extensions/subagent-todo.ts`、`extensions/subagent-todo/index.ts`。已迁入 omp-todo-more 的 ctx 源码同样不收回：`extensions/ctx-tool/index.ts`、`inventory.ts`、`post-compact-hint.ts`、`extensions/ctx-tasklog/index.ts`、`extensions/_shared/task-log.ts`。被 `extensions/tool-topics/` 取代的 `extensions/read-topics/index.ts` 也不收回，本机残留由 `/update-omp` 删除。已退役的本地 fork-task 源码同样不收回：`extensions/fork-task/{index,replica,replica-file,source-channel,sweep,topics,workspace}.ts`、`extensions/fork-task.ts`。Todo/ctx 退休由更新器预检归属，ctx 叶文件仅在就绪插件携带 `src/ctx` 时删除，否则保留；fork 叶文件仅在就绪的 omp-subagent-more 插件就位后删除。独立插件的安装只按第 3 步处理，不复制其 package 或内部 reader。

本机 `settings.json` 不在范围内：`config.yml` 存在时 OMP 不再把它的 `extensions` 当扩展包根目录，但其中的 TS/JS 扩展模块条目照样加载，属于本机。

插件配置与状态不在范围内：`thinking-translator.json` 属于插件与本机，既不收回也不由更新器写入或删除；设置见 [插件 README](https://github.com/oh-my-omp/omp-thinking-translator#readme)。`pi-bansos` 的 `~/.pi/agent/pi-bansos-relay-state.json` 同样属于本机，不收回仓库。

不进仓库：
- 运行时文件：`*.db*`、`*-wal`、`*-shm`、`*.lock`、`models.yml`、`models.yml.bak-*`、`last-changelog-version`、`sessions/`、`terminal-sessions/`、`blobs/`、`cache/`、`logs/`，以及更新器的记录 `.omp-config-applied` 和基准目录 `.omp-config-base/`。本机开关是 `omp-config` 插件的 `omp-config-autoupdate.enabled` 设置，同样不收回。
- `omp` 安装目录里的 `omp-light`、`omp-light.ts`、`omp-light.cmd`；light 文件只从 `~/.omp/agent` 取。
- 应用托管的扩展：首行为 `// @orca-managed-pi-extension`，或任意位置含 `marker: _otty`。以标记为准，不凭文件名判断。
- 结构化配置中的本机路径与播种路径，仓库保留原值：即更新器的 `LOCAL_CONFIG_FIELDS`、`SEED_CONFIG_FIELDS`（`config.yml`）。更新器从不写本机路径；播种路径只在本机缺少时写入一次，之后归本机，所以本机的值不代表仓库默认值。要改仓库默认值，直接改仓库。
- `config.yml` 中本机列表的本机条目：更新器的 `MACHINE_LIST_FIELDS`（`extensions`、`disabledProviders`）里，仓库列表没有的条目（例如 `~/.claude`）属于本机，不写进仓库。这类列表只比对仓库已有的条目：本机删掉的，从仓库删除。要给仓库加新条目，直接改仓库。
- `agent/agents/*.md` 子代理定义是本机级用户设置：更新器按 `MACHINE_OWNED_PLAIN` 处理——本机从未记录过该文件时播种一次仓库默认值，之后本机没改仍随仓库更新和删除，本机改过的一律保留、不参与合并和冲突，本机删掉或改名的不再重建，本机自建的 `.md` 也只登记存在、不回写。本机的副本（改动、重命名、删除、自建）都不比对、不收回；要改仓库默认值，直接改仓库。

## 步骤

0. 本机还是平铺布局时停止：`~/.omp/agent/extensions/` 下直接有本仓库扩展同名的 `.ts`（不含应用托管文件和上述退休路径），或 `~/.omp/agent/extensions-last/system-prompt-replace.ts` 存在。报告这些文件，要求先执行 `/update-omp` 迁移本机，不比对、不写仓库：拿平铺布局和仓库比对会把仓库的整套目录误判为本机已删除。根目录残留的 `PROMPT-INJECT-*` / `TURN-JUDGE-*` 不收回：更新器仅删除内容等于旧路径或新路径的仓库自带或本机已接受版本的模板；定制模板保留并记 note，需先移植。
1. 按上面的范围逐文件比对，列出仓库缺失、内容不同、本机已删除的差异；扩展目录按范围里的文件类型逐个比对，不用整目录 `diff -rq`。`extensions-last/README.md` 和 `extensions-last/README.zh-CN.md` 只存在于仓库，不算本机已删除。同时比对第 3 步的插件列表。文件和插件列表都没有差异时，报告已同步并结束。
2. 把差异写入仓库。结构化配置（`config.yml`）先 `read` 两边、比出有差异的字段，再用 `edit` 只改这些行，不整文件覆盖、不重新序列化；本机路径、播种路径和本机列表条目不写。
3. `~/.omp/plugins/package.json` 的依赖与 `install-plugins.sh` 的列表不一致时，重写列表：URL/Git 依赖原样保留，npm 依赖去掉版本号。列表里注释掉的条目是可选插件，本机装了也保持注释、不改成有效条目，也不算差异。
4. 校验：
   - 普通文件与本机 `cmp` 一致；结构化配置除本机路径、播种路径和本机列表条目外，与本机逐字段一致。
   - `config.yml`、`config-light.yml` 能用 `Bun.YAML.parse` 解析；`bun run check` 通过（收回的扩展代码要能过格式、lint 和类型检查）。
   - 仓库里没有明文凭据：`sk-`、`ghp_`、超长的 `apiKey:` 值。
   - `git status --short` 里没有运行时文件、插件运行时文件或已安装入口。
5. 提交并推送，commit message 用 `chore: sync snapshot with local omp config`，正文列出本机实际变化。
