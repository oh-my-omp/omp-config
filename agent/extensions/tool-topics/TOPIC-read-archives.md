---
tool: read
name: archives
title: Reading inside archives
when: before looking inside a zip, jar, wheel, tar(.gz/.bz2/.xz/.zst), 7z, rar, deb, rpm or similar archive
upstream: pi-coding-agent@19.1.1 src/tools/read-archive.ts, pi-utils src/ar/registry.ts, pi-utils src/ar/limits.ts, omp://tools/read.md § Archives
inject:
  - id: read-archives
    tool: read
    parameter: path
    pattern: '\.(zip|jar|war|ear|whl|apk|ipa|xpi|vsix|nupkg|cbz|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|z|lzma|7z|rar|cbr|cab|cpio|deb|rpm|ar|a|lib|lzh|lha|arj|iso|asar)(:|$)'
---
# Reading inside archives

- No unpacking needed: `a.zip` lists the root, `a.zip:dir/` a directory, `a.zip:dir/file.txt` a member, `a.zip:dir/file.txt:50-60` member lines (all text selectors apply).
- Formats: ZIP family (`.zip .jar .war .ear .apk .whl .ipa .xpi .vsix .nupkg .cbz`), tar (`.tar .tar.gz/.tgz .tar.bz2/.tbz2/.tbz .tar.xz/.txz .tar.zst/.tzst .tar.z`), `.7z .rar/.cbr .iso .cab .cpio .rpm .deb .ar/.a/.lib .lzh/.lha .arj .asar`, and single compressed streams (`.gz .bz2 .xz .zst .z .lzma`). ZIP-container documents (`.docx .xlsx .pptx .epub`, plus `.docm .dotx .xlsm .pptm .odt .ods .odp`) also accept `:member/path` reads without unpacking.
- Listings show immediate children with sizes, 500 entries per page: `a.zip:500` continues, `a.zip:-50` shows the last 50.
- Text members must be UTF-8 and accept JSON queries (`a.zip:data.json?q=.x`, plus trailing line selectors). Image members decode as inline images when read bare; other unsupported binary members return `[Cannot read binary archive entry …]`. A PDF member converts to Markdown, and `a.zip:doc.pdf:page2.png` renders one page.
- `..` in member paths is rejected. A member that does not exist: `Path … not found inside archive`.
- Limits: 64 MiB per member, 256 MiB in memory for whole-buffer containers (plain `.tar` indexes via byte ranges and bypasses the 256 MiB container cap), 1,000,000 entries.
