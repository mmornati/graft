# Operator console

[Docs index](README.md) · [Deploying Graft](deploy/README.md) · [Coolify](deploy/coolify.md) · [Pilots and the gate](features/pilots-and-gate.md)

The console is an optional web app for whoever runs Graft. It reads what Graft recorded in its database and shows it as a daily journal: the pull requests Graft handled, their intent cards and verdicts, guard events, the token budget, the gate, and the job queue. Anything that needs a human is pinned in the margin.

It is **read-only**. It never writes to the database and never calls GitHub except to learn who signed in. Every action stays in the CLI: where the console shows a problem, it gives you the `pnpm graft …` command to copy.

Graft does not need the console. It runs in a container of its own, from its own image, with its own database role, and none of Graft's secrets.

## What it shows

| View | What you read there |
| --- | --- |
| **Journal** (`#/`) | One page per day, in your browser's time zone: a summary sentence, the day's totals, then every entry newest first. An entry is a pull request (its card's goal, final risk class with the floor it was raised from, what the verifier said, the policy outcome), a guard event, a break-glass or a mode change. Open a pull request to read its record: provenance, the verifier's determination, the risk stamp, every card version and the CLI commands. The margin lists what needs you, the gate, and the token budget per repository. |
| **Changes** (`#/changes`) | Every pull request, newest first, one column per handler (author, writer, verifier, floor, policy, guard). Filters by repository, state, risk, verifier and author. |
| **Change** (`#/changes/<id>`) | One pull request's whole record, with every intent card written for it. |
| **Gate** (`#/gate`) | Card votes split the way the Phase 0 gate splits them (a vote by the PR's author never counts), the Wilson interval against the 90% target, and what the models did. A preview: `pnpm graft gate report --phase 0` is the authoritative report. |
| **System** (`#/system`) | Jobs by name (done, waiting, oldest waiting, failed), webhook deliveries by event, repositories and modes, mode changes, the break-glass audit and MCP tokens (name and prefix, never the token). |

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
```

- **Language and stack:** TypeScript on Node 24, like Graft: a [Fastify](https://fastify.dev) backend-for-frontend (BFF) and a small [Preact](https://preactjs.com) web app, both bundled with esbuild. It lives in `console/`, a pnpm project of its own with its own lockfile, so Graft's install and image never include it.
- **The BFF is the only thing that touches the database.** The browser calls a handful of JSON routes (`/api/days`, `/api/days/<date>`, `/api/overview`, `/api/changes`, `/api/changes/<id>`, `/api/system`); each is a fixed, parameterised query. The browser never sends SQL and never sees a connection string.
- **Graft's schema types.** The console imports Graft's `src/db/schema.ts` as types only, so a column Graft renames breaks the console's typecheck, not a query in production. Its integration tests run against a database migrated by Graft's own migrations.

## Security

- **Two read-only locks.** The console connects as `graft_console`, a role with `SELECT` and nothing else, created by [`console/sql/readonly-role.sql`](https://github.com/mmornati/graft/blob/main/console/sql/readonly-role.sql). On top of that, every connection sets `default_transaction_read_only=on` and a statement timeout. At start the console checks both and refuses to run if its role can `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` any table (or is a superuser), unless you set `CONSOLE_REQUIRE_READONLY_ROLE=false` for local use.
- **Sign-in with GitHub, restricted to a list.** Only the logins or numeric user ids in `CONSOLE_ALLOWED_USERS` get in. Numeric ids survive a rename; logins are easier to read. The GitHub token is used once to read who signed in and is then dropped. The console keeps only a signed, `HttpOnly`, `SameSite=Lax` cookie with the login, the id and an expiry (`CONSOLE_SESSION_HOURS`, 12 by default). Removing someone from the list locks them out on their next request.
- **No sign-in only on loopback.** `CONSOLE_AUTH=none` is refused unless `HOST` is `127.0.0.1`, `::1` or `localhost`.
- **Strict headers.** `Content-Security-Policy: default-src 'self'` with no inline script or style, fonts served by the console itself (no third-party requests), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on every API answer.
- **Nothing secret in the container.** It needs no GitHub App key, webhook secret or Anthropic key.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_DATABASE_URL` | (required) | Postgres URL of the `graft_console` role. Never Graft's own `DATABASE_URL`. |
| `CONSOLE_AUTH` | `github` | `github`, or `none` on a loopback `HOST` only. |
| `CONSOLE_PUBLIC_URL` | (required for `github`) | The console's public URL, for example `https://console.graft.example.com`. The OAuth callback is `<CONSOLE_PUBLIC_URL>/auth/callback`. |
| `CONSOLE_GITHUB_CLIENT_ID`, `CONSOLE_GITHUB_CLIENT_SECRET` | (required for `github`) | From a GitHub OAuth App (below). |
| `CONSOLE_ALLOWED_USERS` | (required for `github`) | Comma-separated GitHub logins or numeric user ids. |
| `CONSOLE_SESSION_SECRET` | (required for `github`) | At least 32 characters: `openssl rand -hex 32`. Changing it signs everyone out. |
| `CONSOLE_SESSION_HOURS` | `12` | Session length, 1 to 168. |
| `CONSOLE_TIME_ZONE` | `UTC` | Fallback time zone for days. The web app sends the browser's own. |
| `CONSOLE_DAILY_TOKEN_BUDGET` | `2000000` | Keep equal to Graft's `GRAFT_LLM_DAILY_TOKEN_BUDGET`; it draws the budget line. |
| `CONSOLE_REQUIRE_READONLY_ROLE` | `true` | `false` lets the console start with a role that can write (local development only; the session stays read-only). |
| `CONSOLE_STATEMENT_TIMEOUT_MS` | `10000` | Per-query timeout. |
| `HOST`, `PORT`, `LOG_LEVEL` | `127.0.0.1`, `3100`, `info` | The image sets `HOST=0.0.0.0`. |

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
5. Environment variables: `CONSOLE_DATABASE_URL` (the database's internal URL with the `graft_console` user and the password from step 1), `CONSOLE_PUBLIC_URL`, `CONSOLE_GITHUB_CLIENT_ID`, `CONSOLE_GITHUB_CLIENT_SECRET`, `CONSOLE_ALLOWED_USERS`, `CONSOLE_SESSION_SECRET`, and `CONSOLE_TIME_ZONE` if you want a default other than UTC. None of them is needed to build the image. Coolify makes every variable available at build time by default and turns those into Dockerfile `ARG`s, which stay in the image history. On the three secrets (`CONSOLE_DATABASE_URL`, `CONSOLE_GITHUB_CLIENT_SECRET`, `CONSOLE_SESSION_SECRET`), set **Build time** to not available.
6. **Deploy.** The log shows `connected read-only` with `roleReadOnly: true`. If it says the role can write, `CONSOLE_DATABASE_URL` points at Graft's own user.

Anywhere else, the image is `docker build -t graft-console console/`; it listens on port 3100 and its healthcheck calls `/readyz`.

## Running it locally

```bash
pnpm --dir console install
```

```bash
CONSOLE_DATABASE_URL=postgres://graft:graft@localhost:55432/graft CONSOLE_AUTH=none CONSOLE_REQUIRE_READONLY_ROLE=false pnpm --dir console dev
```

Open <http://127.0.0.1:3100>. `dev` rebuilds the web app and the BFF on change and restarts the server. The tests (`pnpm --dir console test`) need the same local Postgres as Graft's (`pnpm db:up`); they create their own database, `graft_console_test`.
