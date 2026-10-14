import { createHash } from "node:crypto";
import { z } from "zod";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { findChangeByHead } from "../changes/index.js";
import { getActiveInstallation } from "../installations/index.js";
import { PROVENANCE_CHECK_NAME, provenanceRefreshJob, type RefreshData } from "./job.js";

/**
 * Handlers here treat the payload as a TRIGGER only: they validate its shape, read IDs, and
 * enqueue `provenance.refresh`. They never write state or call GitHub; the job re-fetches the PR.
 */

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const ACTIONS = ["opened", "synchronize", "reopened", "edited", "closed"] as const;

const pullRequestPayload = z
  .looseObject({
    action: z.enum(ACTIONS),
    number: z.number().int().positive(),
    pull_request: z.looseObject({
      number: z.number().int().positive(),
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
    app: z.looseObject({ id: z.number().int() }),
    pull_requests: z.array(z.looseObject({ number: z.number().int().positive() })),
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
 * D6 dedup key: (repo, PR, head, base, body hash, `pull_request.updated_at`). `updated_at` is in
 * EVERY key, otherwise a PR that returns to an earlier state (body X to Y to X, head H1 to H2 to
 * H1, close then reopen) would be swallowed by the completed job of that earlier state and leave
 * stale provenance. A replayed body carries the same `updated_at`, so replays still collapse.
 * The cost is a redundant (idempotent) job for title-only edits.
 */
export function refreshKey(p: {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseRef: string;
  body: string | null;
  updatedAt: string;
}): string {
  return `prov:${p.repositoryId}:${p.prNumber}:${p.headSha}:${p.baseRef}:${sha256_16(p.body ?? "")}:${p.updatedAt}`;
}

export const scheduleProvenance = defineWebhookHandler({
  name: "provenance.schedule",
  on: [
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.reopened",
    "pull_request.edited",
    "pull_request.closed",
  ] as const,
  async handle(event, ctx) {
    const p = parsePayload(pullRequestPayload, event, ctx.log);
    if (!p) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) {
      ctx.log.debug({ installationId: p.installation.id }, "installation inactive; skipping PR");
      return;
    }
    const data: RefreshData = {
      installationId: p.installation.id,
      repositoryId: p.repository.id,
      ...splitFullName(p.repository.full_name),
      prNumber: p.number,
      headSha: p.pull_request.head.sha,
      trigger: p.action,
      deliveryId: event.deliveryId,
    };
    await ctx.queue.send(provenanceRefreshJob, data, {
      singletonKey: refreshKey({
        repositoryId: data.repositoryId,
        prNumber: data.prNumber,
        headSha: data.headSha,
        baseRef: p.pull_request.base.ref,
        body: p.pull_request.body,
        updatedAt: p.pull_request.updated_at,
      }),
    });
  },
});

export const rerequestProvenance = defineWebhookHandler({
  name: "provenance.rerequest",
  on: ["check_run.rerequested"] as const,
  async handle(event, ctx) {
    const p = parsePayload(checkRunPayload, event, ctx.log);
    if (!p) return;
    if (
      p.check_run.name !== PROVENANCE_CHECK_NAME ||
      p.check_run.app.id !== ctx.config.githubAppId
    ) {
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
      provenanceRefreshJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        prNumber,
        headSha: p.check_run.head_sha,
        trigger: "rerequested",
        deliveryId: event.deliveryId,
      },
      { singletonKey: `prov-rerun:${event.deliveryId}` },
    );
  },
});
