# MCP server

[Docs index](../README.md) · [Modes](modes.md) · [Provenance](provenance.md) · [Policy](policy.md) · [Configuration](../configuration.md)

Graft serves a small [Model Context Protocol](https://modelcontextprotocol.io) API to agents at `/mcp` on the Graft server (the same host and port as the webhook receiver). It has four tools. Three of them work in report mode, the default. One of them, `open_change`, writes to GitHub, and only when an operator has turned `mcp_write` on for the repository.

Spec: [phase-1/step-6-mcp-server.md](../phase-1/step-6-mcp-server.md). Design notes: [architecture.md](../architecture.md#mcp-contract-phase-1-step-6) and [decisions.md](../decisions.md#phase-1-step-6-mcp-server).

## The tools

Every tool takes `repository` (`owner/name`). It must name the token's repository, or the tool answers `forbidden_repository`.

| Tool | What it does | GitHub requests |
| --- | --- | --- |
| `get_status { repository, pr }` | What Graft knows about a pull request: the intent card (goal, behavior changes, out-of-scope edits, risk), provenance (trailers, and an MCP report if any), the policy verdict with what enforce mode would conclude, guard events where the PR is the culprit, and the repository's modes. | None: Graft's database only. |
| `get_policy { repository, base? }` | The parsed `graft.yaml` of a branch (default: the default branch), its hash and commit, errors with line numbers, and the modes. Never the file text or its comments. | Reads the branch and the policy file, through the policy job's own loader and cache. |
| `report_provenance { repository, pr, headSha, agent, model?, task?, sessionUrl? }` | Tells Graft who wrote the PR's current head. Stored as untrusted, validated like a commit trailer, once per head (see below). | None in the call. The provenance job then republishes its neutral check and comment section, as for any provenance change. |
| `open_change { repository, head, base?, title, body?, draft?, provenance? }` | Opens a pull request from a branch the agent already pushed, with `Graft-*` trailers from `provenance` appended to the body. Returns the open PR instead when one exists for that branch. | Reads, then one `POST …/pulls` through the `mcp` client. Only when `mcp_write` is effectively `on`. |

Results are typed: each tool declares an output schema, and returns `structuredContent` plus the same JSON as one text block. A tool that cannot do what was asked answers `isError: true` with `{ "error": "<code>" }` and sometimes a fixed `detail`:

`forbidden_repository`, `not_found`, `stale_head`, `pr_closed`, `already_reported`, `invalid_argument` (the detail names the field), `mcp_write_off` (the detail is the mode reason, for example `ceiling` or `permission_missing pull_requests:write`, or `mode_changed` after a rollback during the call), `invalid_head`, `head_not_found`, `base_not_found`, `rate_limited`, `github_<status>`, `internal`.

An argument the input schema refuses (an unknown key, a PR number of 0) is answered by the SDK as a tool error whose text starts with `Input validation error`; the tool never runs.

### `report_provenance`: it can only make a verdict stricter

Annotated `readOnlyHint: false, destructiveHint: false, idempotentHint: true` (Phase 1 step 7, D7): it stores a row, can make a verdict stricter and republishes the check and comment section, once per head.

A report is compared with what the commit trailers say for the same head. It **agrees** when the trailers name an agent and it is the same agent (case does not matter). Otherwise it **disagrees**, and the policy treats the author as `unknown`, the strictest author fact: every `author` and `agent` condition of a `require` or `block` rule then matches (as uncertain). Graft also keeps the verdict the trailers alone would give and publishes the stricter of the two, so an unknown author can never trade the policy's `default` for a looser rule. A report never replaces a trailer value: model, task and session from MCP are shown as "reported through MCP (unverified)" in the managed comment and in `get_status`.

One report per head: the same report again returns the stored result; a different one is `already_reported`. A new push gives a new head and allows a new report. A report for a head the PR no longer has is `stale_head`; on a closed PR it is `pr_closed`.

### `open_change`

- The branch must already be pushed, with the agent's own credentials. Graft never creates a branch or a commit for MCP.
- `head` and `base` are plain branch names of this repository: no `owner:` prefix, no `..`, no leading `/` or `-`, no trailing `/` or `.lock`, and never `graft-revert/…` (reserved for the guard). `head` cannot be the default branch.
- `title`: 1 to 256 characters, no control characters. `body`: at most 16,000 characters. `maintainer_can_modify` is always `false`; `draft` is passed through.
- Title and body are sent to GitHub and nowhere else: not stored, not logged, not returned.
- At most `GRAFT_MCP_OPEN_CHANGE_PER_HOUR` (default 10) PRs per repository in any rolling hour, counted in the database across server processes. Concurrent calls cannot exceed it: each call claims its slot under a lock before it asks GitHub, and gives the slot back if the create fails.
- An open PR for the same `head` and `base` is returned with `existing: true` instead of a new one. Graft records it as opened through MCP only when Graft's own App authored it (`<GITHUB_APP_SLUG>[bot]`): a person's PR, or another bot's (Dependabot, Renovate), is never marked.
- **Approvals.** The PR is authored by Graft's bot, which never counts as an approver. Graft also skips the approvals of everyone who authored or committed its commits, so whoever pushed the branch cannot approve their own change. If a commit has no GitHub user as author, is not verified by GitHub, or was committed by GitHub's `web-flow` (a commit made in the web UI, through the API, or by "Update branch"), or the PR has more than 250 commits, no approval counts.

## Getting a token

Tokens belong to one repository and are managed with the ops CLI only:

```sh
pnpm graft mcp-token create --repo owner/name --name "codex ci" [--expires-in 90] [--actor <name>]
pnpm graft mcp-token list   --repo owner/name [--all] [--json]
pnpm graft mcp-token revoke --id <uuid> --reason "<text>" [--actor <name>]
```

- `create` prints the token once, then `id <uuid>  expires <date>  shown once; store it now`. Graft stores only its SHA-256 hash and the first 8 characters after `graft_mcp_`. Store the token in the agent's secret store; never paste it into a PR, an issue or a chat.
- Names are 1 to 64 characters, unique among the repository's active tokens. Tokens expire after `--expires-in` days (1 to 365, default 90). A repository has at most `GRAFT_MCP_MAX_TOKENS_PER_REPO` active tokens (default 10).
- `revoke` takes effect on the next request: every request looks its token up again. Revoking twice is fine. Revoked and expired tokens stay listed with `--all` (who had access when) until the repository is purged.
- A repository that moves to another installation, or is removed and added again, loses all its tokens (`revoked_by system`).
- `pnpm graft mode show` prints `mcp tokens  N active (newest used …)` per repository, and `pnpm graft pilot doctor` warns about tokens expiring within 7 days and tokens never used after 14 days.

**Who should get a token.** Only agents (or the CI job that runs them) that already have read access to the repository. Everything `get_status` returns is already in the PR's comment and checks, and `get_policy` returns the repository's configuration; a token does not check the holder's GitHub role.

## Configuring a client

The endpoint speaks streamable HTTP, statelessly: no session, every request carries the token. Both protocol eras work: 2025-era clients (`initialize` first, protocol `2025-11-25` and older) and 2026-07-28 clients. `GET` and `DELETE` (2025 session operations) answer `405`.

Any streamable HTTP MCP client that can send a header:

```json
{
  "mcpServers": {
    "graft": {
      "type": "http",
      "url": "https://graft.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GRAFT_MCP_TOKEN}" }
    }
  }
}
```

A raw call with `curl` (a 2025-era request; the answer may come as one server-sent event):

```sh
curl -sS https://graft.example.com/mcp \
  -H "Authorization: Bearer $GRAFT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","arguments":{"repository":"owner/name","pr":42}}}'
```

Only `Authorization: Bearer <token>` is accepted (exactly that form). A missing, malformed, unknown, expired or revoked token gets `401` with `WWW-Authenticate: Bearer realm="graft"` and `{"error":"unauthorized"}`, whatever the cause. A token in a query string or a cookie is ignored. There is no OAuth.

Requests with an `Origin` header are refused (`403`) unless the origin is listed in `GRAFT_MCP_ALLOWED_ORIGINS`; agents send none. Bodies are JSON only (`415` otherwise) and at most 64 KiB (`413`).

## Rate limits

| Limit | Default | Scope |
| --- | --- | --- |
| Requests per token per minute (`GRAFT_MCP_RATE_LIMIT_PER_MINUTE`) | 60 | **Per server process**: `429` with `Retry-After`. |
| Failed authentications per client IP per minute (`GRAFT_MCP_AUTH_FAILURES_PER_MINUTE`) | 20 | **Per server process**. Past it, that IP gets `429` for the rest of the minute, before any database lookup, even with a valid token. |
| `open_change` PRs per repository per rolling hour (`GRAFT_MCP_OPEN_CHANGE_PER_HOUR`) | 10 | All processes (counted in the database). `rate_limited`. |

With N server processes the first two limits are N times higher.

**Behind a proxy (Phase 1 step 7, D6).** The client IP is the connection's peer address unless that peer is listed in `GRAFT_TRUST_PROXY` (IP addresses or CIDR ranges): then it is the client address from `X-Forwarded-For`. Set it to the addresses of the proxy in front of `/mcp`, so each client has its own failed-auth bucket. `true`, hop counts and hostnames are refused: a client that is not the proxy can never choose its own address.

**Order of the checks (D5).** The `Origin` check and the token are read from the headers before Fastify parses the body: an unauthenticated request is answered `401` (`403` for a foreign origin) whatever its media type or size. The per-token limit, `415` and `413` come after a valid token.

## What `mcp_write` changes

`mcp_write` is a [mode](modes.md), set only with `pnpm graft mode set --mcp-write on` and capped by the server ceiling: with `GRAFT_MODE_CEILING=report` (the default) it is always effectively `off`. It also needs `pull_requests: write`, which Phase 0 already has.

- **Off (default):** the three read tools work; `open_change` answers `mcp_write_off` before making any GitHub request at all, and no `mcp` client exists.
- **On:** `open_change` may open PRs. The mutation guard still checks every write: an `mcp` client can send only `POST …/pulls` with the body above, and the gate reads the mode again at the write, so a rollback between the check and the write is refused (`mcp_write_off`, `mode_changed`).

Nothing else changes: no tool comments, labels, merges, approves, pushes, creates branches or changes a mode. A token cannot change a mode either.

## Privacy

| Tool | Reads | Returns | Never |
| --- | --- | --- | --- |
| `get_status` | Graft's database: changes, intent cards, provenance, MCP reports, verdicts, the audit log, guard events | Model-written card prose and paths, risk, provenance values, verdict codes and counts, SHAs, check names, guard event status | Code, diffs, PR title or body, commit messages, review text, file contents |
| `get_policy` | The base commit and `graft.yaml` (the policy loader and its cache), the modes | The parsed policy (canonical key order), its hash and commit, error codes with line numbers, the modes | The YAML text, comments in it, any other file |
| `report_provenance` | Changes, trailer provenance | What was stored and whether it agrees | |
| `open_change` | The repository, the branch refs, open PRs by head | PR number, URL, head SHA, `existing`, warnings | The title and body it sent |

Stored: token hashes and metadata, MCP provenance rows (validated values, like trailers), and the PRs `open_change` opened (numbers and SHAs). No title, body, branch name, argument or result is stored. Logs hold one line per call (`mcp call`: tool, token id, repository id, outcome, duration), never the token, the arguments or the results. `pnpm graft pilot purge` removes all of it with the installation.

## Trust boundary and residual risks

A token holder cannot loosen a verdict, approve its own change, write to GitHub in report mode, reach another repository, push code or create branches, or change a mode, a token, a label or a policy. What remains:

- With `mcp_write` on, a token holder can open PRs from **any** existing branch of the repository, including one someone else pushed. The PR shows Graft's bot as author and that branch's commits; the commit authors' approvals do not count, and its review follows the policy like any PR.
- A leaked token works until it expires or is revoked. Revocation is immediate; the per-token limit and the open cap bound the damage.
- The per-token and failed-auth limits are per process.
- **Resolved in step 7 (D6):** behind a proxy, `GRAFT_TRUST_PROXY` gives each client its own failed-auth bucket. Without it, every client shares the proxy's address, and anyone sending 20 bad tokens locks every client out for the rest of the minute.
- **Resolved in step 7 (D8): verified commits.** On a PR opened through MCP, approvals count only when every commit is verified by GitHub (`commit.verification.verified`) and has a committer GitHub links to an account, other than GitHub's own `web-flow`. Anyone who pushes chooses the author and committer emails; a signature made with the committer's own key ties the committer to its account, so the excluded committers are genuine. A `web-flow` signature only proves that GitHub created the commit, not who asked it to, so the author of such a commit is not proven either, and it counts as unverified (step 7 review 1, finding 2). Editing an MCP-opened PR in the web UI, or clicking "Update branch", therefore makes its approvals stop counting. An unverified commit means no approval counts, and the policy section says so: "Approvals do not count: this PR was opened through MCP and has commits that GitHub has not verified." **Agents that use `open_change` must sign their commits** (an SSH or GPG signing key on the agent's GitHub account), or no approval on their PRs ever counts. A pusher who pushes someone else's genuine signed commits is reviewing someone else's work, which is a normal review: GitHub's API does not say who pushed a branch.
