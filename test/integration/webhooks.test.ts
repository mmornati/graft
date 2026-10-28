import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildServer } from "../../src/http/server.js";
import { defineJob } from "../../src/queue/job.js";
import type { JobQueue } from "../../src/queue/queue.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { createTestApp, postFixture, postRaw, type TestApp } from "../helpers/app.js";
import { countJobs, truncateAll } from "../helpers/db.js";
import { loadFixture } from "../helpers/fixtures.js";

let t: TestApp;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  t = await createTestApp();
  server = await buildServer(t.deps);
});
afterAll(async () => {
  await server.close();
  await t.close();
});
beforeEach(() => truncateAll(t.db));

const deliveries = () => t.db.selectFrom("webhook_deliveries").selectAll().execute();

describe("webhook receiver (real Postgres + pg-boss)", () => {
  it("I-WH-1 a signed installation.created -> 202 enqueued; one delivery row with job_id; one github.webhook job", async () => {
    const res = await postFixture(server, "installation.created", "wh-1");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "enqueued" });

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delivery_id: "wh-1",
      event: "installation",
      action: "created",
      installation_id: 1000001,
      status: "enqueued",
    });
    expect(rows[0]?.job_id).toBeTruthy();

    const jobs = await sql<{ id: string; data: { deliveryId: string } }>`
      select id, data from pgboss.job where name = 'github.webhook'`.execute(t.db);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.data.deliveryId).toBe("wh-1");
    expect(jobs.rows[0]?.id).toBe(rows[0]?.job_id);
  });

  it("I-WH-2 the same delivery ID twice -> second is 200 duplicate; still one row and one job", async () => {
    expect((await postFixture(server, "installation.created", "wh-2")).statusCode).toBe(202);
    const second = await postFixture(server, "installation.created", "wh-2");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "duplicate" });
    expect(await deliveries()).toHaveLength(1);
    expect(await countJobs(t.db)).toBe(1);
  });

  it("I-WH-3 five concurrent injects with one delivery ID -> exactly one row and one job", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postFixture(server, "installation.created", "wh-3")),
    );
    const bodies = results.map((r) => r.json().status as string).sort();
    expect(bodies).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "enqueued"]);
    expect(await deliveries()).toHaveLength(1);
    expect(await countJobs(t.db)).toBe(1);
  });

  it("I-WH-4 ping and a pull_request.assigned are ignored; pull_request.opened is enqueued", async () => {
    const ping = await postFixture(server, "ping", "wh-4a");
    expect(ping.statusCode).toBe(202);
    expect(ping.json()).toEqual({ status: "ignored" });

    const opened = loadFixture("pull_request.opened");
    // `labeled` became a handled action in step 5 (graft/policy); `assigned` is still ignored.
    const assigned = JSON.stringify({ ...opened.payload, action: "assigned" });
    const lab = await postRaw(server, "pull_request", assigned, "wh-4b");
    expect(lab.statusCode).toBe(202);
    expect(lab.json()).toEqual({ status: "ignored" });

    const pr = await postFixture(server, "pull_request.opened", "wh-4c");
    expect(pr.statusCode).toBe(202);
    expect(pr.json()).toEqual({ status: "enqueued" });

    const rows = await deliveries();
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.delivery_id, r]));
    for (const id of ["wh-4a", "wh-4b"]) {
      expect(byId.get(id)?.status).toBe("ignored");
      expect(byId.get(id)?.job_id).toBeNull();
    }
    expect(byId.get("wh-4c")?.status).toBe("enqueued");
    expect(await countJobs(t.db)).toBe(1);
  });

  it("I-WH-5 a queue whose send throws -> 500 and no delivery row; a retry with a working queue succeeds", async () => {
    const failing: JobQueue = {
      ...t.deps.queue,
      send: async () => {
        throw new Error("queue down");
      },
    };
    const brokenServer = await buildServer({ ...t.deps, queue: failing });
    const res = await postFixture(brokenServer, "installation.created", "wh-5");
    expect(res.statusCode).toBe(500);
    expect(await deliveries()).toHaveLength(0);
    await brokenServer.close();

    const retry = await postFixture(server, "installation.created", "wh-5");
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ status: "enqueued" });
    expect(await deliveries()).toHaveLength(1);
  });

  it("I-Q-1 send inside a transaction that is rolled back leaves no job in pg-boss", async () => {
    const data = { deliveryId: "q-1", event: "installation", payload: {} };
    await expect(
      t.db.transaction().execute(async (tx) => {
        const id = await t.deps.queue.send(t.deps.registry.webhookJob, data, { tx });
        expect(id).toBeTruthy();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await countJobs(t.db)).toBe(0);

    await t.db.transaction().execute(async (tx) => {
      await t.deps.queue.send(t.deps.registry.webhookJob, data, { tx });
    });
    expect(await countJobs(t.db)).toBe(1);
  });
  it("I-Q-2 two sends with the same singletonKey create one job; the second returns null", async () => {
    const data = { deliveryId: "q-2", event: "installation", payload: {} };
    const first = await t.deps.queue.send(t.deps.registry.webhookJob, data, {
      singletonKey: "same-key",
    });
    const second = await t.deps.queue.send(t.deps.registry.webhookJob, data, {
      singletonKey: "same-key",
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await countJobs(t.db)).toBe(1);

    const other = await t.deps.queue.send(t.deps.registry.webhookJob, data, {
      singletonKey: "other-key",
    });
    expect(other).toBeTruthy();
    expect(other).not.toBe(first);
    expect(await countJobs(t.db)).toBe(2);

    // Same key inside a transaction that sees the committed job: also deduplicated.
    const inTx = await t.db
      .transaction()
      .execute((tx) =>
        t.deps.queue.send(t.deps.registry.webhookJob, data, { tx, singletonKey: "same-key" }),
      );
    expect(inTx).toBeNull();
    expect(await countJobs(t.db)).toBe(2);
  });

  it("I-Q-6 github.webhook jobs are deleted 1 hour after they finish, other queues keep 7 days, and dedup does not need the old job", async () => {
    const retention = async () =>
      Object.fromEntries(
        (
          await sql<{ name: string; deletion_seconds: number }>`
            select name, deletion_seconds from pgboss.queue
            where name in ('github.webhook', 'intent.generate', 'pilot.reviewers.sync')`.execute(
            t.db,
          )
        ).rows.map((r) => [r.name, r.deletion_seconds]),
      );
    expect(await retention()).toEqual({
      "github.webhook": 3600,
      "intent.generate": 604800,
      "pilot.reviewers.sync": 604800,
    });

    // A job takes its queue's retention when it is inserted.
    expect((await postFixture(server, "installation.created", "wh-q6")).statusCode).toBe(202);
    const mine = await sql<{ id: string; deletion_seconds: number }>`
      select id, deletion_seconds from pgboss.job where name = 'github.webhook'`.execute(t.db);
    expect(mine.rows.map((r) => r.deletion_seconds)).toEqual([3600]);

    // Jobs created before the change carry the old 7 days; the next start tightens them.
    const legacy = (name: string, state: string, minutesAgo: number) =>
      sql`insert into pgboss.job (name, data, state, deletion_seconds, completed_on)
        values (${name}, '{"payload":{"pull_request":{"title":"legacy"}}}'::jsonb, ${state}::pgboss.job_state, 604800,
          now() - ${minutesAgo} * interval '1 minute')`.execute(t.db);
    await legacy("github.webhook", "completed", 120);
    await legacy("github.webhook", "failed", 120);
    await legacy("github.webhook", "completed", 30);
    await legacy("intent.generate", "completed", 120);
    // Our own job finished two hours ago.
    await sql`update pgboss.job set state = 'completed', completed_on = now() - interval '2 hours'
      where id = ${mine.rows[0]?.id as string}`.execute(t.db);

    const q = createPgBossQueue({
      connectionString: t.deps.config.databaseUrl,
      schema: t.deps.config.pgbossSchema,
      registry: t.deps.registry,
      log: t.deps.log,
      supervise: true,
    });
    await q.start();
    try {
      const webhookRetention = await sql<{ n: string }>`
        select count(*)::text as n from pgboss.job where name = 'github.webhook' and deletion_seconds <> 3600`.execute(
        t.db,
      );
      expect(webhookRetention.rows[0]?.n).toBe("0");
      const other = await sql<{ deletion_seconds: number }>`
        select deletion_seconds from pgboss.job where name = 'intent.generate'`.execute(t.db);
      expect(other.rows.map((r) => r.deletion_seconds)).toEqual([604800]);

      await q.boss.supervise("github.webhook");
      await q.boss.supervise("intent.generate");
      const left = await sql<{ name: string; state: string }>`
        select name, state::text from pgboss.job order by name, completed_on`.execute(t.db);
      // Only the webhook job that finished 30 minutes ago and the intent job (7 days) are left.
      expect(left.rows).toEqual([
        { name: "github.webhook", state: "completed" },
        { name: "intent.generate", state: "completed" },
      ]);
    } finally {
      await q.stop();
    }

    // The job of delivery wh-q6 is gone, but the delivery row is not: a redelivery is a duplicate.
    expect(await deliveries()).toHaveLength(1);
    const again = await postFixture(server, "installation.created", "wh-q6");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: "duplicate" });
    const jobs = await sql<{ data: { deliveryId?: string } }>`
      select data from pgboss.job where name = 'github.webhook'`.execute(t.db);
    expect(jobs.rows.some((r) => r.data.deliveryId === "wh-q6")).toBe(false);
    expect(await deliveries()).toHaveLength(1);
  });

  it("I-Q-3 a changed job option is applied to an existing queue on the next start", async () => {
    const mk = (retryLimit: number) =>
      defineJob({
        name: "test.options",
        schema: z.object({}),
        options: { retryLimit },
        handle: async () => {},
      });
    const build = (retryLimit: number) =>
      createPgBossQueue({
        connectionString: t.deps.config.databaseUrl,
        schema: t.deps.config.pgbossSchema,
        registry: { jobs: [mk(retryLimit)] },
        log: t.deps.log,
        supervise: false,
      });
    const retryLimitOf = async () =>
      (
        await sql<{ retry_limit: number }>`
          select retry_limit from pgboss.queue where name = 'test.options'`.execute(t.db)
      ).rows[0]?.retry_limit;
    try {
      const a = build(2);
      await a.start();
      await a.stop();
      expect(await retryLimitOf()).toBe(2);
      const b = build(7);
      await b.start();
      await b.stop();
      expect(await retryLimitOf()).toBe(7);
    } finally {
      await sql`delete from pgboss.job where name = 'test.options'`.execute(t.db);
      await t.deps.queue.boss.deleteQueue("test.options");
    }
  });
  it("I-WH-6 delivery row gone but job exists -> 200 duplicate; the new row records the existing job id", async () => {
    expect((await postFixture(server, "installation.created", "wh-6")).statusCode).toBe(202);
    const before = (await deliveries())[0]?.job_id;
    expect(before).toBeTruthy();
    await t.db.deleteFrom("webhook_deliveries").execute();
    const again = await postFixture(server, "installation.created", "wh-6");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: "duplicate" });
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe(before);
    expect(await countJobs(t.db)).toBe(1);
  });
});

describe("webhook receiver: GRAFT_ALLOWED_ACCOUNTS (real Postgres)", () => {
  let a: TestApp;
  let srv: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    a = await createTestApp({ config: { GRAFT_ALLOWED_ACCOUNTS: "graft-sandbox" } });
    srv = await buildServer(a.deps);
  });
  afterAll(async () => {
    await srv.close();
    await a.close();
  });
  beforeEach(() => truncateAll(a.db));
  const rows = () => a.db.selectFrom("webhook_deliveries").selectAll().execute();

  it("I-WH-7 a listed account is enqueued; ping (no installation) still reaches the store", async () => {
    expect((await postFixture(srv, "installation.created", "acc-1")).json()).toEqual({
      status: "enqueued",
    });
    expect((await postFixture(srv, "ping", "acc-2")).json()).toEqual({ status: "ignored" });
    expect((await rows()).map((r) => r.delivery_id).sort()).toEqual(["acc-1", "acc-2"]);
  });

  it("I-WH-8 an unlisted account leaves no delivery row and no job", async () => {
    const f = loadFixture("installation.created");
    const p = f.payload as { installation: { account: { login: string } } };
    p.installation.account.login = "stranger";
    const res = await postRaw(srv, "installation", JSON.stringify(p), "acc-3");
    expect(res.json()).toEqual({ status: "ignored" });
    expect(await rows()).toEqual([]);
    expect(await countJobs(a.db)).toBe(0);
  });

  it("I-WH-9 a payload naming no account is matched on the stored installation; unknown is refused", async () => {
    const bare = JSON.stringify({ action: "requested", installation: { id: 1000001 } });
    expect((await postRaw(srv, "check_suite", bare, "acc-4")).json()).toEqual({
      status: "ignored",
    });
    expect(await rows()).toEqual([]);
    await a.db
      .insertInto("installations")
      .values({
        id: 1000001,
        account_id: 9000001,
        account_login: "Graft-Sandbox",
        account_type: "User",
        repository_selection: "selected",
      })
      .execute();
    await postRaw(srv, "check_suite", bare, "acc-5");
    expect((await rows()).map((r) => r.delivery_id)).toEqual(["acc-5"]);
  });
});
