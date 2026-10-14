import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { feedbackPollJob, feedbackRecordJob, feedbackSweepJob } from "./feedback.js";
import { feedbackAction, rerequestIntent, scheduleIntent } from "./handlers.js";
import { intentGenerateJob } from "./job.js";

export const webhookHandlers: WebhookHandler[] = [scheduleIntent, rerequestIntent, feedbackAction];
export const jobs: JobDefinition<unknown>[] = [
  intentGenerateJob as JobDefinition<unknown>,
  feedbackRecordJob as JobDefinition<unknown>,
  feedbackPollJob as JobDefinition<unknown>,
  feedbackSweepJob as JobDefinition<unknown>,
];

export {
  type CardResult,
  defaultGenerateOptions,
  type FailureReason,
  type GenerateOptions,
  generateCard,
  type InputStats,
  type PreparedCard,
  prepareCardInputs,
  runCard,
  unavailableResult,
  type VerifierClaim,
} from "./generate.js";

// Step 4's eval harness imports only from here.
export type { CardInputs, ChangedFile } from "./inputs.js";
export { cardInputsSchema } from "./inputs.js";
export { PROMPT_VERSION } from "./prompts.js";
export {
  combineRisk,
  computeRiskFloor,
  type FloorConfig,
  type FloorReason,
  type FloorRuleId,
  type RaiseReason,
  type RiskClass,
} from "./risk-floor.js";
export { feedbackSummary } from "./store.js";
export { feedbackSweepJob };
