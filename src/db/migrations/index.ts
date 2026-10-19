import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_initial.js";
import * as m0002 from "./0002_provenance.js";
import * as m0003 from "./0003_intent.js";
import * as m0004 from "./0004_intent_display_pending.js";
import * as m0005 from "./0005_policy.js";
import * as m0006 from "./0006_pilot.js";
import * as m0007 from "./0007_vote_eligibility.js";
import * as m0008 from "./0008_modes.js";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001,
  "0002_provenance": m0002,
  "0003_intent": m0003,
  "0004_intent_display_pending": m0004,
  "0005_policy": m0005,
  "0006_pilot": m0006,
  "0007_vote_eligibility": m0007,
  "0008_modes": m0008,
};
