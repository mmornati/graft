import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../../src/core/context.js";
import { globMatcher } from "../../src/core/glob.js";
import { createLogger } from "../../src/core/logger.js";
import { type ChangeSignal, createSignals, noSignals } from "../../src/core/signals.js";
import type { Db } from "../../src/db/client.js";
import {
  basePushPolicy,
  onChangeSignal,
  pushTouchesPolicy,
  rerequestPolicy,
  reviewPolicy,
  scheduleKey,
  schedulePolicy,
} from "../../src/modules/policy/handlers.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { loadFixture } from "../helpers/fixtures.js";
import { untouchableDb } from "../helpers/stubs.js";

/** A Db whose every query chain ends in an active installation row. */
function activeDb(): Db {
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, prop) => {
      if (prop === "executeTakeFirst") return async () => ({ id: 1000001 });
      if (prop === "then") return undefined;
      return chain;
    },
    apply: () => chain,
  });
  return chain as Db;
}

function setup(db?: Db) {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const queue = new FakeJobQueue();
  const stub = untouchableDb();
  const ctx = {
    db: db ?? stub.db,
    queue,
    log: createLogger({ logLevel: "debug" }, stream),
    config: testConfig(),
    github: {},
    clock: { now: () => new Date("2026-10-14T12:00:30Z") },
  } as unknown as JobContext;
  return { ctx, queue, calls: stub.calls, logged: () => out };
}

type AnyHandler = { handle(e: never, c: JobContext): Promise<void> };
const run = (h: unknown, name: string, payload: unknown, ctx: JobContext) =>
  (h as AnyHandler).handle({ name, deliveryId: "d-1", payload } as never, ctx);

const PR_KEY = {
  repositoryId: 2000001,
  prNumber: 2,
  headSha: "e".repeat(40),
  baseRef: "main",
  updatedAt: "2026-10-14T11:00:00Z",
};

describe("policy handlers", () => {
  it("U-PH-1 policy.schedule keys: replays collapse; labeled A, unlabeled A and labeled B differ", async () => {
    const a = scheduleKey({ ...PR_KEY, action: "labeled", label: "A" });
    expect(scheduleKey({ ...PR_KEY, action: "labeled", label: "A" })).toBe(a);
    const unlabeledA = scheduleKey({ ...PR_KEY, action: "unlabeled", label: "A" });
    const labeledB = scheduleKey({ ...PR_KEY, action: "labeled", label: "B" });
    expect(new Set([a, unlabeledA, labeledB]).size).toBe(3);
    expect(a).toMatch(/^policy:pr:2000001:2:e{40}:main:2026-10-14T11:00:00Z:labeled:[0-9a-f]{16}$/);
    expect(scheduleKey({ ...PR_KEY, action: "opened", label: null })).toMatch(
      /:opened:[0-9a-f]{16}$/,
    );

    // Through the handler: the same body gives the same key; a labeled fixture carries its label.
    const { ctx, queue } = setup(activeDb());
    const labeled = loadFixture("pull_request.labeled").payload;
    await run(schedulePolicy, "pull_request", labeled, ctx);
    await run(schedulePolicy, "pull_request", structuredClone(labeled), ctx);
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[0]?.opts?.singletonKey).toBe(queue.sent[1]?.opts?.singletonKey);
    expect(queue.sent[0]?.name).toBe("policy.evaluate");
    expect(queue.sent[0]?.data).toMatchObject({
      trigger: "pr",
      owner: "graft-sandbox",
      repo: "sample-ts",
    });
    expect(Object.keys(queue.sent[0]?.data as object).sort()).toEqual([
      "deliveryId",
      "installationId",
      "owner",
      "prNumber",
      "repo",
      "repositoryId",
      "trigger",
    ]);
    const unlabeled = structuredClone(labeled) as Record<string, unknown>;
    unlabeled.action = "unlabeled";
    await run(schedulePolicy, "pull_request", unlabeled, ctx);
    const other = structuredClone(labeled) as Record<string, unknown>;
    (other.label as Record<string, unknown>).name = "other";
    await run(schedulePolicy, "pull_request", other, ctx);
    expect(new Set(queue.sent.map((s) => s.opts?.singletonKey)).size).toBe(3);

    // Review events key on the review id and action.
    const review = loadFixture("pull_request_review.submitted").payload;
    await run(reviewPolicy, "pull_request_review", review, ctx);
    const dismissed = loadFixture("pull_request_review.dismissed").payload;
    await run(reviewPolicy, "pull_request_review", dismissed, ctx);
    const keys = queue.sent.slice(-2).map((s) => s.opts?.singletonKey);
    expect(keys[0]).toMatch(/^policy:review:2000001:2:\d+:submitted$/);
    expect(keys[1]).toMatch(/^policy:review:2000001:2:\d+:dismissed$/);
    expect(queue.sent.at(-1)?.data).toMatchObject({ trigger: "review", prNumber: 2 });
  });

  it("U-PH-2 policy.base-push enqueues only for pushes that can change the policy", async () => {
    const base = loadFixture("push").payload as Record<string, unknown>;
    const commit = (over: Record<string, unknown>) => ({
      id: "a".repeat(40),
      added: [],
      modified: [],
      removed: [],
      ...over,
    });
    const variant = (over: Record<string, unknown>) => ({ ...structuredClone(base), ...over });
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["the fixture (graft.yaml modified)", {}, true],
      ["added", { commits: [commit({ added: ["graft.yaml"] })] }, true],
      ["removed", { commits: [commit({ removed: ["graft.yaml"] })] }, true],
      ["other files", { commits: [commit({ modified: ["src/a.ts", "sub/graft.yaml"] })] }, false],
      ["no commits", { commits: [] }, false],
      ["forced", { forced: true, commits: [commit({ modified: ["a"] })] }, true],
      [
        "20 commits",
        { commits: Array.from({ length: 20 }, () => commit({ modified: ["a"] })) },
        true,
      ],
      [
        "19 commits",
        { commits: Array.from({ length: 19 }, () => commit({ modified: ["a"] })) },
        false,
      ],
      ["deleted", { deleted: true }, false],
      ["a tag", { ref: "refs/tags/v1" }, false],
      ["zero after", { after: "0".repeat(40) }, false],
      ["short after", { after: "abc123" }, false],
    ];
    for (const [label, over, expected] of cases) {
      const { ctx, queue } = setup(activeDb());
      await run(basePushPolicy, "push", variant(over), ctx);
      expect(queue.sent.length, label).toBe(expected ? 1 : 0);
      if (expected) {
        expect(queue.sent[0]).toMatchObject({
          name: "policy.fanout",
          data: { branch: "master", afterSha: base.after, repositoryId: 2000001 },
        });
        expect(queue.sent[0]?.opts?.singletonKey).toBe(
          `policy-push:2000001:refs/heads/master:${String(base.after)}`,
        );
      }
    }
    expect(
      pushTouchesPolicy({ ref: "refs/heads/x", after: "a".repeat(40), commits: [] } as never),
    ).toBe(false);
    // An inactive installation enqueues nothing.
    const none: Db = new Proxy(() => none, {
      get: (_t, prop) =>
        prop === "executeTakeFirst" ? async () => undefined : prop === "then" ? undefined : none,
      apply: () => none,
    }) as unknown as Db;
    const { ctx, queue } = setup(none);
    await run(basePushPolicy, "push", base, ctx);
    expect(queue.sent).toEqual([]);
  });

  it("U-PH-3 policy.rerequest ignores other check names and other app ids", async () => {
    const { ctx, queue, calls } = setup();
    const p = structuredClone(loadFixture("check_run.rerequested").payload) as {
      check_run: { name: string; app: { id: number } };
    };
    expect(p.check_run.app.id).toBe(12345);
    p.check_run.name = "graft/provenance";
    await run(rerequestPolicy, "check_run", p, ctx);
    p.check_run.name = "graft/policy";
    p.check_run.app.id = 99999;
    await run(rerequestPolicy, "check_run", p, ctx);
    p.check_run.name = "other/check";
    p.check_run.app.id = 12345;
    await run(rerequestPolicy, "check_run", p, ctx);
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);

    // The right name and app: one job per PR per minute.
    const live = setup(activeDb());
    p.check_run.name = "graft/policy";
    await run(rerequestPolicy, "check_run", p, live.ctx);
    expect(live.queue.sent).toHaveLength(1);
    expect(live.queue.sent[0]?.opts?.singletonKey).toBe(
      `policy-rerun:2000001:2:${Math.floor(Date.parse("2026-10-14T12:00:30Z") / 60_000)}`,
    );
    expect(live.queue.sent[0]?.data).toMatchObject({ trigger: "rerequested", prNumber: 2 });
  });

  it("U-PH-4 a payload that does not fit the event is logged and nothing is enqueued", async () => {
    const { ctx, queue, calls, logged } = setup();
    await run(schedulePolicy, "pull_request", loadFixture("installation.created").payload, ctx);
    await run(reviewPolicy, "pull_request_review", loadFixture("pull_request.opened").payload, ctx);
    await run(rerequestPolicy, "check_run", loadFixture("pull_request.opened").payload, ctx);
    await run(basePushPolicy, "push", loadFixture("pull_request.opened").payload, ctx);
    const wrongNumber = structuredClone(loadFixture("pull_request.opened").payload);
    wrongNumber.number = 99;
    await run(schedulePolicy, "pull_request", wrongNumber, ctx);
    expect(queue.sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(logged().match(/payload_shape_mismatch/g)).toHaveLength(5);
  });

  it("the signal listener enqueues one evaluation per signal", async () => {
    const { ctx, queue } = setup();
    const signal: ChangeSignal = {
      kind: "intent_published",
      installationId: 1000001,
      repositoryId: 2000001,
      owner: "graft-sandbox",
      repo: "sample-ts",
      prNumber: 2,
      changeId: "c1",
      headSha: "e".repeat(40),
      atMs: 1234,
    };
    await onChangeSignal(signal, ctx);
    await onChangeSignal({ ...signal, kind: "provenance_published", atMs: 1235 }, ctx);
    expect(
      queue.sent.map((s) => [
        s.name,
        (s.data as { trigger: string }).trigger,
        s.opts?.singletonKey,
      ]),
    ).toEqual([
      ["policy.evaluate", "intent", `policy:sig:intent_published:c1:${"e".repeat(40)}:1234`],
      [
        "policy.evaluate",
        "provenance",
        `policy:sig:provenance_published:c1:${"e".repeat(40)}:1235`,
      ],
    ]);
  });
});

describe("shared pieces", () => {
  it("U-GLOB-1 globMatcher cache keys separate nocase", () => {
    const sensitive = globMatcher(["CaseKeyDir/**"], { nocase: false });
    const insensitive = globMatcher(["CaseKeyDir/**"]);
    expect(sensitive("casekeydir/a")).toBe(false);
    expect(insensitive("casekeydir/a")).toBe(true);
    // The other order, and a repeat that must come from the cache.
    const insensitive2 = globMatcher(["OtherKeyDir/**"], { nocase: true });
    const sensitive2 = globMatcher(["OtherKeyDir/**"], { nocase: false });
    expect(insensitive2("otherkeydir/a")).toBe(true);
    expect(sensitive2("otherkeydir/a")).toBe(false);
    expect(globMatcher(["OtherKeyDir/**"], { nocase: false })).toBe(sensitive2);
    expect(globMatcher(["OtherKeyDir/**"])).toBe(insensitive2);
    expect(globMatcher(["OtherKeyDir/**"])).not.toBe(sensitive2);
  });

  it("U-SIG-1 createSignals calls the listeners in order and propagates errors; noSignals does nothing", async () => {
    const order: string[] = [];
    const signal = { kind: "intent_published", atMs: 1 } as ChangeSignal;
    const ctx = {} as JobContext;
    const signals = createSignals([
      async (s) => void order.push(`a${s.atMs}`),
      async () => void order.push("b"),
    ]);
    await signals.emit(signal, ctx);
    expect(order).toEqual(["a1", "b"]);

    const failing = createSignals([
      async () => void order.push("first"),
      async () => {
        throw new Error("listener failed");
      },
      async () => void order.push("never"),
    ]);
    await expect(failing.emit(signal, ctx)).rejects.toThrow("listener failed");
    expect(order).toEqual(["a1", "b", "first"]);

    await expect(noSignals.emit(signal, ctx)).resolves.toBeUndefined();
    await expect(createSignals([]).emit(signal, ctx)).resolves.toBeUndefined();
  });

  it("the registry collects signal listeners from the modules that export them", async () => {
    const listener = async () => {};
    const r = createRegistry({ webhookHandlers: [], jobs: [], signalListeners: [listener] });
    expect(r.signalListeners).toEqual([listener]);
    expect(createRegistry({ webhookHandlers: [], jobs: [] }).signalListeners).toEqual([]);
    const { buildAppRegistry } = await import("../../src/app/registry.js");
    const app = buildAppRegistry();
    expect(app.signalListeners).toHaveLength(1);
    expect(app.jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining(["policy.evaluate", "policy.fanout"]),
    );
    expect(app.isHandled("push", undefined)).toBe(true);
    expect(app.isHandled("pull_request_review", "submitted")).toBe(true);
    expect(app.isHandled("pull_request", "labeled")).toBe(true);
    expect(app.isHandled("pull_request_review", "edited")).toBe(false);
  });
});
