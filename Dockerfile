# syntax=docker/dockerfile:1
#
# One image for both Graft processes. The default command runs the webhook server; run the worker
# with `node dist/bin/worker.js`, migrations with `node dist/bin/migrate.js up` and the operator
# CLI with `node dist/bin/graft.js <command>`. See docs/deploy/README.md.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm comes from the `packageManager` field of package.json.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Read at runtime: the version (health route) and the graft.yaml JSON schema (CLI).
COPY package.json ./
COPY schema ./schema
USER node
EXPOSE 3000
# No curl in the slim image: Node's fetch checks liveness. /readyz also checks Postgres and the queue.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/bin/server.js"]
