/**
 * s10's fingerprint against a real pg-boss schema (I-LIVE-S10-1): jobs that the clock sends during
 * the stability window (a cron and what it fans out to) are not counted; any other job for the
 * installation is, and is named by queue.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StepCtx } from "../../src/e2e/plan.js";
import { fingerprint } from "../../src/e2e/scenarios/s10.js";
import { feedbackPollJob } from "../../src/modules/intent/feedback.js";
import { refreshPermissionsJob } from "../../src/modules/modes/permissions.js";
import { reviewersSyncJob } from "../../src/modules/pilot/reviewers.js";
import { policyEvaluateJob } from "../../src/modules/policy/job.js";
import { createTestApp, type TestApp } from "../helpers/app.js";
import { INSTALLATION_ID, OWNER, REPO, REPO_ID } from "../helpers/github-builders.js";

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());

const ids = { installationId: INSTALLATION_ID, repositoryId: REPO_ID, owner: OWNER, repo: REPO };

describe("s10 fingerprint", () => {
  it("I-LIVE-S10-1 clock-driven jobs are left out of jobsSince, other jobs are named", async () => {
    const sx = {
      run: {
        db: app.db,
        config: app.deps.config,
        installationId: INSTALLATION_ID,
        repositoryId: REPO_ID,
      },
    } as unknown as StepCtx;
    const now = await sql<{ t: Date }>`select now() as t`.execute(app.db);
    const since = now.rows[0]?.t ?? new Date();
    const fp = () => fingerprint(sx, { prNumber: 999_999, since, withDeliveryCounts: false });
    expect(await fp()).toEqual({ jobsSince: [] });

    const q = app.deps.queue;
    // The feedback sweep's poll (the CI failure), the daily permissions fan-out, and the reviewer
    // sync that a vote found by the poll sends.
    await q.send(feedbackPollJob, { ...ids, changeId: randomUUID() });
    await q.send(refreshPermissionsJob, { installationId: INSTALLATION_ID });
    await q.send(
      reviewersSyncJob,
      { ...ids, prNumber: 1 },
      { singletonKey: `rev-sync:${REPO_ID}:1:0` },
    );
    expect(await fp()).toEqual({ jobsSince: [] });

    // A reviewer sync on a first publication, and a policy evaluation, would be Graft's doing.
    await q.send(
      reviewersSyncJob,
      { ...ids, prNumber: 1 },
      { singletonKey: `rev-sync-open:${REPO_ID}:1` },
    );
    await q.send(policyEvaluateJob, { ...ids, prNumber: 1, trigger: "intent" });
    expect(await fp()).toEqual({
      jobsSince: ["pilot.reviewers.sync:1", "policy.evaluate:1"],
    });
  });
});
