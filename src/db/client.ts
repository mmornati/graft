import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;

const INT8_OID = 20;
const DATE_OID = 1082;
let int8ParserInstalled = false;

/** int8 → number; throws above Number.MAX_SAFE_INTEGER (GitHub IDs fit in 2^53). */
function installInt8Parser(): void {
  if (int8ParserInstalled) return;
  pg.types.setTypeParser(INT8_OID, (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new RangeError("bigint value exceeds Number.MAX_SAFE_INTEGER");
    }
    return n;
  });
  // date → 'YYYY-MM-DD' (the default would build a Date at local midnight).
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  int8ParserInstalled = true;
}

export function createDb(url: string, opts: { max?: number; readOnly?: boolean } = {}): Db {
  installInt8Parser();
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        max: opts.max ?? 10,
        // The e2e runner only observes: every statement of its session is read-only.
        ...(opts.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
      }),
    }),
  });
}
