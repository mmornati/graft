import { createHash } from "node:crypto";
import { z } from "zod";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { findChangeByHead } from "../changes/index.js";
import { getActiveInstallation } from "../installations/index.js";
import { feedbackRecordJob } from "./feedback.js";
import { type GenerateData, intentGenerateJob } from "./job.js";
import { INTENT_CHECK_NAME } from "./render.js";

/**
 * Handlers treat the payload as a TRIGGER only: they validate its shape, read IDs, and enqueue a
 * job. They never write state or call GitHub; the jobs re-fetch what they need. The one
 * documented exception to "jobs write only API data" is `intent.feedback.record` (D24).
 */

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const ACTIONS = ["opened", "synchronize", "reopened", "edited"] as const;

const pullRequestPayload = z
  .looseObject({
    action: z.enum(ACTIONS),
    number: z.number().int().positive(),
    pull_request: z.looseObject({
      number: z.number().int().positive(),
      title: z.string(),
      head: z.looseObject({ sha: SHA }),
      base: z.looseObject({ ref: z.string() }),
      body: z.string().nullable(),
      updated_at: z.string().min(1),
    }),
    repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
    installation: z.looseObject({ id: z.number().int().positive() }),
  })
  .refine((p) => p.number === p.pull_request.number, {
    path: ["pull_request", "number"],
    message: "number mismatch",
  });

const checkRunPayload = z.looseObject({
  action: z.literal("rerequested"),
  check_run: z.looseObject({
    name: z.string(),
    head_sha: SHA,
    external_id: z.string().nullish(),
    app: z.looseObject({ id: z.number().int() }),
    pull_requests: z.array(z.looseObject({ number: z.number().int().positive() })),
  }),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

const requestedActionPayload = z.looseObject({
  action: z.literal("requested_action"),
  check_run: z.looseObject({
    id: z.number().int().positive(),
    name: z.string(),
    head_sha: SHA,
    app: z.looseObject({ id: z.number().int() }),
  }),
  requested_action: z.looseObject({ identifier: z.string() }),
  sender: z.looseObject({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.string(),
  }),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

const sha256_16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
}

/**
 * D8 dedup key: `intent:{repoId}:{pr}:{head}:{base}:{sha16(title NUL body)}:{updated_at}:{action}`.
 * `updated_at` makes every real state, including A to B to A, a new key, while a replayed body
 * carries the same `updated_at` and collapses. `action` closes the same-second window.
 */
export function generateKey(p: {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseRef: string;
  title: string;
  body: string | null;
  updatedAt: string;
  action: string;
}): string {
  return `intent:${p.repositoryId}:${p.prNumber}:${p.headSha}:${p.baseRef}:${sha256_16(`${p.title}\u0000${p.body ?? ""}`)}:${p.updatedAt}:${p.action}`;
}

/** A re-run is allowed once per PR per minute. */
export function rerunKey(repositoryId: number, prNumber: number, nowMs: number): string {
  return `intent-rerun:${repositoryId}:${prNumber}:${Math.floor(nowMs / 60_000)}`;
}

export const scheduleIntent = defineWebhookHandler({
  name: "intent.schedule",
  on: [
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.reopened",
    "pull_request.edited",
  ] as const,
  async handle(event, ctx) {
    const p = parsePayload(pullRequestPayload, event, ctx.log);
    if (!p) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) {
      ctx.log.debug({ installationId: p.installation.id }, "installation inactive; skipping PR");
      return;
    }
    const data: GenerateData = {
      installationId: p.installation.id,
      repositoryId: p.repository.id,
      ...splitFullName(p.repository.full_name),
      prNumber: p.number,
      headSha: p.pull_request.head.sha,
      trigger: p.action,
      attempt: 0,
      deliveryId: event.deliveryId,
    };
    await ctx.queue.send(intentGenerateJob, data, {
      singletonKey: generateKey({
        repositoryId: data.repositoryId,
        prNumber: data.prNumber,
        headSha: data.headSha,
        baseRef: p.pull_request.base.ref,
        title: p.pull_request.title,
        body: p.pull_request.body,
        updatedAt: p.pull_request.updated_at,
        action: p.action,
      }),
    });
  },
});

export const rerequestIntent = defineWebhookHandler({
  name: "intent.rerequest",
  on: ["check_run.rerequested"] as const,
  async handle(event, ctx) {
    const p = parsePayload(checkRunPayload, event, ctx.log);
    if (!p) return;
    if (p.check_run.name !== INTENT_CHECK_NAME || p.check_run.app.id !== ctx.config.githubAppId) {
      return;
    }
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) {
      ctx.log.debug({ installationId: p.installation.id }, "installation inactive; skipping");
      return;
    }
    const prNumber =
      p.check_run.pull_requests[0]?.number ??
      (await findChangeByHead(ctx.db, p.repository.id, p.check_run.head_sha))?.pr_number;
    if (prNumber === undefined) {
      ctx.log.info({ headSha: p.check_run.head_sha }, "rerequested check run matches no PR");
      return;
    }
    await ctx.queue.send(
      intentGenerateJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        prNumber,
        headSha: p.check_run.head_sha,
        trigger: "rerequested",
        attempt: 0,
        deliveryId: event.deliveryId,
      },
      { singletonKey: rerunKey(p.repository.id, prNumber, ctx.clock.now().getTime()) },
    );
  },
});

const VERDICTS: Record<string, "up" | "down"> = { card_up: "up", card_down: "down" };

export const feedbackAction = defineWebhookHandler({
  name: "intent.feedback-action",
  on: ["check_run.requested_action"] as const,
  async handle(event, ctx) {
    const p = parsePayload(requestedActionPayload, event, ctx.log);
    if (!p) return;
    const verdict = VERDICTS[p.requested_action.identifier];
    if (
      p.check_run.name !== INTENT_CHECK_NAME ||
      p.check_run.app.id !== ctx.config.githubAppId ||
      verdict === undefined ||
      p.sender.type === "Bot"
    ) {
      return;
    }
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    await ctx.queue.send(
      feedbackRecordJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        checkRunId: p.check_run.id,
        ...(typeof p.check_run.external_id === "string" && p.check_run.external_id !== ""
          ? { externalId: p.check_run.external_id.slice(0, 100) }
          : {}),
        verdict,
        userId: p.sender.id,
        userLogin: p.sender.login,
        deliveryId: event.deliveryId,
      },
      { singletonKey: `fb-act:${event.deliveryId}` },
    );
  },
});
