import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { startWorker } from "../../src/queue/worker.js";
import { createTestApp, jobContext, postFixture, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let t: TestApp;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  t = await createTestApp({ supervise: true });
  server = await buildServer(t.deps);
  await startWorker(t.deps.queue, t.deps.registry, jobContext(t), { concurrency: 2 });
});
afterAll(async () => {
  await server.close();
  await t.close();
});
beforeEach(() => truncateAll(t.db));

async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("end to end", () => {
  it("I-E2E-1 server + worker: a signed installation.created leads to repository rows within 10 s", async () => {
    const res = await postFixture(server, "installation.created", "e2e-1");
    expect(res.statusCode).toBe(202);

    const rows = await waitFor(async () => {
      const r = await t.db.selectFrom("repositories").selectAll().execute();
      return r.length === 2 ? r : false;
    });
    expect(rows.map((r) => r.full_name).sort()).toEqual([
      "graft-sandbox/sample-py",
      "graft-sandbox/sample-ts",
    ]);
    expect(t.deps.github).toMatchObject({ calls: 0 });
  });

  it("I-HEALTH-1 /readyz -> 200 against the real DB and started queue", async () => {
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", db: "ok", queue: "ok" });
  });
});
