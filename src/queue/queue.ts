import { createHash } from "node:crypto";
import { CompiledQuery, type Transaction } from "kysely";
import type { Db as PgBossDb, Queue as PgBossQueue, SendOptions } from "pg-boss";
import { PgBoss } from "pg-boss";
import type { Logger } from "../core/logger.js";
import type { Database } from "../db/schema.js";
import type { Registry } from "../webhooks/registry.js";
import { sanitizeError } from "./errors.js";
import type { JobDefinition } from "./job.js";

/**
 * Deterministic job id (UUIDv5-style, SHA-1 over a fixed namespace) for a (job name, key) pair.
 *
 * pg-boss v12 only enforces `singletonKey` uniqueness on queues with a `short`, `singleton`,
 * `stately`, `exclusive` or `key_strict_fifo` policy (or together with `singletonSeconds`); on
 * the `standard` queues used here the key is stored but never deduplicates. The insert is
 * `INSERT ... ON CONFLICT DO NOTHING` on the job primary key, so a deterministic id gives real
 * deduplication: a second `send` with the same key returns `null`. The window lasts as long as
 * the job row exists (`deleteAfterSeconds`: 7 days after completion or failure, except for queues
 * that set a shorter value, such as `github.webhook` with 1 hour; its delivery dedup relies on the
 * `webhook_deliveries` primary key, not on the job row).
 */
export function singletonJobId(jobName: string, key: string): string {
  const ns = Buffer.from("9f1c3a52b6d84e0f8a7d2c4b1e5f6a30", "hex");
  const h = createHash("sha1").update(ns).update(`${jobName}\u0000${key}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface JobQueue {
  /** boss.start() + createQueue for every registered job. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Returns the job id, or `null` when `singletonKey` was given and a job with the same
   * (job name, key) already exists (deduplicated; nothing was enqueued).
   */
  send<T>(
    job: JobDefinition<T>,
    data: T,
    opts?: { tx?: Transaction<Database>; singletonKey?: string; startAfterSeconds?: number },
  ): Promise<string | null>;
  /** Recurring job (cron, UTC). Validates `data` with the job schema. Idempotent per job name. */
  schedule<T>(job: JobDefinition<T>, cron: string, data: T): Promise<void>;
  unschedule<T>(job: JobDefinition<T>): Promise<void>;
  ping(): Promise<boolean>;
}

/** The pg-boss-backed queue; the worker needs the instance to register handlers. */
export interface PgBossJobQueue extends JobQueue {
  readonly boss: PgBoss;
}

export const JOB_DEFAULTS = {
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  expireInSeconds: 300,
  /** Completed and failed jobs are deleted after 7 days. */
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const;

export function resolveJobOptions(job: JobDefinition<unknown>) {
  return {
    retryLimit: job.options?.retryLimit ?? JOB_DEFAULTS.retryLimit,
    retryDelaySeconds: job.options?.retryDelaySeconds ?? JOB_DEFAULTS.retryDelaySeconds,
    retryBackoff: job.options?.retryBackoff ?? JOB_DEFAULTS.retryBackoff,
    expireInSeconds: job.options?.expireInSeconds ?? JOB_DEFAULTS.expireInSeconds,
    deleteAfterSeconds: job.options?.deleteAfterSeconds ?? JOB_DEFAULTS.deleteAfterSeconds,
  };
}

export interface PgBossQueueOptions {
  connectionString: string;
  schema: string;
  registry: Pick<Registry, "jobs">;
  log: Logger;
  /**
   * true for the worker process (supervision: expiry, retries, maintenance).
   * false for the server process, which only sends.
   */
  supervise: boolean;
  /** Test seam: supply a pre-built (stubbed) pg-boss. */
  boss?: PgBoss;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function txAdapter(tx: Transaction<Database>): PgBossDb {
  return {
    executeSql: async (text, values) => {
      const res = await tx.executeQuery(CompiledQuery.raw(text, values as unknown[] | undefined));
      return { rows: res.rows as unknown[] };
    },
  };
}

export function createPgBossQueue(o: PgBossQueueOptions): PgBossJobQueue {
  const boss =
    o.boss ??
    new PgBoss({
      connectionString: o.connectionString,
      schema: o.schema,
      supervise: o.supervise,
      // Only the worker runs the cron scheduler (D23).
      schedule: o.supervise,
      application_name: o.supervise ? "graft-worker" : "graft-server",
    });
  boss.on("error", (err) => o.log.error({ err: sanitizeError(err) }, "pg-boss error"));

  const byName = new Map(o.registry.jobs.map((j) => [j.name, j] as const));
  let started = false;

  return {
    boss,
    async start() {
      await boss.start();
      for (const job of o.registry.jobs) {
        const opts = resolveJobOptions(job);
        const queue: Omit<PgBossQueue, "name"> = {
          retryLimit: opts.retryLimit,
          retryDelay: opts.retryDelaySeconds,
          retryBackoff: opts.retryBackoff,
          expireInSeconds: opts.expireInSeconds,
          deleteAfterSeconds: opts.deleteAfterSeconds,
        };
        await boss.createQueue(job.name, queue);
        // createQueue is a no-op for an existing queue, so apply changed options explicitly.
        await boss.updateQueue(job.name, queue);
        // A job copies the queue's `deletion_seconds` when it is inserted, so jobs that already
        // exist keep their old value (7 days). Tighten those too for queues with a shorter
        // retention (their data holds PR text); retention then deletes them at the next sweep.
        if (opts.deleteAfterSeconds < JOB_DEFAULTS.deleteAfterSeconds) {
          await boss
            .getDb()
            .executeSql(
              `update ${quoteIdent(o.schema)}.job set deletion_seconds = $1 where name = $2 and deletion_seconds > $1`,
              [opts.deleteAfterSeconds, job.name],
            );
        }
      }
      started = true;
    },
    async stop() {
      started = false;
      await boss.stop({ graceful: true, timeout: 10000 });
    },
    async send(job, data, opts) {
      // Validate BEFORE touching pg-boss: invalid data throws ZodError, nothing is enqueued.
      const parsed = job.schema.parse(data);
      if (!byName.has(job.name)) {
        throw new Error(`job "${job.name}" is not registered`);
      }
      const sendOpts: SendOptions = {};
      if (opts?.tx) sendOpts.db = txAdapter(opts.tx);
      if (opts?.singletonKey !== undefined) {
        sendOpts.singletonKey = opts.singletonKey;
        sendOpts.id = singletonJobId(job.name, opts.singletonKey);
      }
      if (opts?.startAfterSeconds !== undefined) sendOpts.startAfter = opts.startAfterSeconds;
      return boss.send(job.name, parsed as object, sendOpts);
    },
    async schedule(job, cron, data) {
      const parsed = job.schema.parse(data);
      if (!byName.has(job.name)) {
        throw new Error(`job "${job.name}" is not registered`);
      }
      await boss.schedule(job.name, cron, parsed as object);
    },
    async unschedule(job) {
      await boss.unschedule(job.name);
    },
    async ping() {
      if (!started) return false;
      try {
        await boss.getDb().executeSql("select 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
