---
description: 把本机 ~/.omp/agent 配置同步进本仓库快照（单向）
---

把本机 `~/.omp/agent`（先展开为绝对路径）单向同步到仓库 `agent/`，再提交推送。只读本机，绝不写 `~/.omp`、`omp` 安装目录、PATH 或 shell 配置；本机文件 mtime 前后不变。不使用 subagent，直接执行。

`$ARGUMENTS`：为空执行完整流程；`check` 只做第 1 步并报告差异。

## 同步范围

本机 `~/.omp/agent` 与仓库 `agent/` 按同名一一对应，范围与更新器 `agent/extensions/omp-config-autoupdate/omp-config-update.ts` 的 `managedPlain` 和 `STRUCTURED` 一致，改一边就要改另一边：

- 根目录：`config.yml`、`SYSTEM_TEMPLATE.md`、`APPEND_SYSTEM.md`、`PERSONALITY.md`、`thinking-translator.json`、`config-light.yml`、`APPEND_SYSTEM_LIGHT.md`、`omp-light.ts`，以及 `agents/` 整个目录。
- 扩展目录里只有这些属于仓库：`extensions/<名字>/*.ts`（含 `extensions/_shared/*.ts` 和更新器 `extensions/omp-config-autoupdate/omp-config-update.ts`）、`extensions-last/<名字>/*.ts`、`extensions/user-prompt-inject/PROMPT-INJECT-*.md`、`extensions/turn-judge/TURN-JUDGE-*.md`、`extensions/tool-policy-nag/INTENT-*.md`、`extensions/tool-topics/TOPIC-*.md`、`extensions/tool-topics/SURFACE-*.md`。扩展配置不在扩展目录里，统一放在 `agent/omomp.yml`（见下）。
- 统一扩展配置 `agent/omomp.yml` ↔ `~/.omp/agent/omomp.yml`：结构化文件，每个扩展一段，段名是扩展目录名；多个扩展共用的 `_shared` 模块按文件名占一段（`judge`）。仓库段为 `omomp-lang`、`judge`、`lang-nag`、`input-polish`、`tool-policy-nag`、`task-completion-judge`、`task-split-check`、`child-memory-warning`、`tool-topic-injection`、`system-prompt-replace`。本机段（`doc-polish`、`model-compaction`、`omp-config-autoupdate`）由更新器的 `LOCAL_OMOMP_SECTIONS` 列出，两个方向都不收回、不写入。
- 扩展目录里的其他文件属于本机，不收回：`extensions/append-system-model/APPEND_SYSTEM_MODEL.md`、`extensions/watchdog-agent/WATCHDOG-*.md`，以及仓库没有的同名模式模板。
- 已退休的 Todo 源码不收回，即使旧机器仍有文件，也不进入“仓库缺失/不同/已删除”候选：`extensions/todo-more/index.ts`、`tool.ts`、`render.ts`、`reminders.ts`、`planning.ts`（后四个同属 `extensions/todo-more/`），`extensions/_shared/todo-more.ts`、`extensions/subagent-todo.ts`、`extensions/subagent-todo/index.ts`。已迁入 omp-todo-more 的 ctx 源码同样不收回：`extensions/ctx-tool/index.ts`、`inventory.ts`、`post-compact-hint.ts`、`extensions/ctx-tasklog/index.ts`、`extensions/_shared/task-log.ts`。被 `extensions/tool-topics/` 取代的 `extensions/read-topics/index.ts` 也不收回，本机残留由 `/update-omp` 删除。独立插件的安装只按第 3 步处理，不复制其 package 或内部 reader。

本机 `settings.json` 不在范围内：`config.yml` 存在时 OMP 不再把它的 `extensions` 当扩展包根目录，但其中的 TS/JS 扩展模块条目照样加载，属于本机。

插件状态不在范围内：`pi-bansos` 的 `~/.pi/agent/pi-bansos-relay-state.json` 由 `/bansos` 命令维护，属于本机，不收回仓库。

不进仓库：
- 运行时文件：`*.db*`、`*-wal`、`*-shm`、`*.lock`、`models.yml`、`models.yml.bak-*`、`commandcode-models.json`、`last-changelog-version`、`sessions/`、`terminal-sessions/`、`blobs/`、`cache/`、`logs/`，以及更新器的记录 `.omp-config-applied` 和基准目录 `.omp-config-base/`。本机开关是 `omomp.yml` 里的 `omp-config-autoupdate` 段，同样不收回。
- `omp` 安装目录里的 `omp-light`、`omp-light.ts`、`omp-light.cmd`；light 三件只从 `~/.omp/agent` 取。
- 应用托管的扩展：首行为 `// @orca-managed-pi-extension`，或任意位置含 `marker: _otty`。以标记为准，不凭文件名判断。
- 结构化配置中的本机路径与播种路径，仓库保留原值：即更新器的 `LOCAL_CONFIG_FIELDS`、`SEED_CONFIG_FIELDS`（`config.yml`）、`LOCAL_OMOMP_SECTIONS`、`SEED_OMOMP_FIELDS`（`omomp.yml`）与 `SEED_TRANSLATOR_FIELDS`（`thinking-translator.json`）。更新器从不写本机路径；播种路径只在本机缺少时写入一次，之后归本机，所以本机的值不代表仓库默认值。要改仓库默认值，直接改仓库。
- `config.yml` 中本机列表的本机条目：更新器的 `MACHINE_LIST_FIELDS`（`extensions`）里，仓库列表没有的条目（例如 `~/.claude`）属于本机，不写进仓库。这类列表只比对仓库已有的条目：本机删掉的，从仓库删除。要给仓库加新条目，直接改仓库。

## 步骤

0. 本机还是平铺布局时停止：`~/.omp/agent/extensions/` 下直接有本仓库扩展同名的 `.ts`（不含应用托管文件和上述退休 Todo 路径），或 `~/.omp/agent/extensions-last/system-prompt-replace.ts` 存在。报告这些文件，要求先执行 `/update-omp` 迁移本机，不比对、不写仓库：拿平铺布局和仓库比对会把仓库的整套目录误判为本机已删除。
1. 按上面的范围逐文件比对，列出仓库缺失、内容不同、本机已删除的差异；扩展目录按范围里的文件类型逐个比对，不用整目录 `diff -rq`。`extensions-last/README.md` 和 `extensions-last/README.zh-CN.md` 只存在于仓库，不算本机已删除。同时比对第 3 步的插件列表。文件和插件列表都没有差异时，报告已同步并结束。
2. 把差异写入仓库。结构化配置（`config.yml`、`omomp.yml`、`thinking-translator.json`）先 `read` 两边、比出有差异的字段，再用 `edit` 只改这些行，不整文件覆盖、不重新序列化；本机路径、播种路径和本机列表条目不写。
3. `~/.omp/plugins/package.json` 的依赖与 `install-plugins.sh` 的列表不一致时，重写列表：URL/Git 依赖原样保留，npm 依赖去掉版本号。列表里注释掉的条目是可选插件，本机装了也保持注释、不改成有效条目，也不算差异。
4. 校验：
   - 普通文件与本机 `cmp` 一致；结构化配置除本机路径、播种路径和本机列表条目外，与本机逐字段一致。
   - `config.yml`、`config-light.yml`、`omomp.yml` 能用 `Bun.YAML.parse` 解析，`thinking-translator.json` 能用 `JSON.parse` 解析；`bun run check` 通过（收回的扩展代码要能过格式、lint 和类型检查）。
   - 仓库里没有明文凭据：`sk-`、`ghp_`、超长的 `apiKey:` 值。
   - `git status --short` 里没有运行时文件、插件运行时文件或已安装入口。
5. 提交并推送，commit message 用 `chore: sync snapshot with local omp config`，正文列出本机实际变化。
