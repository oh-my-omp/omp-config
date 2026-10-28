---
tool: write
name: archive
title: Writing a member inside an archive
when: before adding or replacing a file inside a zip, jar, tar, tar.gz, tar.zst or asar archive
upstream: pi-coding-agent@18.13.2 src/tools/write.ts, pi-utils src/ar/write.ts, src/ar/limits.ts, omp://tools/write.md § Archive entry
---
# Writing a member inside an archive

- Path: `<archive>:<member/path>`, e.g. `dist/app.zip:config/settings.json`. Only that member is replaced or added; the whole archive is rewritten atomically. A missing archive is created (with its parent directories).
- Writable containers: ZIP and its aliases (`.jar`, `.war`, `.ear`, `.apk`, `.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, `.asar`. `.7z`, `.rar`, `.tar.bz2`, `.tar.xz`, ISO and CAB are read-only.
- Member path: `\` becomes `/`, empty and `.` segments are dropped, `..` and a trailing `/` are rejected.
- Empty content for a member that does not exist is refused (it looks like a mistyped read selector).
- Replacing a member with text that ends in a read-truncation notice and is shorter than the original is refused: read the whole member first.
- Limits: 64 MiB per member, 256 MiB archive in memory.
