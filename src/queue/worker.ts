import type { JobContext } from "../core/context.js";
import type { Registry } from "../webhooks/registry.js";
import { PermanentJobError, sanitizeError } from "./errors.js";
import type { PgBossJobQueue } from "./queue.js";

export async function startWorker(
  queue: PgBossJobQueue,
  registry: Pick<Registry, "jobs">,
  ctx: JobContext,
  opts: { concurrency: number; pollingIntervalSeconds?: number },
): Promise<void> {
  for (const job of registry.jobs) {
    await queue.boss.work<object>(
      job.name,
      {
        localConcurrency: opts.concurrency,
        batchSize: 1,
        // Tests lower the idle poll (pg-boss minimum 0.5 s); production keeps the default.
        ...(opts.pollingIntervalSeconds
          ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
          : {}),
      },
      async (jobs) => {
        for (const j of jobs) {
          const log = ctx.log.child({ job: job.name, jobId: j.id });
          try {
            const data = job.schema.parse(j.data);
            await job.handle(data, { ...ctx, log });
          } catch (raw) {
            // Octokit/SDK errors carry request and response bodies (possibly model output), and
            // both pino and pg-boss serialize them: only the sanitized error leaves this block.
            const err = sanitizeError(raw);
            if (raw instanceof PermanentJobError) {
              // Retrying cannot help: log and return so pg-boss completes the job.
              log.error({ err, permanent: true, reason: raw.reason }, "job failed permanently");
              continue;
            }
            // Rethrow: pg-boss fails the job and retries per the queue's options.
            log.error({ err }, "job failed");
            throw err;
          }
        }
      },
    );
  }
}
