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

export { fetchIntentInputs } from "./fetch.js";
export {
  type CardResult,
  defaultGenerateOptions,
  type FailureReason,
  type GenerateOptions,
  generateCard,
  type InputStats,
  MAX_OUTPUT_TOKENS,
  type PreparedCard,
  prepareCardInputs,
  runCard,
  unavailableResult,
  type VerifierClaim,
} from "./generate.js";
// Step 4's eval harness imports only from here.
export type { CardInputs, ChangedFile } from "./inputs.js";
export { cardInputsSchema } from "./inputs.js";
export { PROMPT_VERSION, promptFingerprint } from "./prompts.js";
export {
  combineRisk,
  computeRiskFloor,
  DOCS_GLOBS,
  type FloorConfig,
  type FloorReason,
  type FloorRuleId,
  globMatcher,
  maxRisk,
  type RaiseReason,
  RISK_ORDER,
  type RiskClass,
  TEST_GLOBS,
} from "./risk-floor.js";
export { feedbackSummary } from "./store.js";
export { feedbackSweepJob };
