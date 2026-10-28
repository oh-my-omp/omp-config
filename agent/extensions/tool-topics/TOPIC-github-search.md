---
tool: github
name: search
title: Searching GitHub
when: before `search_issues`, `search_prs`, `search_code`, `search_commits` or `search_repos` beyond a plain keyword
upstream: pi-coding-agent@18.13.2 src/tools/gh-search.ts, src/prompts/tools/github.md, omp://tools/github.md § Inputs
---
# Searching GitHub

- Scope: without `repo`, issue/PR/code/commit searches use the current checkout; a query starting with `repo:`, `org:`, `user:` or `owner:` overrides that. `search_repos` ignores `repo`: scope it in the query. For an enterprise host put `host/owner/repo` in `repo`, never the host inside `repo:`.
- `query`: GitHub search syntax. `AND`/`OR`/`NOT` combine text terms only, never qualifiers. `search_code` requires a query; the others may run on dates alone.
- Dates: `since`/`until` accept `3d`, `2w`, `6mo`, `1y` (also `m`, `h`), `YYYY-MM-DD` or ISO datetimes. `dateField: "updated"` filters by update (repos: last push); commits always use committer date; `search_code` rejects dates.
- `limit`: default 10, max 50.
- Results per kind: issues/PRs — repo, state, author, labels, times, URL; code — path, repo, short SHA, first matching fragment; commits — short SHA, subject, author, date; repos — description, language, stars, forks, flags. An empty result is a normal response, not an error.
- Files of another repository: `file_read` with `repo`, `path` and optional `branch` (never curl).
