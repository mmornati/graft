import type { JobContext } from "../core/context.js";
import type { Registry } from "../webhooks/registry.js";
import type { PgBossJobQueue } from "./queue.js";

export async function startWorker(
  queue: PgBossJobQueue,
  registry: Pick<Registry, "jobs">,
  ctx: JobContext,
  opts: { concurrency: number },
): Promise<void> {
  for (const job of registry.jobs) {
    await queue.boss.work<object>(
      job.name,
      { localConcurrency: opts.concurrency, batchSize: 1 },
      async (jobs) => {
        for (const j of jobs) {
          const log = ctx.log.child({ job: job.name, jobId: j.id });
          try {
            const data = job.schema.parse(j.data);
            await job.handle(data, { ...ctx, log });
          } catch (err) {
            // Rethrow: pg-boss fails the job and retries per the queue's options.
            log.error({ err }, "job failed");
            throw err;
          }
        }
      },
    );
  }
}
