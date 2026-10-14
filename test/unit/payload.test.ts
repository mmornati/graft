import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../../src/core/context.js";
import { createLogger } from "../../src/core/logger.js";
import { trackInstallations } from "../../src/modules/installations/handlers.js";
import { rerequestProvenance, scheduleProvenance } from "../../src/modules/provenance/handlers.js";
import { testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { loadFixture } from "../helpers/fixtures.js";
import { untouchableDb } from "../helpers/stubs.js";

function setup() {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const queue = new FakeJobQueue();
  const { db, calls } = untouchableDb();
  const ctx = {
    db,
    queue,
    log: createLogger({ logLevel: "debug" }, stream),
    config: testConfig(),
    github: {},
    clock: { now: () => new Date() },
  } as unknown as JobContext;
  return { ctx, queue, calls, logged: () => out };
}

type AnyHandler = { handle(e: never, c: JobContext): Promise<void> };
const run = (h: unknown, name: string, payload: unknown, ctx: JobContext) =>
  (h as AnyHandler).handle({ name, deliveryId: "d-1", payload } as never, ctx);

describe("payload shape validation", () => {
  it("U-PAY-1 provenance.schedule with an installation.created body under event pull_request is rejected", async () => {
    const { ctx, queue, calls, logged } = setup();
    await run(scheduleProvenance, "pull_request", loadFixture("installation.created").payload, ctx);
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(logged()).toContain("payload_shape_mismatch");
  });

  it("U-PAY-2 a pull_request body whose number differs from pull_request.number is rejected", async () => {
    const { ctx, queue, logged } = setup();
    const p = structuredClone(loadFixture("pull_request.opened").payload);
    p.number = 99;
    await run(scheduleProvenance, "pull_request", p, ctx);
    expect(queue.sent).toEqual([]);
    expect(logged()).toContain("payload_shape_mismatch");
    expect(logged()).toContain("pull_request.number");
  });

  it("U-PAY-3 provenance.rerequest with a pull_request body under event check_run is rejected", async () => {
    const { ctx, queue, calls, logged } = setup();
    await run(rerequestProvenance, "check_run", loadFixture("pull_request.opened").payload, ctx);
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(logged()).toContain("payload_shape_mismatch");
  });

  it("U-PAY-4 installations.track with a pull_request body under installation_repositories is rejected and the DB is never touched", async () => {
    const { ctx, calls, logged } = setup();
    await run(
      trackInstallations,
      "installation_repositories",
      loadFixture("pull_request.opened").payload,
      ctx,
    );
    expect(calls).toEqual([]);
    expect(logged()).toContain("payload_shape_mismatch");

    // An installation_repositories body that lacks the added/removed arrays is rejected too.
    const { ctx: c2, calls: calls2 } = setup();
    const p = structuredClone(loadFixture("installation_repositories.added").payload);
    delete p.repositories_removed;
    await run(trackInstallations, "installation_repositories", p, c2);
    expect(calls2).toEqual([]);

    // An unknown installation action is ignored at debug level without touching the DB.
    const { ctx: c3, calls: calls3, logged: log3 } = setup();
    const q = structuredClone(loadFixture("installation.created").payload);
    q.action = "something_new";
    await run(trackInstallations, "installation", q, c3);
    expect(calls3).toEqual([]);
    expect(log3()).toContain("installation action not tracked");
  });

  it("U-PAY-5 the warn log carries issue paths only, never payload values", async () => {
    const { ctx, logged } = setup();
    const p = structuredClone(loadFixture("pull_request.opened").payload);
    const pr = p.pull_request as Record<string, unknown>;
    pr.title = "SECRET-TITLE-VALUE";
    pr.body = "SECRET-BODY-VALUE";
    (pr.head as Record<string, unknown>).sha = "not-a-sha-SECRET-SHA";
    await run(scheduleProvenance, "pull_request", p, ctx);
    const text = logged();
    expect(text).toContain("payload_shape_mismatch");
    expect(text).toContain("pull_request.head.sha");
    for (const s of ["SECRET-TITLE-VALUE", "SECRET-BODY-VALUE", "SECRET-SHA"]) {
      expect(text).not.toContain(s);
    }
  });
});
