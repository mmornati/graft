import { describe, expect, it } from "vitest";
import type { AppDeps } from "../../src/core/context.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { buildServer } from "../../src/http/server.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import { defineWebhookHandler } from "../../src/webhooks/handler.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { fixedClock, TEST_WEBHOOK_SECRET, testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { sign } from "../helpers/sign.js";
import { silentLog, untouchableDb } from "../helpers/stubs.js";

const body = JSON.stringify({ action: "created", installation: { id: 1 } });

async function setup(overrides: Record<string, string> = {}) {
  const { db, calls } = untouchableDb();
  const queue = new FakeJobQueue();
  const registry = createRegistry({
    webhookHandlers: [
      defineWebhookHandler({ name: "t", on: ["installation"], handle: async () => {} }),
    ],
    jobs: [],
  });
  const deps: AppDeps = {
    config: testConfig(overrides),
    log: silentLog,
    db,
    queue,
    registry,
    clock: fixedClock,
    github: {} as GitHubClientFactory,
    llm: forbiddenLlm(),
  };
  const app = await buildServer(deps);
  return { app, queue, calls };
}

const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-github-event": "installation",
  "x-github-delivery": "d-1",
  "x-hub-signature-256": sign(body, TEST_WEBHOOK_SECRET),
  ...extra,
});

describe("webhook receiver (no DB)", () => {
  it("U-WH-1 missing x-hub-signature-256 -> 400; the stub DB/queue are never called", async () => {
    const { app, queue, calls } = await setup();
    const h: Record<string, string> = headers();
    delete h["x-hub-signature-256"];
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: h,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("U-WH-2 bad signature -> 401 invalid signature; the stub DB/queue are never called", async () => {
    const { app, queue, calls } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "x-hub-signature-256": sign(body, "some-other-secret-value") }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid signature" });
    expect(calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("U-WH-3 missing x-github-delivery or x-github-event -> 400", async () => {
    const { app } = await setup();
    for (const name of ["x-github-delivery", "x-github-event"]) {
      const h: Record<string, string> = headers();
      delete h[name];
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: h,
        payload: body,
      });
      expect(res.statusCode, name).toBe(400);
    }
  });

  it("U-WH-4 content-type application/x-www-form-urlencoded -> 415", async () => {
    const { app, calls } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
      payload: "payload=%7B%7D",
    });
    expect(res.statusCode).toBe(415);
    expect(calls).toEqual([]);
  });

  it("U-WH-5 a body over the limit (1 KB in the test) -> 413", async () => {
    const { app, calls } = await setup({ WEBHOOK_BODY_LIMIT_BYTES: "1024" });
    const big = JSON.stringify({ filler: "x".repeat(2048) });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "x-hub-signature-256": sign(big, TEST_WEBHOOK_SECRET) }),
      payload: big,
    });
    expect(res.statusCode).toBe(413);
    expect(calls).toEqual([]);
  });

  it("U-WH-6 a valid signature over non-JSON text -> 400", async () => {
    const { app, calls } = await setup();
    const text = "this is not json";
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "x-hub-signature-256": sign(text, TEST_WEBHOOK_SECRET) }),
      payload: text,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("unknown routes return JSON 404", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
  it("U-WH-7 a delivery id over 100 characters -> 400; the stub DB/queue are never called", async () => {
    const { app, queue, calls } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "x-github-delivery": "d".repeat(101) }),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("U-WH-8 an empty body with the headers present -> 400; the stub DB/queue are never called", async () => {
    const { app, queue, calls } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({ "x-hub-signature-256": sign("", TEST_WEBHOOK_SECRET) }),
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "empty body" });
    expect(calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });
});
