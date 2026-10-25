# Deploying Graft

[Docs index](../README.md) · [GitHub App](../github-app.md) · [Configuration](../configuration.md)

Running Graft on your laptop with a smee tunnel ([GitHub App](../github-app.md)) is enough to try it. A deployment gives the App a stable public HTTPS webhook URL and keeps the worker's crons running when your laptop is off. That is what pilots need.

- [Fly.io](fly.md): managed machines, Fly Managed Postgres, `fly deploy`.
- [Coolify](coolify.md): your own server, Docker Compose, Traefik and Let's Encrypt.

## What runs

One image (the `Dockerfile` at the repository root) holds everything. It runs as three kinds of process:

| Process | Command | Notes |
| --- | --- | --- |
| Server | `node dist/bin/server.js` (the image's default) | Receives webhooks at `POST /webhooks/github`, verifies them, records the delivery and enqueues a job. `GET /healthz` (process up) and `GET /readyz` (Postgres and queue reachable). Listens on `HOST:PORT`, `0.0.0.0:3000` in the image. |
| Worker | `node dist/bin/worker.js` | Runs the jobs and the crons (feedback polling, rollups, `modes.apply`, permission refresh). No HTTP port. At least one must always run. Several are safe, because pg-boss shares the work. |
| Migrations | `node dist/bin/migrate.js up` | One-shot, before new server and worker versions start. Both refuse to start while a migration is pending. |

Both long-running processes share one **Postgres 17** database, which also holds the queue (pg-boss). Graft stores no code, diffs or PR text (see [architecture](../architecture.md#contracts)), so the database stays small. Back it up anyway: it holds the audit trail of mode changes and the pilot data.

The optional [operator console](../console.md) is not part of this image: it has its own (`console/Dockerfile`), its own read-only database role and none of these secrets.

The operator CLI runs in the same image: `node dist/bin/graft.js <command>` (for example `mode show --installation <id>` or `pilot doctor`). Inside a container it reads the same environment as the server.

## Configuration

Set these as secrets on the platform, never in a file in the repository:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The Postgres connection string. |
| `GITHUB_APP_ID` | From the App registration. |
| `GITHUB_APP_PRIVATE_KEY` | The App's PEM key, inline. Real newlines and literal `\n` both work. (`GITHUB_APP_PRIVATE_KEY_PATH` also works if the platform mounts files.) |
| `GITHUB_WEBHOOK_SECRET` | At least 16 characters. `openssl rand -hex 32`. Must equal the App's webhook secret. |
| `GITHUB_APP_SLUG` | The App's slug (recommended, see [GitHub App](../github-app.md)). |
| `ANTHROPIC_API_KEY` | Optional. Without it every intent card shows as unavailable, with the rule-based risk floor. Or use a token or [federation](../configuration.md#deploying-with-federation). |

The image sets `NODE_ENV=production`, `HOST=0.0.0.0` and `PORT=3000`. In production the example webhook secret from `.env.example` is refused. Leave `GRAFT_MODE_CEILING` at `report` (the default) until the Phase 1 rollout runbook says otherwise. Every other variable is in [configuration](../configuration.md).

## Pointing the App at the deployment

1. Deploy and check `https://<your-domain>/readyz` answers `{"status":"ready",…}`.
2. In the App's settings on GitHub (Developer settings, GitHub Apps, your App), set the **Webhook URL** to `https://<your-domain>/webhooks/github` and the **Webhook secret** to the value of `GITHUB_WEBHOOK_SECRET`. An App registered for local testing with a smee URL can be switched this way; nothing else changes.
3. In the App's **Advanced** tab, **Recent Deliveries** should show the next event with response `202`. A `401` means the secrets differ. A timeout means the URL is not reachable.
4. Open a PR in a sandbox repository. The three Graft check runs and the comment should appear within a minute or two.

## Upgrading

Deploy the new image. The platform runs the migrations first (Fly's `release_command`, Coolify's `migrate` service), then replaces the server and the worker. A failed migration stops the deploy and leaves the old version running.
