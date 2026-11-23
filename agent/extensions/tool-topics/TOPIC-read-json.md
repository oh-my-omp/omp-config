---
tool: read
name: json
title: Querying JSON with jq
when: before extracting fields from JSON/JSONL/NDJSON (instead of reading it whole or parsing it in a script)
upstream: pi-coding-agent@19.1.1 src/tools/read-json.ts, src/tools/fetch.ts, src/tools/read-archive.ts, omp://tools/read.md § JSON queries
inject:
  - id: read-json
    tool: read
    parameter: path
    pattern: '\.(json|jsonl|ndjson)(\?|:|$)'
---
# Querying JSON with jq

- `file.json?q=<jq filter>` (also `query=`) runs an embedded jq on the file; JSONL and NDJSON work too (including one leading UTF-8 BOM), as do backups/dated names and extensionless files starting with `{` or `[`. Example: `package.json?q=.dependencies|keys`.
- `q` is percent-decoded (encode `&` inside the filter as `%26`; `+` stays literal; bare `%` is kept verbatim).
- Modifiers: `raw=true` prints strings unquoted; `compact=true` one value per line; `offset=N&limit=M` pages (limit defaults to 100 when paging, max 1000). Paging slices a single array result or a stream of results; follow the continuation it prints.
- Modifier-only queries (`?limit=2`) mean the identity filter `.`.
- Line/tail/raw selectors after the query (`…?q=.items:1-40`) select lines of the query output.
- Limits: 30 s per query, ~5 MiB captured output. For large arrays stream with `.[]` and page.
- Works on remote SSH files (`ssh://host/path/data.json?q=.items&limit=2`), HTTP/HTTPS JSON URLs (`https://api.example.com/items.json?q=.items[0]`), and archive text members (`archive.zip:data.json?q=.x`).
