# Operator console

[Docs index](README.md) · [Deploying Graft](deploy/README.md) · [Coolify](deploy/coolify.md) · [Pilots and the gate](features/pilots-and-gate.md)

The console is an optional web app for whoever runs Graft. It reads what Graft recorded in its database and shows it as a daily journal: the pull requests Graft handled, their intent cards and verdicts, guard events, the token budget, the gate, and the job queue. Anything that needs a human is pinned in the margin.

Its database connection is **read-only**. By default, every action stays in the CLI: where the console shows a problem, it gives you the `pnpm graft …` command to copy. With an optional authenticated connection to Graft, repository administrators can manage repository activation and billing-team memberships. The console never gains database-write access or a GitHub App private key; Graft verifies permissions and performs these narrowly scoped changes.

Graft does not need the console. It runs in a container of its own, from its own image, with its own database role, and none of Graft's GitHub App or model credentials. Optional repository management uses a dedicated shared bridge secret.

## What it shows

| View | What you read there |
| --- | --- |
| **Journal** (`#/`) | One page per day, in your browser's time zone: a summary sentence, the day's totals, then every entry newest first. An entry is a pull request (its card's goal, final risk class with the floor it was raised from, what the verifier said, the policy outcome), a guard event, a break-glass or a mode change. Open a pull request to read its record: provenance, the verifier's determination, the risk stamp, every card version and the CLI commands. The margin lists what needs you, the gate, and the token budget per repository. |
| **Changes** (`#/changes`) | Every pull request, newest first, one column per handler (author, writer, verifier, floor, policy, guard). Filters by repository, state, risk, verifier and author. |
| **Change** (`#/changes/<id>`) | One pull request's whole record, with every intent card written for it. |
| **Gate** (`#/gate`) | Card votes split the way the Phase 0 gate splits them (a vote by the PR's author never counts), the Wilson interval against the 90% target, and what the models did. A preview: `pnpm graft gate report --phase 0` is the authoritative report. |
| **System** (`#/system`) | Jobs by name (done, waiting, oldest waiting, failed), webhook deliveries by event, the models that wrote, first-passed or verified cards (as recorded: `<provider id>/<model>` with a [provider registry](configuration.md#model-providers)), why cards were unavailable and why verifiers failed, repositories and modes, mode changes, the break-glass audit and MCP tokens (name and prefix, never the token). |
| **Repositories** (`#/repositories`) | The enabled-repository list, whether filtering is on, and paginated GitHub repository search within an active installation. Only repository admins can enable or disable a repository; disabling requires confirmation. Needs the optional Graft connection described below. |
| **Billing** (`#/billing`) | Billing teams and their repository memberships, plus a monthly per-model statement with input/output/cache tokens, estimated USD cost, unpriced calls and adjustments. Export the statement as CSV or JSON. Months close automatically in UTC once every call has a price; closed statements stay immutable and corrections appear in a later open month. Needs the optional Graft connection. See the [team token chargeback guide](features/team-token-chargeback.md). |

**Needs you** pins, newest and most urgent first:

- a guard event that needs a human, is ambiguous or failed, and one that is still confirming;
- a repository whose `graft.yaml` is invalid on an open or recently merged pull request;
- cards not written in the last 24 hours, because the token budget ran out or the model call failed;
- votes that all come from PR authors, so the gate has nothing to count;
- a suspended installation, or one whose permissions were never read;
- a mode change the worker has not applied after ten minutes;
- failed jobs in the last 24 hours.

The console shows only what Graft stores: ids, numbers, SHAs, paths, logins and the models' own prose. There are no pull request titles, bodies or diffs, because Graft never stores them.

## How it is built

```mermaid
flowchart LR
  B[Browser] -- "HTTPS, session cookie" --> C["console container<br/>Fastify BFF + web app"]
  C -- "SELECT only<br/>role graft_console" --> P[(Graft's Postgres)]
  C -. "sign-in only" .-> G[GitHub OAuth]
  S[Graft server and worker] --> P
  C -- "optional signed administration requests" --> S
```

- **Language and stack:** TypeScript on Node 24, like Graft: a [Fastify](https://fastify.dev) backend-for-frontend (BFF) and a small [Preact](https://preactjs.com) web app, both bundled with esbuild. It lives in `console/`, a pnpm project of its own with its own lockfile, so Graft's install and image never include it.
- **The BFF is the only thing that touches the database.** The browser calls fixed JSON routes for the journal, changes, system, repositories and billing; it never sends SQL and never sees a connection string. Billing writes go through the signed Graft bridge, not the read-only console connection.
- **Graft's schema types.** The console imports Graft's `src/db/schema.ts` as types only, so a column Graft renames breaks the console's typecheck, not a query in production. Its integration tests run against a database migrated by Graft's own migrations.

## Security

- **Two read-only locks.** The console connects as `graft_console`, a role with `SELECT` and nothing else, created by [`console/sql/readonly-role.sql`](https://github.com/mmornati/graft/blob/main/console/sql/readonly-role.sql). On top of that, every connection sets `default_transaction_read_only=on` and a statement timeout. At start the console checks both and refuses to run if its role can `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` any table (or is a superuser), unless you set `CONSOLE_REQUIRE_READONLY_ROLE=false` for local use.
- **Sign-in with GitHub, restricted by either allow-list.** A login or numeric user id in `CONSOLE_ALLOWED_USERS`, **or** active membership in a `CONSOLE_ALLOWED_ORGANIZATIONS` organization, grants access. Numeric user ids survive a rename; organization entries are logins. Organization membership is checked through Graft's installation token, including private membership, and cached for at most one minute; it requires an active installation with `members: read`. The OAuth App still asks for no scopes. The GitHub login token is dropped after identity lookup; the console keeps only a signed, `HttpOnly`, `SameSite=Lax` cookie with login, id and expiry (`CONSOLE_SESSION_HOURS`, 12 by default). Removing a directly allowed user locks them out on the next request unless they still qualify through an allowed organization.
- **Shared operator visibility.** Both allow-lists grant access to the entire dashboard, not just an organization's or a user's repositories. Repository-admin checks restrict activation changes, not visibility. Use only trusted organizations.
- **Narrow administration bridge.** Optional requests to Graft carry a short-lived HMAC signature binding the timestamp, method, path, body and verified user identity. The bridge secret stays server-side. Graft checks current repository-admin permission and immutable user id for each activation or billing-membership change, and verifies repository installation access. Browser mutations require a same-origin JSON request; the internal service API rejects browser origins.
- **No sign-in only on loopback.** `CONSOLE_AUTH=none` is refused unless `HOST` is `127.0.0.1`, `::1` or `localhost`.
- **Strict headers.** `Content-Security-Policy: default-src 'self'` with no inline script or style, fonts served by the console itself (no third-party requests), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on every API answer.
- **No Graft credentials in the container.** It needs no GitHub App key, webhook secret or Anthropic key. Its own OAuth, session, database and optional administration-bridge secrets must remain runtime-only.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_DATABASE_URL` | (required) | Postgres URL of the `graft_console` role. Never Graft's own `DATABASE_URL`. |
| `CONSOLE_AUTH` | `github` | `github`, or `none` on a loopback `HOST` only. |
| `CONSOLE_PUBLIC_URL` | (required for `github`) | The console's public URL, for example `https://console.graft.example.com`. The OAuth callback is `<CONSOLE_PUBLIC_URL>/auth/callback`. |
| `CONSOLE_GITHUB_CLIENT_ID`, `CONSOLE_GITHUB_CLIENT_SECRET` | (required for `github`) | From a GitHub OAuth App (below). |
| `CONSOLE_ALLOWED_USERS` | empty | Comma-separated GitHub logins or numeric user ids. With `github`, at least this list or the organization list must be nonempty. |
| `CONSOLE_ALLOWED_ORGANIZATIONS` | empty | Comma-separated organization logins whose active members can enter the entire console. Requires the Graft connection and an active App installation with `members: read` on each organization. Membership lookup failures do not grant access. |
| `CONSOLE_GRAFT_URL` | unset | Graft server's base URL, without a path (for example `https://graft.example.com`, or an internal service URL on a trusted container network). Set with `CONSOLE_GRAFT_SECRET`. Enables repository and billing-team management through Graft, not direct database writes. Use HTTPS outside a trusted private network. |
| `CONSOLE_GRAFT_SECRET` | unset | At least 32 characters; must match Graft's `GRAFT_CONSOLE_SECRET`. Keep runtime-only and server-side. The two server clocks must agree within 30 seconds. |
| `CONSOLE_SESSION_SECRET` | (required for `github`) | At least 32 characters: `openssl rand -hex 32`. Changing it signs everyone out. |
| `CONSOLE_SESSION_HOURS` | `12` | Session length, 1 to 168. |
| `CONSOLE_TIME_ZONE` | `UTC` | Fallback time zone for days. The web app sends the browser's own. |
| `CONSOLE_DAILY_TOKEN_BUDGET` | `2000000` | Keep equal to Graft's `GRAFT_LLM_DAILY_TOKEN_BUDGET`; it draws the budget line. |
| `CONSOLE_REQUIRE_READONLY_ROLE` | `true` | `false` lets the console start with a role that can write (local development only; the session stays read-only). |
| `CONSOLE_STATEMENT_TIMEOUT_MS` | `10000` | Per-query timeout. |
| `HOST`, `PORT`, `LOG_LEVEL` | `127.0.0.1`, `3100`, `info` | The image sets `HOST=0.0.0.0`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and the other `OTEL_*` | unset | Traces and metrics, as for Graft: see [Observability](observability.md#the-console). Off when unset. |

Application tables are resolved through the connection's PostgreSQL `search_path`, not a fixed
`public` schema. Set the console role's search path to the schema used by Graft's migrations.
Run `console/sql/readonly-role.sql` with that schema first in the owner's search path; it grants
access to the current schema and sets the console role's per-database search path to match.
The startup check rejects write access to tables in any schema on the effective search path,
as well as the separate `pgboss` schema.

## Repository activation

Install the GitHub App on all repositories, then control processing separately in Graft:

1. Start the updated Graft server to apply migrations for the `enabled_repositories` and `repository_filter_changes` tables automatically, or run `pnpm db:migrate` explicitly before starting workers and the console.
2. Generate a dedicated secret with `openssl rand -hex 32`. Set it as `GRAFT_CONSOLE_SECRET` on Graft and `CONSOLE_GRAFT_SECRET` on the console; set `CONSOLE_GRAFT_URL` to the reachable Graft server.
3. Configure `CONSOLE_ALLOWED_USERS`, `CONSOLE_ALLOWED_ORGANIZATIONS`, or both. Organization access does not require additional OAuth scopes, but Graft's GitHub App must have `members: read`.
4. Sign in, open **Repositories**, select an installation account and search by repository name (at least two characters). Search includes forks and uses GitHub's Search Repositories API in pages of ten; it does not enumerate every repository in a large organization. GitHub limits search to its first 1,000 matches, so refine broad searches. Results outside the App's installation selection are omitted.
5. Enable the repositories you administer. Set `GRAFT_REPOSITORY_FILTER=on` on the Graft server and every worker, then restart them. You may prepare the list while filtering is off.

When filtering is on, new repositories are disabled by default. Changes to the list take effect without a deployment. Enabling starts processing **future events**, not a retrospective review of every existing PR. Disabling skips future repository events and queued repository jobs, and the GitHub mutation guard refuses subsequent repository writes from an in-flight job. A model request already sent cannot be undone. Global maintenance and installation lifecycle processing continue.

Activation is separate from report/enforce modes. Renaming a repository within the same installation preserves activation; removing it, reinstalling after deletion, or transferring it to a different installation requires enabling it again. An App installed on all repositories still has access to them: this is a processing filter, not a GitHub permission boundary.

Disabling does **not** remove existing comments, checks, or branch-protection requirements. Before disabling a repository, remove Graft's required checks from its rules if appropriate; otherwise future PRs may wait for checks Graft no longer publishes. Existing guard revert PRs and any previously enabled GitHub auto-merge remain as they are.

## Team token chargeback

The [team token chargeback guide](features/team-token-chargeback.md) covers setup, allocation rules, pricing, unpriced calls, monthly close, corrections, exports and purge retention. The **Billing** tab requires the same optional Graft connection as repository activation; the console never receives database write access or the GitHub App key.

## Deploying on Coolify

The console is a second Coolify resource in the same project as Graft. Deploying one never restarts the other.

### 1. Create the read-only role

Run the script once against Graft's database, as the role that owns Graft's tables (the user in Graft's `DATABASE_URL`). From the server, through the database container:

```bash
docker exec -i <graft-postgres container> psql -U <graft user> -d graft -v console_password="'<a long random password>'" -f - < console/sql/readonly-role.sql
```

Run it again after Graft's worker has started at least once, so the role can also read the job queue (the `pgboss` schema). It is safe to run any number of times.

### 2. Register a GitHub OAuth App

In GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App** (or the same under your organisation):

- **Homepage URL:** the console's URL.
- **Authorization callback URL:** `https://<console domain>/auth/callback`.

Generate a client secret. The console asks for no scope: it only reads who signed in. A separate OAuth App keeps the console apart from Graft's GitHub App, which you can rotate or delete without touching Graft.

### 3. Create the resource

1. **New Resource → Public Repository** (or private), your fork of Graft, branch `main`.
2. **Build Pack:** Docker Compose. **Base Directory:** `/console`. **Docker Compose Location:** `/compose.coolify.yaml`.
3. **Advanced → Docker compose:** turn on **Connect to predefined network**, so the database hostname resolves.
4. Set the `console` service's domain to `https://<console domain>`.
5. Environment variables: `CONSOLE_DATABASE_URL` (the database's internal URL with the `graft_console` user and the password from step 1), `CONSOLE_PUBLIC_URL`, `CONSOLE_GITHUB_CLIENT_ID`, `CONSOLE_GITHUB_CLIENT_SECRET`, `CONSOLE_ALLOWED_USERS` and/or `CONSOLE_ALLOWED_ORGANIZATIONS`, `CONSOLE_SESSION_SECRET`, and `CONSOLE_TIME_ZONE` if you want a default other than UTC. For organization access or repository management, also set `CONSOLE_GRAFT_URL` and `CONSOLE_GRAFT_SECRET`. None is needed to build the image. Coolify makes variables available at build time by default and turns them into Dockerfile `ARG`s, which stay in image history. Keep `CONSOLE_DATABASE_URL`, `CONSOLE_GITHUB_CLIENT_SECRET`, `CONSOLE_SESSION_SECRET`, and `CONSOLE_GRAFT_SECRET` **runtime-only**. Do the same for `GRAFT_CONSOLE_SECRET` on Graft.
6. **Deploy.** The log shows `connected read-only` with `roleReadOnly: true`. If it says the role can write, `CONSOLE_DATABASE_URL` points at Graft's own user.

Anywhere else, use the [published image](deploy/README.md#published-images) `ghcr.io/mmornati/graft-console:<version>`, or build it with `docker build -t graft-console console/`; it listens on port 3100 and its healthcheck calls `/readyz`.

## Running it locally

```bash
pnpm --dir console install
```

```bash
CONSOLE_DATABASE_URL=postgres://graft:graft@localhost:55432/graft CONSOLE_AUTH=none CONSOLE_REQUIRE_READONLY_ROLE=false pnpm --dir console dev
```

Alternatively, save the console variables in `console/.env` and run `pnpm --dir console dev`. The development command loads this file when present; variables already exported in the shell take precedence.

Open <http://127.0.0.1:3100>. `dev` rebuilds the web app and the BFF on change and restarts the server. The tests (`pnpm --dir console test`) need the same local Postgres as Graft's (`pnpm db:up`); they create their own database, `graft_console_test`.
