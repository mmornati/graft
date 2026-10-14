import type { JobDefinition } from "../../src/queue/job.js";
import type { JobQueue } from "../../src/queue/queue.js";

export interface SentJob {
  name: string;
  data: unknown;
  opts: Parameters<JobQueue["send"]>[2];
}

export class FakeJobQueue implements JobQueue {
  sent: SentJob[] = [];
  scheduled: { name: string; cron: string; data: unknown }[] = [];
  unscheduled: string[] = [];
  pingResult = true;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send<T>(job: JobDefinition<T>, data: T, opts?: Parameters<JobQueue["send"]>[2]) {
    const parsed = job.schema.parse(data);
    this.sent.push({ name: job.name, data: parsed, opts });
    return `fake-job-${this.sent.length}`;
  }
  async schedule<T>(job: JobDefinition<T>, cron: string, data: T): Promise<void> {
    this.scheduled.push({ name: job.name, cron, data: job.schema.parse(data) });
  }
  async unschedule<T>(job: JobDefinition<T>): Promise<void> {
    this.unscheduled.push(job.name);
  }
  async ping(): Promise<boolean> {
    return this.pingResult;
  }
}
