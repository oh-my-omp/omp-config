# omp-config

English | [简体中文](README.zh-CN.md)

`omp-config` is the Oh My Pi (`omp`) runtime configuration and extension repository that turns frontier LLMs from free-form chat generators into a governed, multi-tier engineering state machine. It tracks only reviewable, deterministically replayable policy, prompts, subagent definitions and local TypeScript extensions; databases (`*.db*`), session transcripts, model caches, logs, lock files, installed plugin packages (`~/.omp/plugins/`) and provider credentials never enter the repository.

## Wiki Navigation

| Page | Scope |
|---|---|
| **[1. System Thesis & Control Architecture](docs/architecture.md)** | Four control premises, runtime control flowchart, and the 20-row Failure-Mode & Runtime Countermeasure Matrix |
| **[2. Prompt Layers & Context Economics](docs/prompts-and-context.md)** | Four-layer prompt separation (`SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `APPEND_SYSTEM.md`), `system-prompt-replace`, `append-system-model`, `repo-rules`, `fork-task`, `model-compaction`, `ctx`, and task log recovery |
| **[3. Multi-Agent Topology & Advisors](docs/agents.md)** | The 7 custom subagents and model bindings, anti-echo-chamber advisors (`user-prompt-inject`, `discuss:steady` vs `discuss:divergent`, tool-less `mentor:default`), dispatch economics, and parallel-write worktree isolation |
| **[4. Runtime Gates, Sideband Judges & Extensions](docs/extensions.md)** | Pre-dispatch/pre-yield hard gates, shared native `JUDGE` sideband monitors, host/TUI tools, and the 22-row [Local Extensions Index](docs/extensions.md#local-extensions-index) |
| **[5. Plugins & Dual Runtime Modes](docs/plugins-and-modes.md)** | The 8 required + 2 optional external plugins (`omp-todo-more`, `omp-thinking-translator`, etc.) and Full mode (`omp`) vs Light mode (`omp-light`) |
| **[6. Sync, Operations & Engineering](docs/operations.md)** | Repo ↔ machine ownership matrix, two one-way sync workflows, `omp-config-autoupdate`, `_shared` extension infrastructure, CI check, and upgrade checklist |
| **[CI Configuration Check (`ci/README.md`)](ci/README.md)** | Keyless real-session RPC verification (`bun ci/check.ts`), shadow model wiring, and diagnostic deduplication |
| **[Trailing Extensions (`agent/extensions-last/README.md`)](agent/extensions-last/README.md)** | Extension load-order rules and why `system-prompt-replace` lives outside `agent/extensions/` |
| **[Subagent Authoring Notes (`agent/agents/README.txt`)](agent/agents/README.txt)** | Subagent frontmatter, `spawns` allowlists, depth-2 recursion limits, and `yield` pitfalls |

## Quick Start & Commands

Run slash maintenance commands inside `omp` started at the repository root:

```text
/update-omp [check]                          # repo working tree -> machine (~/.omp/agent, ~/.pi/agent, omp-light, plugins)
/sync-omp-config [check]                     # machine -> repo (field-level diff & edit, validate, commit & push)
/omp-config-autoupdate [status|on|off|run]   # machine-local startup auto-update switch (off by default) or immediate GitHub update
/migrate-omp-keys <target>                   # copy auth_credentials table to a remote host's agent.db over SSH
```

Shell and verification commands from the repository root:

```bash
omp                           # Full mode: all 22 local extensions, dispatch/yield gates, sideband judges, and advisors
omp-light                     # Light mode: skips 10 optional governance extensions and system-prompt-replace
bun run check                 # Biome format/lint + strict tsc --noEmit over agent/**/*.ts and ci/**/*.ts
./plugin-audit.sh             # Read-only diff of install-plugins.sh vs `omp plugin list`
bun ci/check.ts               # Isolated HOME install + real full/light RPC session check on a free model
```

For brand-new machine setup, manual empty-machine bootstrap, and the repo ↔ machine ownership matrix, see **[Sync, Operations & Engineering](docs/operations.md#operational-workflows)**.

## Component Directory

| Category | Components & Direct Wiki Links |
|---|---|
| **Prompts & Rules** | [`SYSTEM_TEMPLATE.md`](docs/prompts-and-context.md#four-layer-prompt-separation) · [`PERSONALITY.md`](docs/prompts-and-context.md#four-layer-prompt-separation) · [`APPEND_SYSTEM.md`](docs/prompts-and-context.md#four-layer-prompt-separation) · [`system-prompt-replace`](docs/prompts-and-context.md#system-prompt-replace) · [`append-system-model`](docs/prompts-and-context.md#append-system-model) · [`repo-rules`](docs/prompts-and-context.md#repo-rules) |
| **Context & Recall** | [`fork-task`](docs/prompts-and-context.md#fork-task) · [`model-compaction`](docs/prompts-and-context.md#model-compaction) · [`ctx`](docs/prompts-and-context.md#ctx) · [`Task log`](docs/prompts-and-context.md#task-log) · [`After-compact injection`](docs/prompts-and-context.md#after-compact-injection) |
| **Subagents & Advisors** | [`task:high` · `task:mid` · `task:low` · `task:free`](docs/agents.md#the-seven-custom-subagents-and-model-binding-matrix) · [`discuss:steady` · `discuss:divergent` · `mentor:default`](docs/agents.md#the-seven-custom-subagents-and-model-binding-matrix) · [`user-prompt-inject`](docs/agents.md#user-prompt-inject) |
| **Dispatch & Yield Gates** | [`isolation-nudge`](docs/extensions.md#isolation-nudge) · [`task-split-check`](docs/extensions.md#task-split-check) · [`task-completion-judge`](docs/extensions.md#task-completion-judge) |
| **Sideband Judges** | [`tool-policy-nag`](docs/extensions.md#tool-policy-nag) · [`watchdog-agent`](docs/extensions.md#watchdog-agent) · [`turn-judge`](docs/extensions.md#turn-judge) · [`lang-nag`](docs/extensions.md#lang-nag) |
| **Host, TUI & Sync Extensions** | [`child-memory-warning`](docs/extensions.md#child-memory-warning) · [`input-polish`](docs/extensions.md#input-polish) · [`doc-polish`](docs/extensions.md#doc-polish) · [`wt-tool`](docs/extensions.md#wt-tool) · [`harness-restart`](docs/extensions.md#harness-restart) · [`commandcode-model-spec`](docs/extensions.md#commandcode-model-spec) · [`antigravity-wire-profiles`](docs/extensions.md#antigravity-wire-profiles) · [`omomp-lang`](docs/extensions.md#omomp-lang) · [`omp-config-autoupdate`](docs/operations.md#omp-config-autoupdate) |
| **External Plugins** | [`omp-todo-more`](docs/plugins-and-modes.md#todo-more) · [`omp-thinking-translator`](docs/plugins-and-modes.md#thinking-translation) · [`omp-unified-exec` · `pi-bansos` · `pi-commandcode-provider` · `omp-codex-image-gen` · `pi-package-search` · `pi-pretty-codeblocks` · `omp-remote-build` · `omp-playbooks`](docs/plugins-and-modes.md#plugin-ecosystem-and-external-capabilities) |
