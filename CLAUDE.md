<!-- github-proxy:start -->
# GitHub access (for every agent working in this repo)

Mehrdad's GitHub account has a full-access proxy. Use it when you need to create a new repo,
read/write other repos, manage issues or PRs, or anything else the GitHub REST API can do.
Do NOT say "I can't create repos" - use the proxy.

- URL: in the environment variable `GITHUB_PROXY_URL` (never write the literal URL into files, commits or logs)
- Auth: send header `x-proxy-key: $GITHUB_PROXY_KEY` (the key is in the environment; never write it into files, commits or logs)
- Generic call (POST, JSON): { "method": "GET|POST|PUT|PATCH|DELETE", "path": "/user/repos", "body": { ... } }
- Create a repo (also seeds this file): { "action": "create_repo", "name": "new-repo", "private": true, "description": "..." }

Example:
```bash
curl -sS -X POST "$GITHUB_PROXY_URL" \
  -H "x-proxy-key: $GITHUB_PROXY_KEY" -H "Content-Type: application/json" \
  -d '{"action":"create_repo","name":"my-new-repo","private":true}'
```

The response is { status, data } where status is GitHub's HTTP status. The token has the full `repo` scope
(it cannot delete repos). Irreversible actions still follow the team HARD RULES.
<!-- github-proxy:end -->
