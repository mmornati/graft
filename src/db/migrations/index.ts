import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_initial.js";
import * as m0002 from "./0002_provenance.js";
import * as m0003 from "./0003_intent.js";
import * as m0004 from "./0004_intent_display_pending.js";
import * as m0005 from "./0005_policy.js";
import * as m0006 from "./0006_pilot.js";
import * as m0007 from "./0007_vote_eligibility.js";
import * as m0008 from "./0008_modes.js";
import * as m0009 from "./0009_enforce.js";
import * as m0010 from "./0010_audit_log.js";
import * as m0011 from "./0011_guard.js";
import * as m0012 from "./0012_audit_label_event.js";
import * as m0013 from "./0013_guard_revert.js";
import * as m0014 from "./0014_mcp.js";
import * as m0015 from "./0015_mcp_open_claims.js";
import * as m0016 from "./0016_phase1_gate.js";
import * as m0017 from "./0017_intent_requested.js";
import * as m0018 from "./0018_repository_filter.js";
import * as m0019 from "./0019_team_chargeback.js";
import * as m0020 from "./0020_billing_auditability.js";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001,
  "0002_provenance": m0002,
  "0003_intent": m0003,
  "0004_intent_display_pending": m0004,
  "0005_policy": m0005,
  "0006_pilot": m0006,
  "0007_vote_eligibility": m0007,
  "0008_modes": m0008,
  "0009_enforce": m0009,
  "0010_audit_log": m0010,
  "0011_guard": m0011,
  "0012_audit_label_event": m0012,
  "0013_guard_revert": m0013,
  "0014_mcp": m0014,
  "0015_mcp_open_claims": m0015,
  "0016_phase1_gate": m0016,
  "0017_intent_requested": m0017,
  "0018_repository_filter": m0018,
  "0019_team_chargeback": m0019,
  "0020_billing_auditability": m0020,
};
