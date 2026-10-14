import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_initial.js";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001,
};
