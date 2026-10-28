---
tool: read
name: web
title: Reading web pages
when: before reading a URL in pieces, or when a fetched page looks incomplete or failed
upstream: pi-coding-agent@18.13.2 src/tools/fetch.ts, src/tools/read.ts, omp://tools/read.md § Web URLs
---
# Reading web pages

- `http(s)://` and bare `www.` URLs work. A whole read starts with a header (URL, Content-Type, Method, Notes, `---`) and keeps up to 300 lines / 50 KiB inline, the rest in an artifact.
- Selectors address body lines: `https://x.dev/page:40-120`, one range group only (`:5-10,20-30`, not `:5-10:20-30`). With a port put a slash first: `https://host:8080/:1-50`.
- Each selector read fetches the page again; for a stable copy, read the returned artifact.
- `:raw` returns the unprocessed body. Without it the page is converted (site handlers, JSON, feeds, Markdown alternates, readable-HTML extraction); `Method`/`Notes` tell which path ran.
- HTTP errors come back as text with `method=failed` and notes, not as a tool error. Notes about JavaScript gating or conversion failure mean the dynamic content was not obtained: use a browser.
- `x.com` / `twitter.com` posts, profiles and searches are answered through Grok search (needs xAI credentials).
- Default timeout 30 s; no timeout parameter.
