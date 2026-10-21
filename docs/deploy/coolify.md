# Deploying on Coolify

[Deploying Graft](README.md) · [Fly.io](fly.md)

[Coolify](https://coolify.io) deploys Graft on a server you run, from this repository, with the Docker Compose build pack. The stack is `compose.coolify.yaml` at the repository root. It has four services: `postgres`, a one-shot `migrate`, `server` (behind Coolify's Traefik proxy, with a Let's Encrypt certificate) and `worker`. Read [Deploying Graft](README.md) first for what each process does.

You need a Coolify v4 instance with a server connected to it, a domain (or wildcard domain) that points at that server, and a registered GitHub App ([GitHub App](../github-app.md)).

## Sizing

A pilot needs very little: about 100 MB of memory for the server, 150 MB for the worker and 100 MB for Postgres, and a fraction of a CPU core. The first build needs about 1 GB of memory for a minute. On a server that already runs other applications, check that much memory is free (`free -h`). Add swap if there is none, so that a build or a burst does not get a container killed.

## 1. Create the resource

1. In Coolify, open your project and environment, then **New Resource** → **Public Repository** (or **Private Repository** with a GitHub App or deploy key, if your fork is private).
2. Repository: your fork of Graft. Branch: `main`.
3. **Build Pack:** Docker Compose. **Base Directory:** `/`. **Docker Compose Location:** `/compose.coolify.yaml`.
4. Continue. Coolify reads the file and lists the four services.

## 2. Domain

Open the `server` service's settings and set its domain to `https://<your-graft-domain>` (Coolify fills a generated one from `SERVICE_FQDN_SERVER_3000` if you have a wildcard domain configured). Coolify routes it to the container's port 3000 and requests the certificate. The other services get no domain: Postgres is reachable only inside the stack.

## 3. Environment variables

In the resource's **Environment Variables** page, Coolify already shows what the file needs. `SERVICE_USER_POSTGRES` and `SERVICE_PASSWORD_POSTGRES` are generated for you, and `DATABASE_URL` is built from them inside the file. Set:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | From the App registration. |
| `GITHUB_APP_SLUG` | The App's slug. |
| `GITHUB_APP_PRIVATE_KEY` | The PEM file's contents. Mark the variable **multiline** (or paste it on one line with literal `\n`). |
| `GITHUB_WEBHOOK_SECRET` | `openssl rand -hex 32`. Keep it for the App's settings. |
| `ANTHROPIC_API_KEY` | Optional, for intent cards. |
| `GRAFT_MODE_CEILING` | Leave unset (`report`). |

Do not mark these as **build** variables: the image build needs none of them, and build variables can end up in image layers.

## 4. Deploy

Click **Deploy**. Coolify builds the image once (the three Graft services share it), starts Postgres, runs `migrate` until it exits, then starts `server` and `worker`. In the deployment logs, check:

- `migrate`: `applied: 0001_initial, …` on the first deploy, `no pending migrations` afterwards;
- `worker`: `worker started` and `mode ceiling` = `report`;
- `server`: healthy. Its healthcheck calls `/readyz`.

Then open `https://<your-graft-domain>/readyz`. It should answer `{"status":"ready","db":"ok","queue":"ok"}`.

The `migrate` service is marked `exclude_from_hc`, so its exit does not make the stack unhealthy. The worker has its healthcheck disabled because it serves no HTTP.

## 5. Point the App at Coolify

Follow [Pointing the App at the deployment](README.md#pointing-the-app-at-the-deployment), with the webhook URL `https://<your-graft-domain>/webhooks/github`.

## Operating

- **Operator CLI:** open the `worker` (or `server`) container's **Terminal** in Coolify and run `node dist/bin/graft.js mode show --installation <id>`. The container has the stack's environment.
- **Automatic deploys:** enable them in the resource's settings (a webhook from your Git provider, or Coolify's GitHub App) to redeploy on every push to `main`. Each deploy runs `migrate` first.
- **Backups:** the database lives in the `graft-pgdata` volume. Back it up with the server's own volume backups, or with a scheduled `pg_dump` (`docker exec <postgres container> pg_dump -U <user> graft`). If you would rather use Coolify's built-in scheduled database backups, create Postgres 17 as a separate Coolify **Database** resource on the same network, remove the `postgres` service from a copy of the compose file, and set `DATABASE_URL` to that database's internal URL.
- **Logs:** each service's logs in Coolify. Graft logs JSON (pino), with no tokens, diffs or PR text.

## Hardening the server

Graft holds a GitHub App private key and receives webhooks from the internet, so the server should be in decent shape:

- Run a supported OS release that still gets security updates.
- Expose only ports 80 and 443 (and SSH). Coolify's own dashboard should be reached through its domain over HTTPS, not on its raw port. Close the dashboard and realtime ports in the firewall, as Coolify's documentation recommends.
- Use SSH keys only. Limit who has passwordless `sudo`. Membership of the `docker` group is equivalent to root.
- Install the App on **selected** repositories of a sandbox organisation first ([onboarding](../pilots/onboarding.md)).
