import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("pilot_purges")
    .addColumn("rows_preserved", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
  await db.schema
    .createTable("billing_teams")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("archived_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("billing_teams_name_idx")
    .on("billing_teams")
    .expression(sql`lower(name)`)
    .unique()
    .execute();

  await db.schema
    .createTable("billing_team_repositories")
    .addColumn("team_id", "uuid", (c) =>
      c.notNull().references("billing_teams.id").onDelete("restrict"),
    )
    .addColumn("repository_id", "bigint", (c) =>
      c.notNull().references("repositories.id").onDelete("cascade"),
    )
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("billing_team_repositories_pk", ["team_id", "repository_id"])
    .execute();
  await db.schema
    .createIndex("billing_team_repositories_repository_idx")
    .on("billing_team_repositories")
    .column("repository_id")
    .execute();

  await db.schema
    .createTable("billing_spend_calls")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Deliberately no repository/change FK: this immutable ledger outlives repository purges.
    .addColumn("repository_id", "bigint", (c) => c.notNull())
    .addColumn("repository_name", "text", (c) => c.notNull())
    .addColumn("change_id", "uuid")
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("input_tokens", "bigint", (c) => c.notNull())
    .addColumn("output_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_read_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_write_tokens", "bigint", (c) => c.notNull())
    .addColumn("cost_usd", sql`numeric(14,8)`)
    .addColumn("price_version", "text")
    .addColumn("spent_at", "timestamptz", (c) => c.notNull())
    .addCheckConstraint(
      "billing_spend_calls_tokens_nonnegative",
      sql`input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0 and cache_write_tokens >= 0`,
    )
    .execute();
  await db.schema
    .createIndex("billing_spend_calls_spent_idx")
    .on("billing_spend_calls")
    .columns(["spent_at", "repository_id"])
    .execute();

  await db.schema
    .createTable("billing_spend_allocations")
    .addColumn("spend_call_id", "uuid", (c) =>
      c.notNull().references("billing_spend_calls.id").onDelete("cascade"),
    )
    // Team ids and names are snapshots; historical allocations survive team archive/purge.
    .addColumn("team_id", "uuid")
    .addColumn("team_name", "text", (c) => c.notNull())
    .addColumn("input_tokens", "bigint", (c) => c.notNull())
    .addColumn("output_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_read_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_write_tokens", "bigint", (c) => c.notNull())
    .addColumn("cost_usd", sql`numeric(14,2)`)
    .addCheckConstraint(
      "billing_spend_allocations_tokens_nonnegative",
      sql`input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0 and cache_write_tokens >= 0`,
    )
    .addPrimaryKeyConstraint("billing_spend_allocations_pk", ["spend_call_id", "team_name"])
    .execute();
  await db.schema
    .createIndex("billing_spend_allocations_team_idx")
    .on("billing_spend_allocations")
    .columns(["team_id", "spend_call_id"])
    .execute();

  await db.schema
    .createTable("billing_periods")
    .addColumn("period_start", "date", (c) => c.primaryKey())
    .addColumn("closed_at", "timestamptz", (c) => c.notNull())
    .addColumn("closed_by", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("billing_adjustments")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("period_start", "date", (c) => c.notNull())
    .addColumn("team_id", "uuid")
    .addColumn("team_name", "text", (c) => c.notNull())
    .addColumn("repository_id", "bigint", (c) => c.notNull())
    .addColumn("repository_name", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("input_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_read_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_write_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cost_usd", sql`numeric(14,2)`)
    .addColumn("source_call_id", "uuid")
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("billing_adjustments_period_idx")
    .on("billing_adjustments")
    .columns(["period_start", "team_name", "repository_name"])
    .execute();
  await db.schema
    .createIndex("billing_adjustments_source_idx")
    .on("billing_adjustments")
    .columns(["period_start", "source_call_id", "team_name"])
    .unique()
    .where("source_call_id", "is not", null)
    .execute();

  await db.schema
    .createTable("billing_statement_lines")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("period_start", "date", (c) =>
      c.notNull().references("billing_periods.period_start").onDelete("restrict"),
    )
    .addColumn("team_id", "uuid")
    .addColumn("team_name", "text", (c) => c.notNull())
    .addColumn("repository_id", "bigint", (c) => c.notNull())
    .addColumn("repository_name", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("line_type", "text", (c) => c.notNull().defaultTo("usage"))
    .addColumn("description", "text")
    .addColumn("adjustment_id", "uuid")
    .addColumn("calls", "bigint", (c) => c.notNull())
    .addColumn("unpriced_calls", "bigint", (c) => c.notNull())
    .addColumn("input_tokens", "bigint", (c) => c.notNull())
    .addColumn("output_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_read_tokens", "bigint", (c) => c.notNull())
    .addColumn("cache_write_tokens", "bigint", (c) => c.notNull())
    .addColumn("cost_usd", sql`numeric(14,2)`)
    .addCheckConstraint("billing_statement_line_type", sql`line_type in ('usage', 'adjustment')`)
    .execute();
  await db.schema
    .createIndex("billing_statement_lines_period_idx")
    .on("billing_statement_lines")
    .columns(["period_start", "team_name", "repository_name", "model"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("billing_statement_lines").execute();
  await db.schema.dropIndex("billing_adjustments_source_idx").execute();
  await db.schema.dropTable("billing_adjustments").execute();
  await db.schema.dropTable("billing_periods").execute();
  await db.schema.dropTable("billing_spend_allocations").execute();
  await db.schema.dropTable("billing_spend_calls").execute();
  await db.schema.dropTable("billing_team_repositories").execute();
  await db.schema.dropTable("billing_teams").execute();
  await db.schema.alterTable("pilot_purges").dropColumn("rows_preserved").execute();
}
