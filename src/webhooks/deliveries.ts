import type { Transaction } from "kysely";
import type { Clock } from "../core/clock.js";
import type { Db } from "../db/client.js";
import type { Database } from "../db/schema.js";
import { type JobQueue, singletonJobId } from "../queue/queue.js";
import type { Registry } from "./registry.js";

export interface IncomingDelivery {
  deliveryId: string;
  event: string;
  action: string | undefined;
  installationId: number | undefined;
  repositoryId: number | undefined;
  payload: Record<string, unknown>;
}

export type DeliveryOutcome = "duplicate" | "enqueued" | "ignored";

/**
 * Records a delivery and, when a handler exists, enqueues the `github.webhook` job in the SAME
 * transaction. Duplicate detection relies on the primary key (INSERT ... ON CONFLICT DO NOTHING),
 * never on read-then-write, so concurrent duplicates yield one row and one job. Any error rolls
 * the transaction back, so a redelivery from GitHub is processed again.
 */
export async function recordDelivery(
  deps: { db: Db; queue: JobQueue; registry: Registry; clock: Clock },
  d: IncomingDelivery,
): Promise<DeliveryOutcome> {
  const handled = deps.registry.isHandled(d.event, d.action);
  return deps.db.transaction().execute(async (tx: Transaction<Database>) => {
    const inserted = await tx
      .insertInto("webhook_deliveries")
      .values({
        delivery_id: d.deliveryId,
        event: d.event,
        action: d.action ?? null,
        installation_id: d.installationId ?? null,
        repository_id: d.repositoryId ?? null,
        status: handled ? "enqueued" : "ignored",
        received_at: deps.clock.now(),
      })
      .onConflict((oc) => oc.column("delivery_id").doNothing())
      .returning("delivery_id")
      .executeTakeFirst();

    if (!inserted) return "duplicate";
    if (!handled) return "ignored";

    const jobId = await deps.queue.send(
      deps.registry.webhookJob,
      {
        deliveryId: d.deliveryId,
        event: d.event,
        ...(d.action !== undefined ? { action: d.action } : {}),
        ...(d.installationId !== undefined ? { installationId: d.installationId } : {}),
        payload: d.payload,
      },
      { tx, singletonKey: d.deliveryId },
    );
    // null: a job for this delivery already exists (deterministic id from the singletonKey), e.g.
    // the delivery row was purged before the job. Record that job's id so the row stays truthful.
    const existing = jobId === null;
    const recordedId = jobId ?? singletonJobId(deps.registry.webhookJob.name, d.deliveryId);

    await tx
      .updateTable("webhook_deliveries")
      .set({ job_id: recordedId })
      .where("delivery_id", "=", d.deliveryId)
      .execute();
    return existing ? "duplicate" : "enqueued";
  });
}
