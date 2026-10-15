import { describe, expect, it } from "vitest";
import { buildAppRegistry } from "../../src/app/registry.js";
import { scheduleIncidentDetection } from "../../src/modules/pilot/incidents.js";
import { hasLabel, parseCulprits } from "../../src/modules/pilot/index.js";
import { JOB_DEFAULTS, resolveJobOptions } from "../../src/queue/queue.js";
import { WEBHOOK_JOB_RETENTION_SECONDS } from "../../src/webhooks/dispatch-job.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { silentLog, untouchableDb } from "../helpers/stubs.js";

const where = { owner: "Acme", repo: "Api", prNumber: 50 };

describe("incident link parsing", () => {
  it("U-INC-1 `Reverts owner/repo#N` for this repository, `Graft-Culprit: #N`, at most 5, never the PR itself", () => {
    expect(parseCulprits("Reverts acme/api#812", where)).toEqual([812]);
    expect(parseCulprits("Reverts ACME/API#812\r\n", where)).toEqual([812]);
    // Another repository: none.
    expect(parseCulprits("Reverts other/api#812", where)).toEqual([]);
    expect(parseCulprits("Graft-Culprit: #9", where)).toEqual([9]);
    expect(parseCulprits("Graft-Culprit:#9\nGraft-Culprit:   #10   ", where)).toEqual([9, 10]);
    // The PR itself is dropped; duplicates collapse.
    expect(
      parseCulprits("Graft-Culprit: #50\nGraft-Culprit: #7\nGraft-Culprit: #7", where),
    ).toEqual([7]);
    // Only strict lines: prose, trailing text and the wrong form are ignored.
    expect(
      parseCulprits(
        "This reverts #12\nReverts acme/api#13 and more\nsee Graft-Culprit: #14\nrevert acme/api#15",
        where,
      ),
    ).toEqual([]);
    expect(parseCulprits(null, where)).toEqual([]);
    expect(parseCulprits("", where)).toEqual([]);
    // Seven links: the first five.
    const body = Array.from({ length: 7 }, (_, i) => `Graft-Culprit: #${i + 1}`).join("\n");
    expect(parseCulprits(body, where)).toEqual([1, 2, 3, 4, 5]);
  });

  it("U-INC-2 label `off` enqueues nothing and touches nothing; the label match is case-insensitive", async () => {
    expect(hasLabel([{ name: "Incident" }, { name: "x" }], "incident")).toBe(true);
    expect(hasLabel([{ name: "incidents" }], "incident")).toBe(false);
    expect(hasLabel([], "incident")).toBe(false);

    const queue = new FakeJobQueue();
    const { db, calls } = untouchableDb();
    const payload = {
      action: "labeled",
      pull_request: { number: 50, merged: false, updated_at: "2026-11-02T10:00:00Z", labels: [] },
      label: { name: "incident" },
      repository: { id: 2000001, full_name: "acme/api" },
      installation: { id: 1000001 },
    };
    const event = { name: "pull_request", deliveryId: "d1", payload } as never;
    const ctx = (cfg: Record<string, string>) =>
      ({
        db,
        queue,
        log: silentLog,
        config: testConfig(cfg),
        clock: { now: () => new Date("2026-11-02T10:00:00Z") },
      }) as never;
    await scheduleIncidentDetection.handle(event, ctx({ GRAFT_INCIDENT_LABEL: "off" }));
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);
    // A different label never reaches the database either.
    const other = { ...payload, label: { name: "bug" } };
    await scheduleIncidentDetection.handle(
      { name: "pull_request", deliveryId: "d2", payload: other } as never,
      ctx({}),
    );
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);
    // A closed PR that was not merged is not a trigger.
    await scheduleIncidentDetection.handle(
      {
        name: "pull_request",
        deliveryId: "d3",
        payload: { ...payload, action: "closed", label: undefined },
      } as never,
      ctx({}),
    );
    expect(queue.sent).toEqual([]);
  });
});

describe("queue retention (github.webhook)", () => {
  it("U-Q-6 only the webhook queue keeps completed jobs for 1 hour; every other job keeps 7 days", () => {
    const registry = buildAppRegistry();
    expect(WEBHOOK_JOB_RETENTION_SECONDS).toBe(3600);
    for (const job of registry.jobs) {
      const o = resolveJobOptions(job);
      if (job.name === "github.webhook") expect(o.deleteAfterSeconds, job.name).toBe(3600);
      else expect(o.deleteAfterSeconds, job.name).toBe(JOB_DEFAULTS.deleteAfterSeconds);
    }
    expect(JOB_DEFAULTS.deleteAfterSeconds).toBe(7 * 24 * 3600);
    expect(
      createRegistry({ webhookHandlers: [], jobs: [] }).webhookJob.options?.deleteAfterSeconds,
    ).toBe(3600);
  });
});
