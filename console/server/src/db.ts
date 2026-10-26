import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
// Type-only: the console reads Graft's tables with Graft's own column types, so a schema change in
// Graft breaks the console's typecheck instead of a query in production. Erased at build time.
import type { Database } from "../../../src/db/schema.js";

export type { Database };
export type Db = Kysely<Database>;

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
let parsersInstalled = false;

function installParsers(): void {
  if (parsersInstalled) return;
  // int8 → number (GitHub ids and counts fit in 2^53); numeric (cost_usd, sums) → number.
  pg.types.setTypeParser(INT8_OID, (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n))
      throw new RangeError("bigint value exceeds Number.MAX_SAFE_INTEGER");
    return n;
  });
  pg.types.setTypeParser(NUMERIC_OID, (v: string) => Number(v));
  pg.types.setTypeParser(DATE_OID, (v: string) => v);
  parsersInstalled = true;
}

/**
 * A pool whose every transaction is read-only. This is the second line of defence: the first is a
 * database role with SELECT only (sql/readonly-role.sql), which `verifyReadOnly` checks at start.
 */
export function createReadOnlyDb(
  url: string,
  opts: { statementTimeoutMs: number; max?: number },
): Db {
  installParsers();
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        max: opts.max ?? 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        options: [
          "-c default_transaction_read_only=on",
          `-c statement_timeout=${opts.statementTimeoutMs}`,
          "-c application_name=graft-console",
        ].join(" "),
      }),
    }),
  });
}

export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

export interface ReadOnlyReport {
  role: string;
  transactionReadOnly: boolean;
  /** The role itself has no write privilege on Graft's tables. */
  roleReadOnly: boolean;
  canRead: boolean;
  pgboss: boolean;
}

export async function inspectRole(db: Db): Promise<ReadOnlyReport> {
  const r = await sql<{
    role: string;
    ro: string;
    superuser: boolean;
    writes: boolean | null;
    can_read: boolean;
    pgboss: boolean;
  }>`
    select current_user as role,
           current_setting('transaction_read_only') as ro,
           (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as superuser,
           (select bool_or(has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in ('public', 'pgboss') and c.relkind in ('r', 'p')) as writes,
           has_table_privilege(current_user, 'public.changes', 'SELECT') as can_read,
           (to_regclass('pgboss.job') is not null
              and has_schema_privilege(current_user, 'pgboss', 'USAGE')
              and has_table_privilege(current_user, 'pgboss.job', 'SELECT')) as pgboss
  `.execute(db);
  const row = r.rows[0];
  if (!row) throw new Error("role inspection returned no row");
  return {
    role: row.role,
    transactionReadOnly: row.ro === "on",
    roleReadOnly: !row.superuser && row.writes !== true,
    canRead: row.can_read,
    pgboss: row.pgboss,
  };
}

/** Refuses to start on a connection that could write, unless the operator opted out. */
export async function verifyReadOnly(db: Db, requireRole: boolean): Promise<ReadOnlyReport> {
  let report: ReadOnlyReport;
  try {
    report = await inspectRole(db);
  } catch (err) {
    if (err instanceof Error && /relation "public\.changes" does not exist/.test(err.message)) {
      throw new ReadOnlyError("Graft's tables are missing: run Graft's migrations first");
    }
    throw err;
  }
  if (!report.transactionReadOnly) {
    throw new ReadOnlyError(
      "the connection is not read-only (default_transaction_read_only is off)",
    );
  }
  if (!report.canRead) {
    throw new ReadOnlyError(
      `role ${report.role} cannot read Graft's tables: apply console/sql/readonly-role.sql`,
    );
  }
  if (requireRole && !report.roleReadOnly) {
    throw new ReadOnlyError(
      `role ${report.role} can write to Graft's tables; connect as a SELECT-only role ` +
        "(console/sql/readonly-role.sql) or set CONSOLE_REQUIRE_READONLY_ROLE=false for local use",
    );
  }
  return report;
}
