import type { Logger } from "../../src/core/logger.js";
import { createLogger } from "../../src/core/logger.js";
import type { Db } from "../../src/db/client.js";

/** A Db stub that fails loudly if anything touches it. */
export function untouchableDb(): { db: Db; calls: string[] } {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      calls.push(String(prop));
      throw new Error(`db touched: ${String(prop)}`);
    },
  };
  return { db: new Proxy({}, handler) as unknown as Db, calls };
}

export const silentLog: Logger = createLogger({ logLevel: "silent" });
