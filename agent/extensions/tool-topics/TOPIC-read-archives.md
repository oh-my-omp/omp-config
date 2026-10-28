---
tool: read
name: archives
title: Reading inside archives
when: before looking inside a zip, jar, wheel, tar(.gz/.bz2/.xz/.zst), 7z, rar, deb, rpm or similar archive
upstream: pi-coding-agent@18.13.2 src/tools/read-archive.ts, pi-utils src/ar/limits.ts, omp://tools/read.md § Archives
---
# Reading inside archives

- No unpacking needed: `a.zip` lists the root, `a.zip:dir/` a directory, `a.zip:dir/file.txt` a member, `a.zip:dir/file.txt:50-60` member lines (all text selectors apply).
- Formats: ZIP family (`.zip .jar .war .ear .apk .whl .ipa .xpi .vsix .nupkg .cbz`), tar (`.tar .tar.gz/.tgz .tar.bz2 .tar.xz .tar.zst .tar.z`), `.7z .rar/.cbr .iso .cab .cpio .rpm .deb .ar/.a/.lib .lzh .arj .asar`, and single compressed streams (`.gz .bz2 .xz .zst .lzma`).
- Listings show immediate children with sizes, 500 entries per page: `a.zip:500` continues, `a.zip:-50` shows the last 50.
- Text members must be UTF-8; binary members return `[Cannot read binary archive entry …]`. A PDF member converts to Markdown, and `a.zip:doc.pdf:page2.png` renders one page.
- `..` in member paths is rejected. A member that does not exist: `Path … not found inside archive`.
- Limits: 64 MiB per member, 256 MiB in memory for a whole container, 1,000,000 entries.
