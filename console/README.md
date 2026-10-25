# Graft console

An optional, read-only operator console for Graft: a Fastify backend-for-frontend over Graft's Postgres and a small Preact web app. It runs in its own container with a SELECT-only database role and is never needed by Graft itself.

Read [docs/console.md](../docs/console.md) for what it shows, its security model, configuration and deployment.

```text
console/
  server/src/     the BFF: config, read-only database, GitHub sign-in, JSON routes, static files
  web/src/        the web app (Preact), built into dist/web
  shared/api.ts   the JSON contract both sides use
  sql/            readonly-role.sql, the SELECT-only role
  test/           unit tests, and integration tests against a database migrated by Graft's migrations
```

| Command | Does |
| --- | --- |
| `pnpm install` | Installs this project only (its own lockfile). |
| `pnpm dev` | Builds and watches the BFF and the web app, restarting the server on change. |
| `pnpm build` | `dist/server.js` and `dist/web/`. |
| `pnpm typecheck` | Server and web. Needs Graft's dependencies installed at the repository root (for `src/db/schema.ts`). |
| `pnpm test` | Unit and integration tests. Integration needs `pnpm db:up` at the root. |
| `docker build -t graft-console .` | The image. |
