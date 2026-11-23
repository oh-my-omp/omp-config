---
tool: read
name: forge
title: GitHub issues, PRs and GitLab MRs
when: before reading a GitHub issue/PR, its diff, or a GitLab merge-request diff
upstream: pi-coding-agent@19.1.1 src/internal-urls/issue-pr-protocol.ts, src/internal-urls/mr-protocol.ts, omp://tools/read.md § Internal URLs
inject:
  - id: read-forge
    tool: read
    parameter: path
    pattern: '^(issue|pr|mr)://'
---
# GitHub issues, PRs and GitLab MRs

- `issue://N`, `pr://N` (checkout's repository) or `issue://owner/repo/N`, `pr://owner/repo/N`; dotted enterprise hosts work in every shape (`pr://ghe.example.com/owner/repo/N`), and single-label enterprise hosts (`pr://ghe/owner/repo/N`) are recognized in the numbered form. Comments are included; `?comments=0` drops them.
- Lists: bare `issue://`, `pr://` or `pr://owner/repo` with `?state=open|closed|all` (`merged` for PRs), `limit` (default 30, max 100), `author`, `label`.
- PR diffs: `pr://N/diff` lists changed files, `pr://N/diff/<i>` one file (1-indexed), `pr://N/diff/all` everything; `?at=<generation>` reads that pinned cached diff generation (fails if expired/unavailable rather than reading live). Huge diffs fall back to per-file pages.
- GitLab: `mr://<iid>/diff` (derives the project from the session checkout) or `mr://<host>/<group>/<project>/<iid>/diff`, plus `/all` or `/<i>`. Only diff routes exist; needs `glab`. When a `GITLAB_TOKEN`-style env token is set, only `gitlab.com`, `GITLAB_HOST`, glab-configured hosts, or the checkout's own GitLab host are contacted.
- Ids and indexes are positive integers. If the default repository cannot be inferred, use the full owner/repo form.
