---
tool: read
name: forge
title: GitHub issues, PRs and GitLab MRs
when: before reading a GitHub issue/PR, its diff, or a GitLab merge-request diff
upstream: pi-coding-agent@18.13.2 src/internal-urls/issue-pr-protocol.ts, src/internal-urls/mr-protocol.ts
---
# GitHub issues, PRs and GitLab MRs

- `issue://N`, `pr://N` (checkout's repository) or `issue://owner/repo/N`, `pr://owner/repo/N`; an enterprise host goes first: `pr://ghe.example.com/owner/repo/N`. Comments are included; `?comments=0` drops them.
- Lists: bare `issue://`, `pr://` or `pr://owner/repo` with `?state=open|closed|all` (`merged` for PRs), `limit` (default 30, max 100), `author`, `label`.
- PR diffs: `pr://N/diff` lists changed files, `pr://N/diff/<i>` one file (1-indexed), `pr://N/diff/all` everything. Huge diffs fall back to per-file pages.
- GitLab: `mr://<iid>/diff` (or `mr://<host>/<group>/<project>/<iid>/diff`), plus `/all` or `/<i>`. Only diff routes exist; needs `glab`.
- Ids and indexes are positive integers. If the default repository cannot be inferred, use the full owner/repo form.
