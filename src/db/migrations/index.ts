import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_initial.js";
import * as m0002 from "./0002_provenance.js";
import * as m0003 from "./0003_intent.js";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001,
  "0002_provenance": m0002,
  "0003_intent": m0003,
};
