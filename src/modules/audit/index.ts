/**
 * The audit log (Phase 1 step 3): a store and the `graft audit` CLI helpers. No webhook handler and
 * no job: the policy job writes the rows inside its change lock, and step 5 reads them through
 * `mergedUnderBreakGlass` (D8).
 */
import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";

export const webhookHandlers: WebhookHandler[] = [];
export const jobs: JobDefinition<unknown>[] = [];

export {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  auditEntries,
  auditJson,
  isAuditKind,
  parseSince,
  renderAuditLine,
  repositoryIdsByName,
} from "./cli.js";
export {
  AUDIT_KINDS,
  type AuditKind,
  type AuditReason,
  type AuditRole,
  type AuditRow,
  activeBreakGlass,
  activeBreakGlassForChange,
  countAppliedSince,
  insertAuditRow,
  latestAuditForHead,
  listAudit,
  mergedUnderBreakGlass,
  type NewAuditRow,
} from "./store.js";
