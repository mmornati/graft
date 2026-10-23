# Phase 1, Step 6: Minimal MCP server

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 6: MCP server". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs, logs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 5 is described in [docs/architecture.md](../architecture.md) (the modes contract, the policy contract and the guard contract) and [docs/decisions.md](../decisions.md). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md). The previous step is [step-5-revert-prs.md](step-5-revert-prs.md).

This step depends on steps 1, 2 and 3, which are merged. It reads step 4 and step 5 columns of `guard_events` when they exist; build it after step 5 has merged, or leave the step 5 fields out of `get_status` and record that.

Binding rules from earlier steps:
- **Report mode stays inert.** With default modes, MCP adds no GitHub write at all. Its one write (`open_change`, a `POST …/pulls`) goes through an `mcp` feature client and the mutation guard, and is refused unless `mcp_write` is effectively `on` (step 1, D11, D12).
- **Trailers are untrusted** (Phase 0 step 2, D14; step 5 policy engine, D10, D11). Provenance comes from the agent being judged. It may make a verdict stricter, never looser. MCP provenance follows the same rule, made exact in D13.
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). An MCP call is a payload too: its arguments may choose what to read, never what is true. The PR, its head, the default branch and the modes are read from the database or the API inside the call.
- **Nothing in a repository changes a mode.** A token cannot change a mode either. Only `pnpm graft mode set` does.
- **Graft does not read code.** No MCP tool fetches, returns, logs or stores file content, a patch, a diff, a commit message or PR text. `get_policy` returns the parsed policy, never the file.

## 1. Goal

Give agents a small, typed, authenticated API on the Graft server:

- **Transport.** The official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`), streamable HTTP, stateless, mounted in the existing Fastify server at `/mcp` (D1–D4).
- **Tokens.** An operator creates a token for one repository with `pnpm graft mcp-token create --repo owner/name`. It is printed once, stored as a SHA-256 hash, expires, can be listed and revoked, and never appears in a log (D5–D10).
- **Four tools.** `get_status` (what Graft knows about a PR), `get_policy` (the parsed effective policy and the modes), `report_provenance` (agent, model, task and session for a PR head, untrusted), `open_change` (open a PR from a branch the agent already pushed) (§7).
- **Reads work in report mode.** `get_status`, `get_policy` and `report_provenance` need only a valid token. `report_provenance` writes Graft-side data, and its effects on GitHub are the Phase 0 writes the provenance job already makes (a neutral check run, the managed comment).
- **One write, gated.** `open_change` is the only MCP call that writes to GitHub, and only when `mcp_write` is effectively `on` for the repository (D16).
- **Neutral, provably.** The report-mode regression suite gains an MCP scenario, so CI fails if any MCP call adds a GitHub write in default modes (T12).

## 2. Out of scope

Do not create stub code for any of these.

- OAuth 2.1 authorization, protected-resource metadata (`/.well-known/oauth-protected-resource`), dynamic client registration, and any token that is not a Graft per-repository token (D5).
- MCP resources, prompts, sampling, elicitation, tasks, subscriptions, `listChanged` notifications and server-initiated messages. The server declares the `tools` capability only.
- stdio transport, a separate MCP process, sessions (`Mcp-Session-Id`), resumable SSE streams.
- Tools beyond the four. In particular: no tool that reads files, diffs, CI logs or PR text; no tool that comments, labels, merges, approves, pushes, creates a branch, or changes a mode; no `get_intent` for tasks (Phase 2 grouping, spec fix 2).
- Tokens that span repositories, organisation-wide tokens, tokens tied to a GitHub user.
- A web UI for tokens. The ops CLI is the only way to create, list and revoke them.
- Opening a PR from a fork (`head` as `owner:branch`), or against a repository other than the token's.
- Changing branch protection or making `graft/policy` required (a human step, step 7).
- MCP metrics in `gate report` (step 7). This step stores what step 7 needs.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | SDK | Pin exact versions: `@modelcontextprotocol/server@2.3.1` and `@modelcontextprotocol/node@2.1.1` (dependencies), `@modelcontextprotocol/client@2.3.1` (devDependency, for the tests). Not the v1 `@modelcontextprotocol/sdk` package, and not `@modelcontextprotocol/fastify` (D3). These were the npm `latest` tags on 2026-10-22; T1 re-checks them. | v2 is the stable line and implements the 2026-07-28 MCP revision. Exact pins because the transport classification rules are new and a minor release could change them. |
| D2 | Serving model | `createMcpHandler(factory, { legacy: "stateless", responseMode: "json", maxRequestBodySize: 65536 })`, wrapped once with `toNodeHandler` from `@modelcontextprotocol/node`. The factory builds a fresh `McpServer` per request with the four tools. No session, no event store, nothing held in memory between requests. `legacy: "stateless"` also serves 2025-era clients (protocol `2025-11-25` and older), answering their `GET` and `DELETE` with `405`. | Every request is authenticated and authorised on its own (D7), so a revoked token stops working on the next request and the server can run as several processes. `json` responses because no tool streams. |
| D3 | Mounting | A Fastify plugin `mcpRoutes` registered in `buildServer` when `GRAFT_MCP=on`. Routes `POST`, `GET` and `DELETE` on `/mcp`, with a route `bodyLimit` of 64 KiB and the JSON content-type parser Fastify already has (other media types get `415`). The handler runs in a `preHandler` chain: Origin check (D4), auth (D7), rate limit (D9); then `reply.hijack()` and `nodeHandler(req.raw, reply.raw, req.body)` with `req.raw.auth` set to the D7 `AuthInfo`. No `@modelcontextprotocol/fastify`: its `createMcpFastifyApp` creates its own Fastify instance, and we mount in the existing one. | One server, one port, one log setup, as the development plan says ("in the same service"). |
| D4 | Origin and Host | A request with an `Origin` header is refused (`403`, JSON-RPC error `-32000` "origin not allowed") unless the origin is in `GRAFT_MCP_ALLOWED_ORIGINS` (comma-separated, default empty). No Host check: the server is public behind the operator's proxy, as the webhook receiver is. | The MCP spec requires Origin validation against DNS rebinding. Agents are not browsers and send no Origin, so the default refuses every browser. |
| D5 | Auth scheme | `Authorization: Bearer <token>` only. A missing, malformed, unknown, expired or revoked token gets HTTP `401` with `WWW-Authenticate: Bearer realm="graft"` and the body `{"error":"unauthorized"}`, the same bytes for every cause. No `resource_metadata` parameter (no OAuth, §2). A token in a query string or a cookie is ignored. | The spec lets a server use another auth strategy than OAuth. One response for every failure tells a guesser nothing. |
| D6 | Token format | `graft_mcp_` followed by 43 characters of base64url (32 bytes from `crypto.randomBytes`). Stored: `token_hash` = hex SHA-256 of the whole token string, unique; `token_prefix` = the first 8 characters after `graft_mcp_`, for `list`. Never stored: the token. No pepper and no slow hash: the token has 256 bits of entropy, so a fast hash is as strong as a slow one, and the lookup is by hash (no comparison of secrets in user code). | GitHub-style prefixed tokens are recognisable to secret scanners. Hashing means a database dump cannot be replayed. |
| D7 | Per request | Parse the header with `^Bearer (graft_mcp_[A-Za-z0-9_-]{43})$`, hash, and read the token joined to its repository and installation in one query. The request is authorised iff the row exists, `revoked_at IS NULL`, `expires_at > now()`, the repository is active (`removed_at IS NULL`) and its installation is active. The resulting `AuthInfo` is `{ token: "[redacted]", clientId: <token id>, scopes: ["repository:<repository id>"], extra: { tokenId, repositoryId, installationId } }`. The secret is never put into `AuthInfo`. No cache. | One indexed query per request makes revocation immediate. The SDK passes `AuthInfo` to every tool, and its `token` field would otherwise put the secret where a log could reach it. |
| D8 | Repository argument | Every tool takes a required `repository` (`owner/name`). It must equal the token's repository's current `full_name` (case-insensitive), or the tool returns the error `forbidden_repository`. The answer is the same whether the other repository exists in Graft or not. PR numbers are looked up only within the token's repository. | Scoping by construction, and an agent working in several repositories finds a mixed-up token at once instead of reading the wrong PR. |
| D9 | Rate limits | (a) Per token: `GRAFT_MCP_RATE_LIMIT_PER_MINUTE` requests (1–600, default 60), a token bucket in process memory keyed by token id; over the limit → HTTP `429` with `Retry-After`. (b) Failed auth: `GRAFT_MCP_AUTH_FAILURES_PER_MINUTE` per client IP (`req.ip`, 1–600, default 20), counted before the database lookup once the limit is hit; over it → `429` for that IP for the rest of the minute. (c) `open_change`: at most `GRAFT_MCP_OPEN_CHANGE_PER_HOUR` (1–100, default 10) successful opens per repository in any rolling hour, counted from `mcp_changes` rows (D18). Buckets (a) and (b) are per process: with N server processes the real limit is N times higher, and `docs/features/mcp.md` says so. | (a) and (b) protect the database and GitHub quota and need no shared state. (c) bounds the one write across processes, so it is counted where every process can see it. |
| D10 | Never logged | The `Authorization` header is already in `REDACT_PATHS`, and request logging is off. In addition: tool arguments and tool results are never logged; the MCP log line is `{ msg: "mcp call", tool, tokenId, repositoryId, outcome, ms }` at info; an SDK `onerror` goes through `sanitizeError`; a token-shaped string (`graft_mcp_[A-Za-z0-9_-]{43}`) is replaced by `graft_mcp_[redacted]` in every error message the MCP module logs or returns. The CLI prints the token once, to stdout, and never takes it as an argument. | The token is a credential. Arguments carry PR titles and bodies (`open_change`) and agent-chosen strings, which are untrusted and may be large. |
| D11 | Token lifecycle | `create` takes `--repo`, `--name` (1–64 printable characters, unique among the repository's active tokens), `--expires-in <days>` (1–365, default 90) and `--actor` (defaults to the login name, as `mode set`). At most `GRAFT_MCP_MAX_TOKENS_PER_REPO` (1–50, default 10) active tokens per repository. `revoke --id <uuid> --reason "<text>"` sets `revoked_at`, `revoked_by` and `revoke_reason`; revoking twice is a no-op with exit 0. Revoked and expired rows are kept (they say who had access when) until the repository is purged. `last_used_at` is updated at most once a minute per token (a conditional `UPDATE … WHERE last_used_at < now() - interval '1 minute'`). | An operator-only lifecycle, written to the database with an actor, like modes. Expiry by default, so a forgotten token stops working. |
| D12 | Transfers and removal | When `upsertRepositories` moves a repository row to another installation or reactivates a removed one (the step 2 D13 path), it also revokes every active token of that repository with `revoked_by = 'system'` and `revoke_reason = 'repository_transferred'` (or `'repository_readded'`), in the same transaction. A removed repository's tokens already fail D7; they are not revoked, so a re-add without a transfer still revokes them by the rule above. | A token was granted for a repository under one owner. A transfer changes who should be able to read its data, as it resets the modes. |
| D13 | Provenance merge | A `report_provenance` for a head is compared with what the trailers say for that head (`change_provenance`). It **agrees** iff `change_provenance.head_sha` equals the reported head, `author_kind = 'agent'`, and `agent` equals the reported agent (case-insensitive). Otherwise it **disagrees**. `change_provenance.mcp_report` stores `none`, `agrees` or `disagrees`. `buildFacts` gives `author = { kind: "unknown", agent: null }` when `mcp_report = 'disagrees'`, and the trailer facts otherwise. Model, task and session from MCP never replace trailer values: they are shown in the managed comment and in `get_status` as "reported through MCP (unverified)". | `unknown` is the strictest author fact the policy engine has: every tightening `author` or `agent` condition matches it (uncertain), and no approve rule may use those keys (step 5 policy engine, D10, D11). So a report can only add matches to `require` and `block` rules: it tightens or changes nothing, never loosens. Agreement changes nothing. |
| D14 | One report per head | One `provenance` row with `source = 'mcp'` per (change, head), with `commit_sha` = the reported head (the existing unique key `(change_id, source, commit_sha)`). A second report for the same head with identical fields returns the stored result; with different fields it is refused `already_reported`. A new push gives a new head and allows a new report. | A later report cannot undo an earlier disagreement, so "never loosens" holds over time too, not just per report. |
| D15 | Report freshness | `report_provenance` requires `head_sha`. It must equal the change's stored `head_sha` (kept current by the `pull_request` webhooks). Otherwise → `stale_head`, nothing stored. A report on a closed or merged PR → `pr_closed`. After storing, the call enqueues `provenance.refresh` for the change (new trigger `mcp_report`, `deliveryId = "mcp:<provenance row id>"`), which recomputes `change_provenance` with the merge (D13), republishes its neutral check and comment section, and emits `provenance_published`, so the policy job re-evaluates. | A report for a head the PR no longer has would describe code nobody is reviewing. The existing job already owns the comment and the check, so MCP adds no new GitHub write path. |
| D16 | `open_change` gate | The tool reads `getEffectiveModes` first. `mcp_write` not effectively `on` → error `mcp_write_off` with the mode reason (`repository`, `ceiling`, `permission_missing pull_requests:write`, …), and **no GitHub request of any kind**, not even a GET. Only then does it make `forInstallation(installationId, { feature: "mcp" })`. The mutation guard's gate reads the mode again at the write (step 1, D12): a rollback between the two reads refuses the write with `mode_off`, and the tool returns `mcp_write_off` with reason `mode_changed`. | README step 6: the write needs `mcp_write`. The early read keeps report mode free of `mcp` clients; the gate is the proof. |
| D17 | `open_change` checks | In order, all through the default client (GETs): `repos.get` (default branch); `head` matches `^[A-Za-z0-9._/-]{1,200}$`, has no `..`, no leading `/` or `-`, does not end in `/` or `.lock`, is not the default branch, and does not start with `graft-revert/` (reserved for the guard) → else `invalid_head`; `git.getRef heads/<head>` exists → else `head_not_found`; `base` (default: the default branch) passes the same name rule and exists → else `base_not_found`; `pulls.list({ head: "<owner>:<head>", base, state: "open" })` finds a PR → return it with `existing: true` and write nothing; D9 (c) → else `rate_limited`. Then `pulls.create`. A 422 from `pulls.create` → the same `pulls.list` lookup; found → `existing: true`, otherwise `github_422`. | The branch must already be pushed, by the agent, with its own credentials: Graft never creates a branch or a commit for MCP. The lookup makes retries safe without an idempotency key. |
| D18 | PR content | `title`: 1–256 characters, trimmed, no control characters. `body`: 0–16,000 characters. Graft appends, as the body's last paragraph, a trailer block built from the optional `provenance` argument (`Graft-Agent`, `Graft-Model`, `Graft-Task`, `Graft-Session`), each value validated with the trailer field validators of `src/modules/provenance/fields.ts`; an invalid value is dropped and named in the result's `warnings`. `draft` is passed through; `maintainer_can_modify` is always `false`. After the PR is created, Graft inserts an `mcp_changes` row (repository, token id, PR number, head SHA at open, created at). Title and body are sent to GitHub and nowhere else: not stored, not logged, not returned. | The provenance job already parses PR-body trailers as untrusted (`source = 'pr_body'`), so "provenance attached" needs no new trust rule. The row is what the rate limit, D19 and step 7 count. |
| D19 | Self-approval | A PR opened by `open_change` is authored by the Graft App's bot, which `countApprovals` already ignores as a bot. So the person who pushed the branch would otherwise be able to approve their own change. For a change with an `mcp_changes` row, the policy job reads `pulls.listCommits` (at most 250, logins only, nothing stored) and passes the lowercased `author.login` and `committer.login` of every commit as `excludedLogins` to `countApprovals`, which skips them like the PR author. More than 250 commits, or a commit with no `author` login → no approval counts (`approvals.truncated = true`, which step 2 already treats as unmet in enforce mode). `web-flow` (GitHub's web committer) is not excluded. | "Not the PR author" (README step 2) must mean the people whose work the PR is, not the account that clicked "open". Fail closed when Graft cannot tell who they are. |
| D20 | Errors | Protocol and auth problems are HTTP or JSON-RPC errors (D4, D5, D9, SDK validation: `-32602`). A tool that runs and cannot do what was asked returns a tool result with `isError: true` and `structuredContent: { error: <code>, detail?: <fixed text> }`. Codes: `forbidden_repository`, `not_found`, `stale_head`, `pr_closed`, `already_reported`, `invalid_argument`, `mcp_write_off`, `invalid_head`, `head_not_found`, `base_not_found`, `rate_limited`, `github_<status>`, `internal`. `detail` is never built from GitHub error messages or tool arguments. | Agents branch on codes. A GitHub error message can echo the request (a branch name, a title), which is untrusted. |
| D21 | Output shape | Each tool declares an `outputSchema` (zod) and returns `structuredContent` plus one `text` content block holding the same JSON (for clients that ignore structured output). Strings that came from untrusted sources (provenance values, card prose, check names, branch names) are returned as data, unchanged after the validation they already passed, never as markdown. | Typed results, and no rendering decision on the server. |
| D22 | Kill switch | `GRAFT_MCP` (`on`/`off`, default `on`). Off: `/mcp` is not registered (404, the existing not-found handler), and the CLI still manages tokens. With no token created, `on` exposes only the D5 `401`. | An operator can turn the API off without revoking tokens. Default on is safe because nothing is reachable without a token the operator created. |

## 4. Trust boundary

Who holds a token: an agent (or the CI job that runs it) that an operator chose to trust with **read access to what Graft knows about one repository**, and, when `mcp_write` is on, with opening PRs there. The token is not tied to a GitHub user, so Graft cannot check the holder's repository role. `docs/features/mcp.md` says to issue tokens only to agents that already have read access to the repository, because:

- `get_status` returns the intent card's prose and paths, the provenance, the verdict and guard events. All of it is already in the PR's managed comment and check runs, visible to anyone who can read the repository. Nothing more.
- `get_policy` returns the parsed `graft.yaml` of a branch: globs, team names, label names. That is repository content (configuration, not code).

What a token holder cannot do:
- **Loosen a verdict.** `report_provenance` can only move the author fact to `unknown` (D13), and only once per head (D14). Provenance in a PR body written by `open_change` is parsed as untrusted, as every PR body is.
- **Approve its own change.** Approvals of the commit authors and committers of an MCP-opened PR do not count (D19), and Graft's bot never counts.
- **Write to GitHub in report mode.** No `mcp` client exists unless `mcp_write` is effectively `on` (D16), and the mutation guard refuses any `mcp` write when it is not. The body rule of §9 limits even an enforcing `mcp` client to opening one same-repository PR from an existing branch.
- **Reach another repository.** The repository comes from the token row, never from an argument (D8).
- **Push code or create branches.** The agent pushes with its own credentials; Graft only opens the PR (D17).
- **Change a mode, a token, a label or a policy.** No tool does.

Residual risks, recorded in `docs/features/mcp.md`:
- With `mcp_write` on, a token holder can open PRs from **any** existing branch of the repository, including a branch someone else pushed. The PR shows Graft's bot as author and the branch's commits; D19 keeps the branch's authors from approving it. Its review then follows the policy like any PR.
- A leaked token is usable until it expires or is revoked. Revocation is immediate (D7). The per-token limit (D9 a) and the open cap (D9 c) bound the damage.
- Rate limits (a) and (b) are per process (D9).

## 5. Privacy contract

Every tool answers from data Graft already stores or reads under the Phase 0 rules, and returns nothing Graft would refuse to store:

| Tool | Reads | Returns | Never |
| --- | --- | --- | --- |
| `get_status` | Database only: `changes`, `intent_cards`, `change_provenance`, `provenance` (`source = 'mcp'`), `policy_verdicts`, `audit_log`, `guard_events` | Model-written card prose and paths, risk, provenance values, verdict codes and counts, SHAs, check names, guard event status | Code, diffs, PR title or body, commit messages, review text, file contents |
| `get_policy` | `resolveBaseCommit` + `loadBasePolicy` (the existing loader and its per-commit cache), `getEffectiveModes` | The parsed policy as the loader's canonical object, its hash and commit, error codes with line numbers, the modes | The YAML text, comments in it, any other file |
| `report_provenance` | `changes`, `change_provenance` | What was stored and whether it agrees | |
| `open_change` | `repos.get`, `git.getRef`, `pulls.list` | PR number, URL, head SHA, `existing`, warnings | The title and body it sent |

New stored data: token hashes and metadata, MCP provenance rows (validated fields, as trailers), and `mcp_changes` rows (numbers and SHAs). No title, body, branch name, argument or result is stored. Both new tables cascade from `repositories` and are covered by `pilot purge`.

## 6. Files

New:

| File | What |
| --- | --- |
| `src/mcp/tokens.ts` | Pure: `generateToken()`, `hashToken()`, `parseBearer()`, `tokenPrefix()`, `redactTokens(text)`. Imports `node:crypto` only. |
| `src/mcp/schemas.ts` | Pure: zod input and output schemas of the four tools, the error codes (D20), the branch-name rule (D17), the title and body rules (D18). |
| `src/modules/mcp/index.ts` | Module entry: exports `mcpRoutes` and the CLI commands. No webhook handlers, no jobs. |
| `src/modules/mcp/http.ts` | The Fastify plugin (D3): Origin check, auth, rate limits, the SDK handler. |
| `src/modules/mcp/auth.ts` | D7 lookup and `last_used_at` update. |
| `src/modules/mcp/rate-limit.ts` | The two in-memory buckets (D9 a, b), with an injectable clock. |
| `src/modules/mcp/server.ts` | The per-request `McpServer` factory: registers the four tools with their schemas and annotations (`readOnlyHint: true` on the three reads; `destructiveHint: false`, `idempotentHint: true` on `open_change`). |
| `src/modules/mcp/tools/get-status.ts`, `get-policy.ts`, `report-provenance.ts`, `open-change.ts` | One tool each (§7). |
| `src/modules/mcp/store.ts` | Token CRUD, `mcp_changes`, the hourly count. |
| `src/modules/mcp/cli.ts` | `mcp-token create|list|revoke` (§10). |
| `src/db/migrations/0014_mcp.ts` | §11. |
| `test/unit/mcp-tokens.test.ts`, `test/unit/mcp-schemas.test.ts`, `test/unit/mcp-rate-limit.test.ts`, `test/unit/provenance-mcp-merge.test.ts` | §13. |
| `test/integration/mcp.test.ts` | §13, with a real `@modelcontextprotocol/client` over HTTP against `buildServer`. |
| `test/helpers/mcp-client.ts` | Builds a client with a bearer token (the client transport's `requestInit` headers). |

Changed: `src/http/server.ts` (register `mcpRoutes` when `GRAFT_MCP=on`), `src/github/mutation-guard.ts` (§9), `src/modules/modes/effective.ts` (none expected; record if the gate needs a change), `src/modules/provenance/compute.ts`, `job.ts` (trigger `mcp_report`), `store.ts`, `render.ts` (D13, D15), `src/modules/policy/facts.ts` (D13), `src/policy/evaluate.ts` (`countApprovals` gains `excludedLogins`), `src/modules/policy/job.ts` (D19), `src/modules/installations/store.ts` (D12), `src/modules/pilot` purge and `src/pilot/doctor.ts` (§10), `src/bin/graft-ops.ts` (usage and dispatch), `src/config/index.ts`, `.env.example`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `package.json` and the lockfile, `test/unit/mutation-guard.test.ts`, `test/integration/neutral.test.ts`, the GitHub fakes (`pulls.create` and `pulls.list` by head, `git.getRef`), and the docs in T13.

## 7. Tools

Every tool takes `repository` (D8). PR numbers are positive integers up to 2^31−1. Inputs are zod objects with `.strict()`: an unknown key is `-32602` from the SDK.

### `get_status`

Input: `{ repository, pr }`. Output, every part `null` when Graft has nothing:

```ts
{
  pr: { number, state: "open" | "closed" | "merged", headSha, baseRef, openedThroughMcp: boolean },
  card: { headSha, current: boolean, status: "ok" | "unavailable", riskClass, goal, behaviorChanges: string[],
          outOfScopeEdits: { path, reason }[] } | null,
  provenance: { headSha, current: boolean, authorKind, agent, model, task, sessionUrl,
                conflicts: string[],                       // field names only
                mcp: { report: "none" | "agrees" | "disagrees", agent, model, task, sessionUrl } } | null,
  policy: { headSha, current: boolean, outcome, policyMode, published, wouldBe, wouldBeReason,
            riskClass, approvals: { current, stale }, breakGlass: "none" | "applied" | "would_bypass",
            evaluatedAt } | null,
  guard: { id, status, detectedAt, failingChecks: string[], revertPrNumber, revertOutcome }[],  // culprit of these events, newest first, at most 10
  modes: { policy, guard, mcpWrite }                       // effective values and reasons
}
```

`current` is `headSha === pr.headSha`. `published` is `check_conclusion`, `wouldBe` is `enforced_conclusion` (step 2, D10). The newest row per table for the change. A PR not in `changes` for the token's repository → `not_found`. No GitHub request.

### `get_policy`

Input: `{ repository, base? }` (`base`: a branch name, default the default branch, D17 name rule). Reads the default branch with `repos.get` when `base` is absent, then `resolveBaseCommit` and `loadBasePolicy` (same cache as the policy job). Output: `{ base, commitSha, status: "ok" | "missing" | "invalid", hash, policy, errors: { code, line?, path? }[], warnings, modes: { ceiling, policy, guard, mcpWrite } }`. `policy` is the loader's parsed object serialised with the same canonical ordering the hash uses (no YAML, no comments). A branch that does not exist → `base_not_found`. A GitHub error → `github_<status>`.

### `report_provenance`

Input: `{ repository, pr, headSha, agent, model?, task?, sessionUrl? }`, each field validated by the trailer validators (same character sets and length caps, `https` session URL rules); an invalid field is `invalid_argument` naming the field, and nothing is stored. Steps, inside `withChangeLock(change)`: D15 checks; D14 lookup; insert the row; read `change_provenance` for the head and compute agreement (D13) for the result. Outside the lock: enqueue `provenance.refresh` (D15). Output: `{ stored: true, existing: boolean, agreement: "agrees" | "disagrees" | "pending" }` (`pending` when trailers for that head were not computed yet; the job decides when it runs). No GitHub request in the call itself.

### `open_change`

Input: `{ repository, head, base?, title, body?, draft?, provenance?: { agent?, model?, task?, sessionUrl? } }`. Steps: D16, D17, `pulls.create` through the `mcp` client with exactly `{ title, body, head, base, draft, maintainer_can_modify: false }`, then the `mcp_changes` insert (D18). Output: `{ prNumber, url, headSha, existing: boolean, warnings: string[] }`. `url` is built as `https://github.com/<full_name>/pull/<n>` from stored values, not taken from the response.

## 8. Provenance merge

`computeProvenance` stays as it is. A new pure function in `src/modules/provenance/compute.ts`:

```ts
export function mcpAgreement(
  trailers: { headSha: string; authorKind: "agent" | "human"; agent: string | null } | null,
  report: { headSha: string; agent: string } | null,
): "none" | "agrees" | "disagrees";
```

`null` report → `none`. `null` trailers, or a different head → `disagrees`. Otherwise D13. The provenance job calls it after computing trailers, with the `source = 'mcp'` row whose `commit_sha` equals the head, and stores `mcp_report`. `buildFacts` reads `mcp_report` (D13). The managed comment's provenance section gains one line when a report exists: `Reported through MCP (unverified): agent \`x\`, model \`y\`, task \`z\` · agrees with trailers | differs from trailers: the policy treats the author as unknown`. Values are code spans, as for trailers.

**The property this must keep:** for every policy and every facts value, `evaluatePolicy(policy, factsWithMcp)` is at least as strict as `evaluatePolicy(policy, facts)`. Strictness: outcome order `would_approve < would_require < would_block`; at equal outcome, the set of required approvals of the MCP case contains the other's. U-PMM-3 tests this as a property over generated policies.

## 9. Mutation guard

The step 1 table already lists `POST …/pulls` as `phase1` for `guard` and `mcp`, and the gate maps `mcp` to `mcp_write` (`mode_off` when not on). Step 5 added the body rule for `guard`. This step adds the body rule for `mcp`, read from `endpoint.parse(options).body` like the others:

- `POST …/pulls` from an `mcp` client: the body is a plain object whose keys are a subset of `title`, `body`, `head`, `base`, `draft`, `maintainer_can_modify`; `head` and `base` are strings matching the D17 name rule (so no `owner:` prefix and no `graft-revert/`); `maintainer_can_modify` is absent or `false`; no `issue` key (turning an issue into a PR). Anything else is refused `feature_not_allowed`.
- No other route for `mcp`. In particular `POST …/issues/{n}/comments`, `…/labels`, `/git/*` and `/graphql` from an `mcp` client stay as they are today: a comment is a `phase0` route, so the factory must give the `mcp` client no way to reach it. **The MCP module never calls anything but `pulls.create` with the `mcp` client**, and U-MG-MCP-4 plus the §14 grep check it.

**What proves report mode inert.** In default modes the tool returns before any GitHub request (D16), and no `mcp` client is created. If a bug created one and wrote, the gate refuses with `mode_off` before the request is sent. I-MCP-9 runs `open_change` in default modes and asserts no request at all to the fake for that call; I-MCP-10 calls the write step directly with an `mcp` client while `mcp_write` is off and asserts `MutationRefusedError` with `mode_off` and an empty log.

## 10. Operator CLI

```sh
pnpm graft mcp-token create --repo owner/name --name "codex ci" [--expires-in 90] [--actor <name>]
pnpm graft mcp-token list   --repo owner/name [--all] [--json]
pnpm graft mcp-token revoke --id <uuid> --reason "<text>" [--actor <name>]
```

- `create` prints, on success and only then: one line with the token, then `id <uuid>  expires 2027-01-20  shown once; store it now`. Exit 0. Unknown or removed repository, a duplicate name, or the D11 cap → message, exit 1, nothing created. It does not need the worker or GitHub.
- `list` shows active tokens (with `--all`, revoked and expired too): id, name, `graft_mcp_<prefix>…`, created by and at, expires, last used, revoked by, at and reason. `--json` gives the same fields. Never the hash.
- `revoke` (D11). An unknown id → exit 1.
- `mode show` gains a line `mcp tokens  2 active (newest used 3 minutes ago)`; with `GRAFT_MCP=off` on this shell, `note: the MCP endpoint is off on this shell's config`.
- `pilot doctor` gains `warn` checks: "MCP tokens expiring within 7 days" and "MCP tokens never used, older than 14 days". Doctor still reads only the database.

## 11. Schema (migration `0014_mcp`)

`0014` is the number after step 5's `0013`; renumber if another migration lands first.

```sql
CREATE TABLE mcp_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix    text NOT NULL CHECK (token_prefix ~ '^[A-Za-z0-9_-]{8}$'),
  created_by      text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      text CHECK (char_length(revoked_by) BETWEEN 1 AND 100),
  revoke_reason   text CHECK (char_length(revoke_reason) BETWEEN 1 AND 200),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX mcp_tokens_active_name ON mcp_tokens (repository_id, name) WHERE revoked_at IS NULL;
CREATE INDEX mcp_tokens_repository_idx ON mcp_tokens (repository_id);

CREATE TABLE mcp_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  token_id        uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  pr_number       integer NOT NULL CHECK (pr_number > 0),
  head_sha        text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, pr_number)
);
CREATE INDEX mcp_changes_rate_idx ON mcp_changes (repository_id, created_at);

ALTER TABLE change_provenance
  ADD COLUMN mcp_report text NOT NULL DEFAULT 'none' CHECK (mcp_report IN ('none','agrees','disagrees'));
```

Use the column types `repositories.id` really has (check `0001`). The `provenance` table already allows `source = 'mcp'` (Phase 0 step 1), and `commit_sha` holds the reported head for those rows (D14); record that the Phase 0 comment "NULL for mcp" no longer holds. `down` drops exactly what `up` adds, in reverse order, after deleting `provenance` rows with `source = 'mcp'`. No token, title, body, branch name or argument is stored.

## 12. Configuration

`GRAFT_MCP` (`on`/`off`, default `on`), `GRAFT_MCP_ALLOWED_ORIGINS` (default empty), `GRAFT_MCP_RATE_LIMIT_PER_MINUTE` (default 60), `GRAFT_MCP_AUTH_FAILURES_PER_MINUTE` (default 20), `GRAFT_MCP_OPEN_CHANGE_PER_HOUR` (default 10), `GRAFT_MCP_MAX_TOKENS_PER_REPO` (default 10). Ranges in D9 and D11; a value out of range fails config parsing at start, like every other key. `.env.example` and `docs/configuration.md`. If the server runs behind a proxy, `req.ip` needs Fastify's `trustProxy`; reuse whatever the server already configures and record it.

## 13. Tasks

### T1. SDK and API verification

Record in decisions.md, from the installed packages (types and README) and GitHub's REST docs, and make the fakes match:
- (a) The exact versions of D1 are still the `latest` tags and are older than two weeks; `createMcpHandler`, `toNodeHandler`, `legacy: "stateless"`, `responseMode: "json"`, `maxRequestBodySize` and `McpHandlerRequestOptions.authInfo` exist with the meaning D2 and D3 give them. If a name changed, use the new one and record it.
- (b) How `toNodeHandler` takes `AuthInfo` (`req.auth`) and how a tool callback reads it (`ctx` / `extra.authInfo`).
- (c) What the stateless legacy leg answers to `GET` and `DELETE` (expected `405`) and to `initialize` from a `2025-11-25` client; and that a modern `2026-07-28` client gets the tool list without an `initialize` round trip.
- (d) How the SDK reports a zod input failure (`-32602` or a tool error) and whether `outputSchema` is checked on the way out.
- (e) `@modelcontextprotocol/client`: the streamable HTTP client transport and how to set the `Authorization` header for every request.
- (f) `POST …/pulls`: the 422 bodies for "a pull request already exists" and "no commits between", and `GET …/pulls?head=<owner>:<branch>&base=<b>&state=open`.
- (g) `GET …/pulls/{n}/commits`: `author` and `committer` can be `null` (no GitHub user for the email), and the 250-commit limit.

### T2. Dependencies and config

D1 pins in `package.json` (no `^`), lockfile updated, `pnpm install --frozen-lockfile` passes offline afterwards. §12 keys.

### T3. Migration and schema types

§11, `src/db/schema.ts`. Rollback test as in earlier steps; step-down tests gain `0014`.

### T4. Tokens

`src/mcp/tokens.ts` (D6), `src/modules/mcp/store.ts`, `auth.ts` (D7, D11 `last_used_at`), D12 in `upsertRepositories`.

### T5. HTTP mount

`src/modules/mcp/http.ts` (D2–D5, D9 a and b, D10), registered in `buildServer` behind `GRAFT_MCP`.

### T6. Read tools

`get_status`, `get_policy` (§7), with D8, D20, D21.

### T7. `report_provenance` and the merge

§7, §8, D13–D15: the tool, `mcpAgreement`, the job trigger, `mcp_report`, `buildFacts`, the comment line.

### T8. `open_change`

§7, D16–D18, D9 c.

### T9. Self-approval

D19: `countApprovals({ excludedLogins })`, the policy job's commit read for MCP-opened changes.

### T10. Mutation guard

§9, with U-MG-MCP tests.

### T11. CLI and doctor

§10.

### T12. Neutral suite

`test/integration/neutral.test.ts` gains an MCP scenario in both profiles. Setup: `mcp_write` requested `on` for the repository in both profiles, one token created through the store.
- **N-14 under `default`:** `get_status`, `get_policy`, `report_provenance` (disagreeing) and `open_change` against the scenario repository. The set of mutating requests is still exactly the Phase 0 set (the `report_provenance` refresh publishes the provenance check and comment, which are Phase 0 routes, through the default client). `open_change` returns `mcp_write_off` with reason `ceiling`, made no request, and no `mcp` client was created (N-8 extended: no `phase1` route and no feature client of any kind).
- **N-15 under `max`:** the same calls; `open_change` makes exactly one `POST …/pulls` through an `mcp` client, allowed by the gate. A second `open_change` with the same head adds no write (`existing: true`). N-8 for `max` is restated: every `phase1` request came from a `guard` or `mcp` client and was allowed.
- **N-16 under both:** across N-14 and N-15, the fake's log has no request to `/contents/` other than the policy file read by the existing loader, no `/git/blobs`, no `/compare/`, no `.diff` or `.patch` media type.

### T13. Docs

- New `docs/features/mcp.md` (user page): what the four tools do, how to get a token, client configuration examples (a generic streamable HTTP client with a bearer header), the privacy table (§5), the trust boundary and residual risks (§4), rate limits (per process), and what `mcp_write` changes.
- `docs/architecture.md`: an "MCP contract (Phase 1 step 6)" section: the mount, auth per request, the module's one write, the D13 merge rule, D19.
- `docs/features/modes.md` (what `mcp_write: on` now does), `docs/configuration.md` (§12), `docs/github-app.md` (no new permission: `pull_requests: write` is Phase 0's).
- `docs/decisions.md`: "Phase 1 step 6: MCP server" with the T1 answers and any deviation.
- `docs/phase-1/HUMAN-TODO.md`: §15.
- `docs/phase-1/README.md` step 6: it already links this spec and names D13, D14 and D19; add any deviation recorded in decisions.md.

## 14. Test plan

Unit:

| ID | Case |
| --- | --- |
| U-MCPT-1 | `generateToken` format, 1,000 tokens distinct; `hashToken` is SHA-256 hex of the whole string; `tokenPrefix` is 8 characters |
| U-MCPT-2 | `parseBearer`: valid; lower-case `bearer`, extra spaces, a 42- or 44-character secret, another prefix, two tokens → null |
| U-MCPT-3 | `redactTokens` replaces every token-shaped substring and nothing else |
| U-MCPS-1 | Each tool's input schema: valid input; missing `repository`; unknown key; PR number 0 and 2^31 |
| U-MCPS-2 | D17 name rule: accepts `feat/x`, `a.b-c_d`; refuses `../x`, `/x`, `-x`, `x/`, `x.lock`, `owner:x`, `graft-revert/…`, 201 characters, a space, a control character |
| U-MCPS-3 | D18: a title of 257 characters, a control character, a body of 16,001 characters; the trailer block appended last; an invalid provenance value dropped with a warning |
| U-MCPRL-1 | Token bucket: 60 in a minute pass, the 61st is refused with a `Retry-After`; refills with the injected clock; buckets are per token |
| U-MCPRL-2 | Failed-auth bucket per IP; a success does not reset it; other IPs unaffected |
| U-PMM-1 | `mcpAgreement`: no report → `none`; same agent (case differs) → `agrees`; other agent → `disagrees`; trailers `human` → `disagrees`; trailers for another head → `disagrees`; no trailers → `disagrees` |
| U-PMM-2 | `buildFacts` with `mcp_report = 'disagrees'` → `{ kind: "unknown", agent: null }`; with `agrees` or `none` → the trailer facts |
| U-PMM-3 | Property: for generated policies (require, block and approve rules over `author`, `agent`, `risk`, `paths`) and generated trailer facts, the outcome with `disagrees` is never less strict than without, and its required set contains the other's (§8) |
| U-APP-MCP-1 | `countApprovals` with `excludedLogins`: an excluded approver is skipped like the PR author, case-insensitively; others still count |
| U-MG-MCP-1 | `POST …/pulls` from an `mcp` client with a valid body: allowed when the gate allows, refused `mode_off` when it does not, never queried for the gate with a bad body |
| U-MG-MCP-2 | Refused `feature_not_allowed`: an `issue` key; `maintainer_can_modify: true`; `head: "owner:x"`; `head: "graft-revert/…"`; an extra key; a body that is not a plain object |
| U-MG-MCP-3 | `guard` body rule unchanged by this step; a `guard` client cannot use the `mcp` body and the other way round |
| U-MG-MCP-4 | An `mcp` client sending `POST …/git/refs`, `…/labels`, `/graphql` → `feature_not_allowed` or `unknown_route` |

Integration (`test/integration/mcp.test.ts`, `buildServer` on a random port, the fake GitHub world, a real MCP client):

| ID | Case |
| --- | --- |
| I-MCP-1 | Migration up/down/up |
| I-MCP-2 | **Reads with a valid token:** `tools/list` shows exactly the four tools with their schemas; `get_status` for a seeded PR returns card, provenance, verdict with `wouldBe`, guard events; `get_policy` returns the parsed policy, its hash and the modes. No GitHub write in the log |
| I-MCP-3 | **Refused tokens:** no header, a malformed header, an unknown token, an expired token, a revoked token (revoked between two calls of the same client: the second gets `401`), a token of a removed repository → `401` with identical bodies |
| I-MCP-4 | **Other repository:** a token for repo B calling any tool with `repository: A` → `forbidden_repository`; the same for a repository Graft does not know; PR numbers resolve only within B |
| I-MCP-5 | A 2025-era client (protocol `2025-11-25`, `initialize` first) and a 2026-07-28 client both list and call tools; `GET /mcp` and `DELETE /mcp` → `405` |
| I-MCP-6 | Origin: a request with `Origin: https://evil.example` → `403`; with the origin in `GRAFT_MCP_ALLOWED_ORIGINS` → served; a body over 64 KiB → `413`; `text/plain` → `415` |
| I-MCP-7 | Rate limits: the 61st call in a minute → `429` with `Retry-After`; 21 bad tokens from one IP → `429`, and the 22nd is not looked up (query counter) |
| I-MCP-8 | `report_provenance`: stale head → `stale_head`; closed PR → `pr_closed`; invalid session URL → `invalid_argument`, nothing stored; a disagreeing report on a repository with a `require` rule on `agent: [codex]` and trailers saying `claude-code` → after the job, the verdict is `would_require` with the rule uncertain (it was `would_approve`); a second, different report for that head → `already_reported`; an agreeing report → verdict unchanged; a new push → a new report allowed |
| I-MCP-9 | **Report mode inert:** `open_change` with default modes and `mcp_write` requested `on` → `mcp_write_off` reason `ceiling`; the fake logged no request at all during the call; no `mcp` client created |
| I-MCP-10 | **Report mode refused:** the write step called directly with an `mcp` client while `mcp_write` is off → `MutationRefusedError` `mode_off` before any request is logged |
| I-MCP-11 | `open_change` enforcing (ceiling `enforce`, `mcp_write on`): one `POST …/pulls` with exactly the §7 body, the trailer block last in the body, `maintainer_can_modify: false`; an `mcp_changes` row; the result's URL from stored values. Repeated → `existing: true`, no write. A 422 "already exists" → adopted by lookup |
| I-MCP-12 | `open_change` refusals with no write: `invalid_head` (default branch, `graft-revert/x`), `head_not_found`, `base_not_found`, the hourly cap → `rate_limited` (11th open in an hour with the default) |
| I-MCP-13 | Rollback mid-call: `mcp_write` set off after the early read and before `pulls.create` → the gate refuses, the tool returns `mcp_write_off` reason `mode_changed`, no `mcp_changes` row |
| I-MCP-14 | Self-approval (D19): an MCP-opened PR whose commits are authored by `alice`; `alice` approves → not counted; `bob` approves → counted; a commit with a null author → no approval counts |
| I-MCP-15 | Transfer (D12): the repository moves to another installation → every active token revoked with `system`, and the next call → `401` |
| I-MCP-16 | **Never logged:** across I-MCP-2 to I-MCP-15, the captured logs contain no token, no token hash, no PR title or body sentinel, no provenance value sentinel; the SDK `onerror` path logs a sanitised error |
| I-MCP-17 | CLI: `create` prints the token once and stores only its hash; a duplicate name, the cap, an unknown repository → exit 1; `list` (text and `--json`) has no hash; `revoke` twice → exit 0; `mode show` line; doctor warnings with exit 0 |
| I-MCP-18 | `GRAFT_MCP=off` → `/mcp` is `404`; the CLI still works |
| I-MCP-19 | No code read: across I-MCP-2 to I-MCP-15, the fake's log has no request to `/contents/` other than the policy loader's, `/git/blobs`, `/compare/`, `…/commits/{sha}` (REST commit with files), or a `.diff`/`.patch` media type |

Neutral suite: N-14, N-15, N-16 (T12).

## 15. HUMAN-TODO (add a section "Step 6: MCP server" to `docs/phase-1/HUMAN-TODO.md`)

- [ ] **Decide who gets tokens.** Only agents that already have read access to the repository (§4). Write it in the pilot runbook. Who: product owner.
- [ ] **Expose `/mcp` through the proxy** in front of the Graft server (same host as the webhook receiver), over HTTPS only. Check that the proxy does not log the `Authorization` header. Set `trustProxy` if the proxy is not the direct peer. Who: operator.
- [ ] **Create one token per pilot repository** with `pnpm graft mcp-token create`, store it in the agent's secret store, and never paste it into a PR, issue or chat. Who: operator.
- [ ] **On a sandbox repository:** configure an MCP client (for example Claude Code with an HTTP server entry and a bearer header) and call `get_status` on an open PR and `get_policy`; then `report_provenance` with a different agent name and check the comment line and the verdict; then `open_change` with `mcp_write` off (refused); then, with the ceiling at `enforce` and `mode set --mcp-write on`, open a PR from a pushed branch and check its body trailers and that your own approval does not count. Then `mcp-token revoke` and check the next call fails. Who: repo owner.
- [ ] **Check the T1 answers on real clients** that the offline build could not: a 2025-era client (protocol `2025-11-25`) and a 2026-07-28 client both work against the stateless endpoint. Who: operator.
- [ ] **Run the step 6 manual smoke test** (§16) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

## 16. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §14 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # every migration up to 0014 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0014 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/mcp/ && exit 1 || true
grep -rnE "getContent|getBlob|compareCommits|repos\.getCommit|\.diff|\.patch|/contents/|/blobs" src/modules/mcp/ src/mcp/ && exit 1 || true
grep -rn "feature: \"mcp\"" src/ | grep -v "src/modules/mcp/tools/open-change.ts" && exit 1 || true   # the only mcp client
grep -rnE "@modelcontextprotocol/sdk\b" package.json src/ && exit 1 || true                             # v2 packages only
grep -n "\"@modelcontextprotocol/[a-z]*\": \"\^" package.json && exit 1 || true                          # exact pins
grep -rn "U-MCPT-\|U-MCPS-\|U-MCPRL-\|U-PMM-\|U-APP-MCP-\|U-MG-MCP-\|I-MCP-\|N-1[456]" test/ | wc -l    # non-zero
```

**Manual smoke test** (record it in the PR description): with `pnpm dev:server` and `pnpm dev:worker`, seed a repository and a PR (the I-MCP seeder), create a token with `pnpm graft mcp-token create`, and call `tools/list` and `get_status` with `curl` (a `POST /mcp` JSON-RPC body and the bearer header): both answer. Call with a wrong token: `401`. `pnpm graft mcp-token revoke`, call again: `401`. Call `open_change`: `mcp_write_off`, and the server log shows the `mcp call` line with the outcome and no token.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| Token stored in clear, or the secret placed in `AuthInfo.token` | U-MCPT-1, I-MCP-16, I-MCP-17 |
| Revocation cached (token looked up once per process) | I-MCP-3 |
| `repository` argument trusted instead of the token's repository | I-MCP-4 |
| `open_change` skips the early mode read (creates an `mcp` client in report mode) | I-MCP-9, N-14 |
| `mcp` body rule removed | U-MG-MCP-2 |
| A disagreeing report leaves the author fact as the trailers say | U-PMM-2, I-MCP-8 |
| A disagreeing report replaces the agent with the reported one | U-PMM-3, I-MCP-8 |
| A second report for the same head overwrites the first | I-MCP-8 |
| Commit authors of an MCP-opened PR can approve it | U-APP-MCP-1, I-MCP-14 |
| Null commit author treated as nobody to exclude | I-MCP-14 |
| Hourly open cap counted in memory | I-MCP-12 (two server instances in the test) |
| Tokens kept active across a transfer | I-MCP-15 |
| Arguments logged | I-MCP-16 |

**Also required:**
- No log line, job payload, column or error message holds a token, a token hash, file content, a diff, a commit message, PR text, a tool argument or YAML.
- Every non-GET request in every test log is either a Phase 0 route or a §9 route through an `mcp` client (or a step 5 route through a `guard` client) with the mode allowing it.
- The live e2e runner's INV-1 still holds with the default sandbox (no runner change in this step).
