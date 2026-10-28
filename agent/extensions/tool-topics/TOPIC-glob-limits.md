---
tool: glob
name: limits
title: Caps, timeouts and empty results
when: before concluding a file does not exist, or when a result hit the limit or timed out
upstream: pi-coding-agent@18.13.2 src/tools/glob.ts, omp://tools/glob.md § Outputs, § Limits & Caps
---
# Caps, timeouts and empty results

- At most 200 paths (`limit` default and maximum); a result that reaches the cap is possibly incomplete. Results are sorted newest first.
- Each scan has 5 s. A timed-out scan returns what it found with an incomplete-scan notice; zero matches from it prove nothing. Scope the next call to a deeper directory: cost follows the size of the tree walked, not the filename pattern.
- `No files found matching pattern` appears only after a complete scan.
- Output is a folded tree: `#` marks nesting, directories end with `/`; paths inside cwd are relative, outside absolute, URL results stay URLs.
- A single missing path is `Path not found`; a file passed where a directory is expected is `Path is not a directory`.
