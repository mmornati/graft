import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withChangeLock } from "../../src/db/locks.js";
import { feedbackSweepJob } from "../../src/modules/intent/index.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { defineJob } from "../../src/queue/job.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { startWorker } from "../../src/queue/worker.js";
import { createTestApp, jobContext, type TestApp } from "../helpers/app.js";
import { sleep, waitFor } from "../helpers/wait.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe("change lock", () => {
  it("I-LOCK-1 same change runs strictly one after the other; different changes overlap", async () => {
    const span = async (id: string) => {
      let start = 0;
      let end = 0;
      await withChangeLock(t.db, id, async () => {
        start = Date.now();
        await sleep(250);
        end = Date.now();
      });
      return { start, end };
    };
    const a = "00000000-0000-0000-0000-00000000aaaa";
    const b = "00000000-0000-0000-0000-00000000bbbb";

    const [first, second] = await Promise.all([span(a), span(a)]);
    const [early, late] = first.start <= second.start ? [first, second] : [second, first];
    expect(late.start).toBeGreaterThanOrEqual(early.end);

    const [x, y] = await Promise.all([span(a), span(b)]);
    expect(Math.max(x.start, y.start)).toBeLessThan(Math.min(x.end, y.end));
  });

  it("I-LOCK-1 the lock is released when the callback throws", async () => {
    const id = "00000000-0000-0000-0000-00000000cccc";
    await expect(
      withChangeLock(t.db, id, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withChangeLock(t.db, id, async () => "ok")).resolves.toBe("ok");
  });
});

describe("permanent job errors", () => {
  it("I-Q-4 PermanentJobError completes the job with no retry; a plain Error is retried; the handler sees its attempt", async () => {
    const attempts: unknown[] = [];
    const permanent = defineJob({
      name: "test.permanent",
      schema: z.object({}),
      options: { retryLimit: 3, retryDelaySeconds: 1 },
      handle: async () => {
        throw new PermanentJobError("nope", "not_found");
      },
    });
    const plain = defineJob({
      name: "test.plain",
      schema: z.object({}),
      options: { retryLimit: 3, retryDelaySeconds: 600 },
      handle: async (_data, ctx) => {
        // Step 3 review 1: a job can tell whether a retryable error will be retried.
        attempts.push(ctx.attempt);
        throw new Error("transient");
      },
    });
    const registry = { jobs: [permanent, plain] };
    const queue = createPgBossQueue({
      connectionString: t.deps.config.databaseUrl,
      schema: t.deps.config.pgbossSchema,
      registry,
      log: t.deps.log,
      supervise: true,
    });
    await queue.start();
    try {
      await startWorker(queue, registry, jobContext(t), { concurrency: 1 });
      const pid = await queue.send(permanent, {});
      const qid = await queue.send(plain, {});
      const state = async (id: string | null) =>
        (
          await sql<{ state: string; retry_count: number }>`
            select state, retry_count from pgboss.job where id = ${id}`.execute(t.db)
        ).rows[0];

      await waitFor(async () => (await state(pid))?.state === "completed");
      expect(await state(pid)).toEqual({ state: "completed", retry_count: 0 });
      await waitFor(async () => (await state(qid))?.state === "retry");
      expect((await state(qid))?.state).toBe("retry");
      expect(attempts).toEqual([{ retryCount: 0, retryLimit: 3 }]);
    } finally {
      await queue.stop();
      for (const name of ["test.permanent", "test.plain"]) {
        await sql`delete from pgboss.job where name = ${name}`.execute(t.db);
        await t.deps.queue.boss.deleteQueue(name);
      }
    }
  });
});

describe("scheduling", () => {
  it("I-Q-5 schedule and unschedule a cron job on a supervising queue; bad data throws before pg-boss", async () => {
    const registry = { jobs: [feedbackSweepJob] };
    const queue = createPgBossQueue({
      connectionString: t.deps.config.databaseUrl,
      schema: t.deps.config.pgbossSchema,
      registry,
      log: t.deps.log,
      supervise: true,
    });
    await queue.start();
    try {
      await queue.schedule(feedbackSweepJob, "*/15 * * * *", {});
      const listed = await queue.boss.getSchedules();
      const mine = listed.filter((s) => s.name === feedbackSweepJob.name);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.cron).toBe("*/15 * * * *");
      // Scheduling again is idempotent.
      await queue.schedule(feedbackSweepJob, "*/30 * * * *", {});
      expect((await queue.boss.getSchedules(feedbackSweepJob.name))[0]?.cron).toBe("*/30 * * * *");

      await expect(
        queue.schedule(feedbackSweepJob, "*/15 * * * *", { surprise: 1 } as never),
      ).rejects.toThrow();
      expect((await queue.boss.getSchedules(feedbackSweepJob.name))[0]?.cron).toBe("*/30 * * * *");

      await queue.unschedule(feedbackSweepJob);
      expect(await queue.boss.getSchedules(feedbackSweepJob.name)).toEqual([]);
    } finally {
      await queue.stop();
      await sql`delete from pgboss.job where name = ${feedbackSweepJob.name}`.execute(t.db);
    }
  });
});
