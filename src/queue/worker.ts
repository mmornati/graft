import type { JobWithMetadata } from "pg-boss";
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
    await queue.boss.work(
      job.name,
      {
        localConcurrency: opts.concurrency,
        batchSize: 1,
        // The job's own `retryLimit`: pg-boss copies it onto the job when it is inserted, so a job
        // queued before a deploy that changed the definition keeps the old one (step 3 review 2,
        // nit 4).
        includeMetadata: true,
        // Tests lower the idle poll (pg-boss minimum 0.5 s); production keeps the default.
        ...(opts.pollingIntervalSeconds
          ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
          : {}),
      },
      async (jobs: JobWithMetadata<object>[]) => {
        for (const j of jobs) {
          const log = ctx.log.child({ job: job.name, jobId: j.id });
          try {
            const data = job.schema.parse(j.data);
            await job.handle(data, {
              ...ctx,
              log,
              attempt: { retryCount: j.retryCount, retryLimit: j.retryLimit },
            });
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
