import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppRegistry } from "../../src/app/registry.js";
import { bootstrap } from "../../src/bin/bootstrap.js";
import * as config from "../../src/config/index.js";
import { createDb } from "../../src/db/client.js";
import { migrateToLatest, pendingMigrations } from "../../src/db/migrator.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { testConfig } from "../helpers/config.js";
import { silentLog } from "../helpers/stubs.js";

vi.mock("../../src/bin/env.js", () => ({ loadDotEnv: vi.fn() }));
vi.mock("../../src/db/client.js", () => ({ createDb: vi.fn() }));
vi.mock("../../src/db/migrator.js", () => ({
  migrateToLatest: vi.fn(),
  pendingMigrations: vi.fn(),
}));
vi.mock("../../src/queue/queue.js", () => ({ createPgBossQueue: vi.fn() }));
vi.mock("../../src/github/client-factory.js", () => ({
  createGitHubClientFactory: vi.fn(() => ({})),
}));
vi.mock("../../src/llm/index.js", () => ({ createLlmClient: vi.fn(() => ({})) }));

const destroy = vi.fn(async () => {});
const start = vi.fn(async () => {});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const settings = testConfig();
  vi.spyOn(config, "loadConfig").mockReturnValue(settings);
  const dbModule =
    await vi.importActual<typeof import("../../src/db/client.js")>("../../src/db/client.js");
  const queueModule = await vi.importActual<typeof import("../../src/queue/queue.js")>(
    "../../src/queue/queue.js",
  );
  const db = dbModule.createDb(settings.databaseUrl);
  const queue = queueModule.createPgBossQueue({
    connectionString: settings.databaseUrl,
    schema: settings.pgbossSchema,
    registry: buildAppRegistry(),
    log: silentLog,
    supervise: false,
  });
  vi.spyOn(db, "destroy").mockImplementation(destroy);
  vi.spyOn(queue, "start").mockImplementation(start);
  vi.mocked(createDb).mockReturnValue(db);
  vi.mocked(createPgBossQueue).mockReturnValue(queue);
  vi.mocked(migrateToLatest).mockResolvedValue([]);
  vi.mocked(pendingMigrations).mockResolvedValue([]);
});

describe("startup migrations", () => {
  it("applies migrations before checking the schema and starting the queue", async () => {
    vi.mocked(migrateToLatest).mockResolvedValue(["0020_billing_auditability"]);
    await bootstrap({ supervise: false, migrate: true });
    expect(migrateToLatest).toHaveBeenCalledWith(vi.mocked(createDb).mock.results[0]?.value);
    expect(migrateToLatest).toHaveBeenCalledBefore(vi.mocked(pendingMigrations));
    expect(pendingMigrations).toHaveBeenCalledBefore(start);
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts normally when no migrations are pending", async () => {
    await bootstrap({ supervise: false, migrate: true });
    expect(migrateToLatest).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("closes the database and refuses to start the queue if migration fails", async () => {
    const error = new Error("migration failed");
    vi.mocked(migrateToLatest).mockRejectedValue(error);
    await expect(bootstrap({ supervise: false, migrate: true })).rejects.toThrow(error);
    expect(destroy).toHaveBeenCalledOnce();
    expect(pendingMigrations).not.toHaveBeenCalled();
    expect(createPgBossQueue).not.toHaveBeenCalled();
  });

  it("does not migrate when startup only requests a schema check", async () => {
    await bootstrap({ supervise: false });
    expect(migrateToLatest).not.toHaveBeenCalled();
    expect(pendingMigrations).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});
