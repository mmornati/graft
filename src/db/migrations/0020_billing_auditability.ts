import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("billing_spend_calls").addColumn("price_snapshot", "jsonb").execute();
  await db.schema
    .alterTable("billing_adjustments")
    .addColumn("source_period", "date")
    .addColumn("source_statement_line_id", "uuid")
    .addColumn("operation_id", "uuid")
    .execute();
  await db.schema
    .createIndex("billing_adjustments_operation_idx")
    .on("billing_adjustments")
    .column("operation_id")
    .unique()
    .execute();
  await db.schema.alterTable("intent_spend").addColumn("billing_spend_call_id", "uuid").execute();
  await db.schema
    .createIndex("intent_spend_billing_call_idx")
    .on("intent_spend")
    .column("billing_spend_call_id")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("intent_spend_billing_call_idx").execute();
  await db.schema.alterTable("intent_spend").dropColumn("billing_spend_call_id").execute();
  await db.schema.dropIndex("billing_adjustments_operation_idx").execute();
  await db.schema
    .alterTable("billing_adjustments")
    .dropColumn("operation_id")
    .dropColumn("source_statement_line_id")
    .dropColumn("source_period")
    .execute();
  await db.schema.alterTable("billing_spend_calls").dropColumn("price_snapshot").execute();
}
