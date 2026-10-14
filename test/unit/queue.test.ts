import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { silentLog } from "../helpers/stubs.js";

describe("queue", () => {
  it("U-Q-1 send with data failing the schema throws ZodError and does not call pg-boss", async () => {
    const boss = { on: vi.fn(), send: vi.fn(), createQueue: vi.fn(), start: vi.fn() };
    const registry = createRegistry({ webhookHandlers: [], jobs: [] });
    const queue = createPgBossQueue({
      connectionString: "postgres://x/y",
      schema: "pgboss",
      registry,
      log: silentLog,
      supervise: false,
      boss: boss as unknown as PgBoss,
    });
    await expect(
      queue.send(registry.webhookJob, { deliveryId: "", event: 1 } as never),
    ).rejects.toBeInstanceOf(ZodError);
    expect(boss.send).not.toHaveBeenCalled();
  });
});
