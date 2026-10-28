---
tool: read
name: sqlite
title: Inspecting SQLite databases
when: before inspecting a `.sqlite`/`.sqlite3`/`.db`/`.db3` database
upstream: pi-coding-agent@18.13.2 src/tools/sqlite-reader.ts, src/tools/read-sqlite.ts, omp://tools/read.md § SQLite databases
---
# Inspecting SQLite databases

- `db.sqlite` — tables (excluding `sqlite_%`) with row counts (exact up to 50,000 rows, otherwise estimate or lower bound; max 500 tables).
- `db.sqlite:table` — the CREATE statement plus 5 sample rows.
- `db.sqlite:table:key` — one row by single-column primary key, else `rowid`. A missing row returns `No row found …`.
- `db.sqlite:table?limit=&offset=&order=&where=` — rows; limit defaults to 20 (max 500); `order=col` or `col:desc`; `where` is a SQL predicate without comments, `;`, LIMIT/OFFSET/UNION/ATTACH/PRAGMA.
- `db.sqlite?q=SELECT …` — read-only raw SQL (no `:table`, only `limit`/`offset` beside it). Unpaged it returns at most 1000 rows; add `limit`/`offset` to page. Writes are blocked by a query-only connection.
- Page database rows with `limit`/`offset`, not with `:N-M`.
- NULL prints as `NULL`, blobs as `<BLOB size>`; tables wider than 19 columns print one block per row.
