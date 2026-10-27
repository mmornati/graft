# Deploying on Fly.io

[Deploying Graft](README.md) · [Coolify](coolify.md)

Graft runs on Fly.io as one app with two process groups (`app` for the server, `worker` for the worker), migrations as the release command, and a Fly Managed Postgres database. Read [Deploying Graft](README.md) first for what each process does.

You need the [`flyctl`](https://fly.io/docs/flyctl/install/) CLI, a Fly.io account (`fly auth login`) and a registered GitHub App ([GitHub App](../github-app.md)).

## 1. Create the app

From the repository root:

```sh
cp deploy/fly.toml.example fly.toml
```

Edit `fly.toml`: set `app` to a globally unique name and `primary_region` to the region closest to your Postgres (for example `cdg`, `fra`, `iad`). Then register the app without deploying:

```sh
fly apps create <app-name>
```

The configuration runs the server with `auto_stop_machines = "off"` and `min_machines_running = 1`. GitHub waits at most 10 seconds for a webhook answer, so a cold start could time out. The worker group has no HTTP service and is never stopped by Fly.

## 2. Create the database

Create a Fly Managed Postgres cluster in the same region, on Postgres 17:

```sh
fly mpg create
```

Copy the cluster's connection string (from the command's output or the Fly dashboard, under the cluster's Connect tab) and keep it for the next step. Any other Postgres 17 that the app can reach works as well. Graft only needs the URL.

## 3. Set the secrets

```sh
fly secrets set --app <app-name> --stage \
  DATABASE_URL='postgres://…' \
  GITHUB_APP_ID=<id> \
  GITHUB_APP_SLUG=<slug> \
  GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  GITHUB_APP_PRIVATE_KEY="$(cat /path/to/your-app.private-key.pem)"
```

Add `ANTHROPIC_API_KEY=…` for intent cards, or a [provider registry](../model-providers.md#deploying-with-a-registry) (`GRAFT_LLM_PROVIDERS="$(cat providers.yaml)"`) and the key variables it names. `--stage` stores the secrets without restarting anything, and the first deploy picks them up. Write down the webhook secret you generated (`fly secrets list` does not show values), because the App's settings need the same value.

## 4. Deploy

```sh
fly deploy
```

Fly builds the `Dockerfile`, runs `node dist/bin/migrate.js up` on a temporary machine (the deploy stops there if it fails), then starts one `app` machine and one `worker` machine. Check:

```sh
fly status
curl https://<app-name>.fly.dev/readyz
fly logs --app <app-name>
```

The worker logs `worker started` and `mode ceiling` = `report`.

## 5. Point the App at Fly

Follow [Pointing the App at the deployment](README.md#pointing-the-app-at-the-deployment), with the webhook URL `https://<app-name>.fly.dev/webhooks/github` (or your custom domain, `fly certs add <domain>`).

## Operating

- **Operator CLI:** `fly ssh console --app <app-name> -C "node dist/bin/graft.js mode show --installation <id>"`. It runs on one of the app's machines, with its secrets.
- **Scaling:** `fly scale count worker=2` is safe (pg-boss shares the work). The default `shared-cpu-1x` with 512 MB is plenty for a pilot.
- **Rollback of the code:** `fly releases` and `fly deploy --image <previous image>`. Migrations are not rolled back automatically. `node dist/bin/migrate.js down` rolls back one, and only when that migration's notes say it is safe.
- **Rollback of enforcement** is a mode change, not a deploy. See [Modes](../features/modes.md).
