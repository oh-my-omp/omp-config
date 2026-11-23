---
tool: write
name: archive
title: Writing a member inside an archive
when: before adding or replacing a file inside a zip, jar, tar, tar.gz, tar.zst or asar archive
upstream: pi-coding-agent@19.1.1 src/tools/write.ts, pi-utils src/ar/write.ts, pi-utils src/ar/limits.ts, omp://tools/write.md § Archive entry
---
# Writing a member inside an archive

- Path: `<archive>:<member/path>`, e.g. `dist/app.zip:config/settings.json`. Only that member is replaced or added; the whole archive is rewritten atomically. A missing archive is created (with its parent directories).
- Writable containers: ZIP and its aliases (`.jar`, `.war`, `.ear`, `.apk`, `.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, `.asar`. `.7z`, `.rar`, `.tar.bz2`, `.tar.xz`, ISO and CAB are read-only.
- Member path: `\` becomes `/`, empty and `.` segments are dropped, `..` and a trailing `/` are rejected.
- Empty writes to missing selector-shaped members are refused as mistyped read selectors.
- Replacing an existing member with text ending in a read-truncation notice is refused when shorter than the original, and a column-cap truncation notice (`…` cut lines) is refused at any length: read the full member (with `:raw` for long lines) first.
- Limits: 64 MiB per member, 256 MiB archive in memory.
