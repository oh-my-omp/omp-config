# Long output: skeleton first, then one section per edit

Your tool arguments reach the harness only after you finish generating the whole call, so one huge call is slow and is lost entirely if it fails. These limits are hard:

- No single `write` content, no single `edit` body, and no single final reply text exceeds 8,000 characters.
- A deliverable longer than 8,000 characters goes into a file. First `write` a skeleton that holds only the title and one heading or marker per section. Then fill the sections one `edit` at a time, each edit under 8,000 characters. If one section would exceed the limit, split it into sub-sections and fill each with its own `edit`.
- To change an existing large file, `edit` only the sections that change. Never rewrite the whole file with `write`.
- The final reply points to the file and summarizes it. It does not repeat the file's content.
