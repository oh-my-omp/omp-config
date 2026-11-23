---
tool: read
name: web
title: Reading web pages
when: before reading a URL in pieces, or when a fetched page looks incomplete or failed
upstream: pi-coding-agent@19.1.1 src/tools/fetch.ts, src/tools/read.ts, src/web/scrapers/twitter.ts, omp://tools/read.md § Web URLs
inject:
  - id: read-web
    tool: read
    parameter: path
    pattern: '^(https?://|www\.)'
---
# Reading web pages

- `http(s)://` and bare `www.` URLs work. A whole read starts with a header (`URL`, `Content-Type`, `Method`, `Notes`, `---`) and keeps up to 300 lines / 50 KiB inline, spilling overflow to `local://<id>.log`.
- Selectors address body lines: `https://x.dev/page:40-120`, one range group only (`:5-10,20-30`, not `:5-10:20-30`). With a port put a slash first: `https://host:8080/:1-50`.
- `:N`, `:A-B`, `:A+C`, and comma multi-ranges page over the cached render without refetching when cached output is usable.
- Non-raw URL reads also support HTTP archive-member reads (`https://…/pkg.whl:pkg/__init__.py`, `…/src.tar.gz:dir/`) and JSON `?q=<jq>` queries (`https://api.example.com/items.json?q=.items[0]`; non-filter `q` passes through to the server).
- `:raw` returns the unprocessed body without the transport header. Without it the page is converted (site handlers, JSON, feeds, Markdown alternates, readable-HTML extraction); `Method`/`Notes` tell which path ran.
- Bot protection & errors: a 2xx bot-protection challenge page (Cloudflare, DataDome, PerimeterX) is tried only through remote readers; if none clears it, the read returns `method: "blocked"` (not rendered) and directs you to the `browser` tool. Walled HTTP error statuses return text with `method: "failed"` and the protection in `Notes`, not a tool error. Notes about JavaScript gating or conversion failure mean dynamic content was not obtained: use a browser.
- `x.com` / `twitter.com` posts, profiles and searches skip raw scraping and route through Grok `x_search` (needs xAI credentials; without credentials or on unsupported X pages like home/explore/lists, returns `method: "x-unavailable"`).
- Default timeout 30 s; no timeout parameter.
