import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { startWorker } from "../../src/queue/worker.js";
import { createTestApp, jobContext, postFixture, type TestApp } from "../helpers/app.js";
import { countJobs, truncateAll } from "../helpers/db.js";

let t: TestApp;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  t = await createTestApp({ supervise: true });
  server = await buildServer(t.deps);
  // Empty the queue BEFORE the worker starts: a job another test file left due would otherwise be
  // fetched first and make an installation call that this file's assertions then see.
  await truncateAll(t.db);
  await startWorker(t.deps.queue, t.deps.registry, jobContext(t), { concurrency: 2 });
});
afterAll(async () => {
  await server.close();
  await t.close();
});
beforeEach(async () => {
  await truncateAll(t.db);
  // Counters start from this test, whatever ran before it.
  const github = t.deps.github as unknown as { calls: number; installationCalls: number };
  github.calls = 0;
  github.installationCalls = 0;
});

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
    // Since Phase 1 step 1 the event also queues `installations.refresh_permissions`, whose job
    // reads the permissions with the App JWT (asApp) whenever the worker gets to it: a race with
    // this assertion. The installation itself is handled without an installation token.
    expect(t.deps.github).toMatchObject({ installationCalls: 0 });
    expect(await countJobs(t.db, "installations.refresh_permissions")).toBe(1);
  });

  it("I-HEALTH-1 /readyz -> 200 against the real DB and started queue", async () => {
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", db: "ok", queue: "ok" });
  });
});
