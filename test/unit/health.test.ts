import {
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import type { AppDeps } from "../../src/core/context.js";
import type { Db } from "../../src/db/client.js";
import type { Database } from "../../src/db/schema.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { buildServer } from "../../src/http/server.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { fixedClock, testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { silentLog } from "../helpers/stubs.js";

// A real Kysely instance over a stub driver: queries succeed or fail on demand.
function stubDb(fail: boolean): Db {
  const connection: DatabaseConnection = {
    executeQuery: async () => {
      if (fail) throw new Error("db down");
      return { rows: [] };
    },
    // biome-ignore lint/correctness/useYield: streaming is never used
    async *streamQuery() {
      throw new Error("not supported");
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

async function server(opts: { dbFails?: boolean; queueOk?: boolean }) {
  const queue = new FakeJobQueue();
  queue.pingResult = opts.queueOk ?? true;
  const deps: AppDeps = {
    config: testConfig(),
    log: silentLog,
    db: stubDb(opts.dbFails ?? false),
    queue,
    registry: createRegistry({ webhookHandlers: [], jobs: [] }),
    clock: fixedClock,
    github: {} as GitHubClientFactory,
    llm: forbiddenLlm(),
  };
  return buildServer(deps);
}

describe("health", () => {
  it("U-HEALTH-1 /healthz -> 200 with version", async () => {
    const app = await server({});
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: pkg.version });
  });

  it("U-HEALTH-2 /readyz -> 503 when the DB throws, and when queue.ping returns false", async () => {
    const dbDown = await (await server({ dbFails: true })).inject({
      method: "GET",
      url: "/readyz",
    });
    expect(dbDown.statusCode).toBe(503);
    expect(dbDown.json()).toMatchObject({ db: "error", queue: "ok" });

    const queueDown = await (await server({ queueOk: false })).inject({
      method: "GET",
      url: "/readyz",
    });
    expect(queueDown.statusCode).toBe(503);
    expect(queueDown.json()).toMatchObject({ db: "ok", queue: "error" });

    const ok = await (await server({})).inject({ method: "GET", url: "/readyz" });
    expect(ok.statusCode).toBe(200);
  });
});
