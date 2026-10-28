---
tool: web_search
name: query
title: Query operators and results
when: before a search that filters by site, date, title, URL, file type or language, or targets X/Twitter posts
upstream: pi-coding-agent@18.13.2 src/web/search/query.ts, src/web/search/index.ts, omp://tools/web_search.md § Flow, § Outputs
---
# Query operators and results

- Site: `site:docs.python.org` (aliases `domain:`, `host:`; a path prefix works: `site:github.com/oven-sh`); `-site:` excludes.
- Dates: `after:2025-01` / `before:2025-06-30` (aliases `since:`/`until:`; `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `MM/DD/YYYY`); or `recency: day|week|month|year`.
- Fields: `intitle:`/`title:`, `inurl:`/`url:`, `intext:`/`inbody:`, `filetype:`/`ext:`, `lang:`; prefix `-` to exclude. `allintitle:`/`allinurl:`/`allintext:` apply to every following term.
- Text: `"exact phrase"`, `-term`, `OR`/`AND`/`NOT` and parentheses.
- X/Twitter: `site:x.com`, `site:x.com/<handle>`, `from:<handle>`, `-from:<handle>` route to xAI's X search (needs xAI credentials).
- Unknown `name:value` tokens and unparseable dates stay as plain text. When a filter would remove every source, it is relaxed and a leading `Note:` says which.
- Breadth: `num_search_results` (wins over `limit`); providers cap it themselves (typically 10–20).
- Result: answer first (when the provider gives one), then numbered `## Sources`, `## Citations`, sometimes `## Related` and the search queries used. Cite the source URLs.
- Providers are tried one after another; notes at the top name providers that failed. When all fail you get an `Error: …` result, not an exception. Each provider attempt has 60 s.
