import type { SignalListener } from "../../core/signals.js";
import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import {
  basePushPolicy,
  onChangeSignal,
  rerequestPolicy,
  reviewPolicy,
  schedulePolicy,
} from "./handlers.js";
import { policyEvaluateJob, policyFanoutJob } from "./job.js";

export const webhookHandlers: WebhookHandler[] = [
  schedulePolicy,
  reviewPolicy,
  rerequestPolicy,
  basePushPolicy,
];
export const jobs: JobDefinition<unknown>[] = [
  policyEvaluateJob as JobDefinition<unknown>,
  policyFanoutJob as JobDefinition<unknown>,
];
export const signalListeners: SignalListener[] = [onChangeSignal];
