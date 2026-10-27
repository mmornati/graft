# Deploying on Coolify

[Deploying Graft](README.md) · [Fly.io](fly.md)

[Coolify](https://coolify.io) deploys Graft on a server you run, from this repository, with the Docker Compose build pack. A Graft deployment is two resources in one Coolify project:

- **Postgres**, a Coolify **Database** resource (PostgreSQL 18). It is infrastructure: created once, never touched by a Graft deploy, and backed up by Coolify's scheduled database backups.
- **Graft**, an **Application** built from `compose.coolify.yaml` at the repository root. It holds only the code: a one-shot `migrate`, `server` (behind Coolify's Traefik proxy, with a Let's Encrypt certificate) and `worker`. Every deploy rebuilds and replaces these three, and nothing else.

Keeping Postgres out of the compose file matters: with Coolify's default container naming (generated names, for rolling updates), every deploy of a compose stack creates new containers for all its services, so a database inside the stack is stopped and started again on each push. Read [Deploying Graft](README.md) first for what each process does.

You need a Coolify v4 instance with a server connected to it, a domain (or wildcard domain) that points at that server, and a registered GitHub App ([GitHub App](../github-app.md)).

## Sizing

A pilot needs very little: about 100 MB of memory for the server, 150 MB for the worker and 100 MB for Postgres, and a fraction of a CPU core. The first build needs about 1 GB of memory for a minute. On a server that already runs other applications, check that much memory is free (`free -h`). Add swap if there is none, so that a build or a burst does not get a container killed.

## 1. Create the database

1. In Coolify, open your project and environment, then **New Resource** → **PostgreSQL** → **PostgreSQL 18** (the `postgres:18-alpine` image; Coolify mounts its volume at `/var/lib/postgresql`, the path the 18 images expect). Put it on the same server and destination (Docker network) you will use for Graft.
2. Name it, for example, `graft-postgres`. Set **Initial Database** to `graft`; keep the generated user and password.
3. Leave **Make it publicly available** off: only Graft reaches it, over the Docker network.
4. **Start** it, then copy its **Postgres URL (internal)**, of the form `postgres://<user>:<password>@<database uuid>:5432/graft`. You need it in step 4.
5. In its **Backups** tab, add a scheduled backup (daily is plenty for a pilot), to S3 storage if you have one configured.

## 2. Create the Graft resource

1. In Coolify, open your project and environment, then **New Resource** → **Public Repository** (or **Private Repository** with a GitHub App or deploy key, if your fork is private).
2. Repository: your fork of Graft. Branch: `main`.
3. **Build Pack:** Docker Compose. **Base Directory:** `/`. **Docker Compose Location:** `/compose.coolify.yaml`.
4. Continue. Coolify reads the file and lists the three services.
5. In **Advanced** → **Docker compose**, turn on **Connect to predefined network**. Without it the stack runs on its own isolated network and cannot resolve the database's hostname.

## 3. Domain

Open the `server` service's settings and set its domain to `https://<your-graft-domain>` (Coolify fills a generated one from `SERVICE_FQDN_SERVER_3000` if you have a wildcard domain configured). Coolify routes it to the container's port 3000 and requests the certificate. The other services get no domain.

## 4. Environment variables

In the resource's **Environment Variables** page, Coolify already shows what the file needs. Set:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The database's **Postgres URL (internal)** from step 1. |
| `GITHUB_APP_ID` | From the App registration. |
| `GITHUB_APP_SLUG` | The App's slug. |
| `GITHUB_APP_PRIVATE_KEY` | The PEM file's contents. Mark the variable **multiline** (or paste it on one line with literal `\n`). |
| `GITHUB_WEBHOOK_SECRET` | `openssl rand -hex 32`. Keep it for the App's settings. |
| `ANTHROPIC_API_KEY` | Optional, for intent cards. |
| `GRAFT_LLM_PROVIDERS` | Optional: a [provider registry](../model-providers.md) inline (one-line JSON is easiest). Each key variable it names must also be added to the `x-graft-env` block of `compose.coolify.yaml`, or the containers never see it. |
| `GRAFT_MODE_CEILING` | Leave unset (`report`). |

Do not mark these as **build** variables: the image build needs none of them, and build variables can end up in image layers.

## 5. Deploy

Click **Deploy**. Coolify builds the image once (the three Graft services share it), runs `migrate` against the database until it exits, then starts `server` and `worker`. The database keeps running throughout. In the deployment logs, check:

- `migrate`: `applied: 0001_initial, …` on the first deploy, `no pending migrations` afterwards;
- `worker`: `worker started` and `mode ceiling` = `report`;
- `server`: healthy. Its healthcheck calls `/readyz`.

Then open `https://<your-graft-domain>/readyz`. It should answer `{"status":"ready","db":"ok","queue":"ok"}`.

The `migrate` service is marked `exclude_from_hc`, so its exit does not make the stack unhealthy. The worker has its healthcheck disabled because it serves no HTTP.

## 6. Point the App at Coolify

Follow [Pointing the App at the deployment](README.md#pointing-the-app-at-the-deployment), with the webhook URL `https://<your-graft-domain>/webhooks/github`.

## Operating

- **Operator CLI:** open the `worker` (or `server`) container's **Terminal** in Coolify and run `node dist/bin/graft.js mode show --installation <id>`. The container has the stack's environment.
- **Automatic deploys:** enable them in the resource's settings (a webhook from your Git provider, or Coolify's GitHub App) to redeploy on every push to `main`. Each deploy runs `migrate` first and leaves the database alone.
- **Backups:** the database resource's **Backups** tab (step 1). Test a restore once before you rely on it.
- **Database upgrades and restarts** are done on the database resource, when you choose, not by a Graft deploy. Stop the Graft resource first if the database will be down for more than a few seconds.
- **Logs:** each service's logs in Coolify. Graft logs JSON (pino), with no tokens, diffs or PR text.

## Hardening the server

Graft holds a GitHub App private key and receives webhooks from the internet, so the server should be in decent shape:

- Run a supported OS release that still gets security updates.
- Expose only ports 80 and 443 (and SSH). Coolify's own dashboard should be reached through its domain over HTTPS, not on its raw port. Close the dashboard and realtime ports in the firewall, as Coolify's documentation recommends.
- Use SSH keys only. Limit who has passwordless `sudo`. Membership of the `docker` group is equivalent to root.
- Install the App on **selected** repositories of a sandbox organisation first ([onboarding](../pilots/onboarding.md)).

## Migrating from the single-stack layout

Earlier versions of `compose.coolify.yaml` ran Postgres 17 inside the Graft stack, in a volume named `<resource uuid>_graft-pgdata`. Moving an existing deployment to the two-resource layout also upgrades it to Postgres 18: the data moves by dump and restore, which works across major versions, so the old data directory is never opened by the new server. With a few minutes of downtime:

1. **Create the database** as in [step 1](#1-create-the-database), with **Initial Database** `graft`, and start it. Note its container name (the database uuid) and user.
2. **Prepare the Graft resource**, without deploying: turn off **Auto deploy** for now, turn on **Connect to predefined network** ([step 2](#2-create-the-graft-resource)), and add `DATABASE_URL` with the new database's internal URL ([step 4](#4-environment-variables)).
3. **Stop writes.** On the server, stop the old `server-<uuid>-…` and `worker-<uuid>-…` containers (`docker ps --filter name=<resource uuid>` lists them). Leave the old `postgres-<uuid>-…` container running.
4. **Copy the data**, on the server:

   ```bash
   docker exec <old postgres container> pg_dump -U <old user> -Fc graft \
     | docker exec -i <database uuid> pg_restore -U <new user> -d graft --no-owner --no-acl
   ```

   The old user is the resource's `SERVICE_USER_POSTGRES` variable. `pg_restore` from 18 reads a dump made by `pg_dump` 17. Check the row counts of a few tables on both sides, then run `ANALYZE` on the new database (a restore does not carry planner statistics).
5. **Deploy** the new `compose.coolify.yaml`. `migrate` should log `no pending migrations`, and `/readyz` should answer `ready`. Turn **Auto deploy** back on.
6. **Clean up** after a week of normal running. If `docker ps` still lists the old `postgres-<uuid>-…` container, stop and remove it. Delete the `SERVICE_USER_POSTGRES` and `SERVICE_PASSWORD_POSTGRES` variables and remove the orphaned volume (`docker volume rm <resource uuid>_graft-pgdata`) once you no longer want it as a fallback.

To roll back before step 6, redeploy the previous commit of `compose.coolify.yaml`: it starts Postgres again on the old, untouched volume. Anything Graft wrote after step 5 stays in the new database only.
