# extensions-last

English | [简体中文](README.zh-CN.md)

The extensions here must run after every other path-loaded extension, so they are not placed in `extensions/`; instead `config.yml`'s `extensions` loads them by path, as the last entry of the list. Each extension is one directory with `<name>/index.ts` as its entry; its configuration is files beside `index.ts` (`system-prompt-replace` reads `REPLACE-SYSTEM-*.yml`) or an `omp-config` plugin setting named after the directory. `config.yml` holds the full path of `index.ts` (a file path rather than the directory, so it loads as it did when flat, and `disabledExtensions` cannot filter it by name). Shared code is imported from `../../extensions/_shared/`.

`system-prompt-replace/` states wording-level edits of the rendered prompt, including sentences inside `toolInventory` and `xdevDocs` tool descriptions, from its `REPLACE-SYSTEM-*.yml` rule files, as a delta message beside the prompt; it changes neither the prompt nor the separately transmitted tool schemas, and whole tool descriptions belong to the `tool-topics` extension, which runs earlier. For prompt-layer ownership and the rule format, see [system-prompt-replace](../../docs/prompts-and-context.md#system-prompt-replace).

## Load order

`before_agent_start` handlers run serially in load order, each receiving the system prompt the previous one returned; a path loads only at its first occurrence. Not every event is serial: `session_shutdown` handlers, for example, run concurrently.

1. Native discovery: `~/.omp/agent/extensions/`, plus the TS/JS modules listed in `settings.json`'s `extensions` (whether or not `config.yml` exists; its extension package roots are read only when there is no `config.yml`)
2. hooks
3. Plugin extensions
4. `-e` arguments
5. `config.yml`'s `extensions`, in list order
6. OMP's built-in inline extensions: SDK-supplied extensions, autoresearch, the wrapper for custom tools such as `.omp/tools/`

Step 6 still runs after the extensions here; autoresearch rewrites the system prompt in `/autoresearch` mode.

There is no ordering inside `extensions/`: the order is whatever the native glob walk returns, not directory-name order. A directory from here placed in `extensions/` would load in step 1, and the `config.yml` entry pointing at the same path would be dropped as a duplicate.

In light mode, `config-light.yml` replaces `extensions` with its own list, which keeps `system-prompt-replace` as the last entry; `omp-light` then passes the entries of the machine's `config.yml` that are not under `extensions-last/` (such as `~/.claude`) back with `-e`, a lane that loads before `config.yml` `extensions`.

This file and `README.zh-CN.md` are never loaded and never synced: the repo → machine updater (automatic update at startup and `/update-omp`) and `/sync-omp-config` sync only the `*.ts` and shipped templates (such as `REPLACE-SYSTEM-*.yml`) in extension directories, the plugin manifest and the structured `config.yml`.
