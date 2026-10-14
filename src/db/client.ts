import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;

const INT8_OID = 20;
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
  int8ParserInstalled = true;
}

export function createDb(url: string, opts: { max?: number } = {}): Db {
  installInt8Parser();
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: opts.max ?? 10 }),
    }),
  });
}
