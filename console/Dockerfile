# syntax=docker/dockerfile:1
#
# The Graft console: an optional, read-only operator UI. Build it from the console/ directory:
#   docker build -t graft-console console/
# It needs only CONSOLE_* variables and a SELECT-only database role (sql/readonly-role.sql); none of
# Graft's secrets (GitHub App key, webhook secret, Anthropic key). See docs/console.md.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm-console,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN pnpm build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-console,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
