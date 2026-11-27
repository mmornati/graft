import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { billingCloseJob } from "./job.js";

export const webhookHandlers: WebhookHandler[] = [];
export const jobs: JobDefinition<unknown>[] = [billingCloseJob as JobDefinition<unknown>];

export { BILLING_CLOSE_JOB, billingCloseJob } from "./job.js";
export { billingTeamSnapshot, storeBillingCalls } from "./ledger.js";
export {
  type BillingStatement,
  BillingStatementError,
  type BillingStatementLine,
  closeEligibleBillingPeriods,
  createBillingAdjustment,
  getBillingStatement,
} from "./statement.js";
export {
  archiveBillingTeam,
  BillingTeamError,
  type BillingTeamView,
  createBillingTeam,
  listBillingTeams,
  renameBillingTeam,
  setBillingTeamRepository,
} from "./teams.js";
