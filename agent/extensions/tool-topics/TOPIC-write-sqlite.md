---
tool: write
name: sqlite
title: Writing SQLite rows
when: before inserting, updating or deleting a row in a SQLite database
upstream: pi-coding-agent@19.1.1 src/tools/write.ts, src/tools/sqlite-reader.ts, omp://tools/write.md § SQLite
---
# Writing SQLite rows

- Path: `<db>.sqlite|.sqlite3|.db|.db3:<table>` inserts; `<db>…:<table>:<key>` updates or deletes one row. The database must already exist; it is never created.
- Insert: `content` is a JSON5 object of column → value; `{}` inserts `DEFAULT VALUES`.
- Update: a non-empty JSON5 object on the keyed path; `{}` is rejected.
- Delete: empty or whitespace-only `content` on the keyed path. An unkeyed path with empty content is an error.
- The key matches a single-column primary key — including on `WITHOUT ROWID` tables — else falls back to `rowid`; only composite primary keys and tables without a usable `rowid` fallback (e.g. composite-PK `WITHOUT ROWID` or all rowid aliases shadowed) are rejected.
- Values must be scalars (string, number, boolean) or `null`; keys must be real columns. Foreign keys are enforced.
- No query parameters (`?where=` is read-only syntax). A busy database fails after 3 s.
- Results: `Inserted row into <t>`, `Updated row '<k>' in <t>`, `Deleted row …`, or `No row updated/deleted …` when the key matched nothing.
- An existing file with a `.db` suffix that is not SQLite is written as a plain file instead.
