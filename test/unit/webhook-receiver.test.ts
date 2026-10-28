import { describe, expect, it } from "vitest";
import type { AppDeps } from "../../src/core/context.js";
import { noSignals } from "../../src/core/signals.js";
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

async function setup(
  overrides: Record<string, string> = {},
  github: GitHubClientFactory = {} as GitHubClientFactory,
) {
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
    github,
    llm: forbiddenLlm(),
    signals: noSignals,
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

describe("webhook receiver: GRAFT_ALLOWED_ACCOUNTS (no DB)", () => {
  const ALLOW = { GRAFT_ALLOWED_ACCOUNTS: "mmornati,Horae-Dev" };
  const install = (login: string, action = "created") =>
    JSON.stringify({ action, installation: { id: 77, account: { id: 9, login } } });
  const post = (
    app: Awaited<ReturnType<typeof setup>>["app"],
    payload: string,
    event = "installation",
  ) =>
    app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers({
        "x-github-event": event,
        "x-hub-signature-256": sign(payload, TEST_WEBHOOK_SECRET),
      }),
      payload,
    });

  /** An App client that records each request it is asked to send. */
  function recordingGitHub() {
    const sent: { route: string; params: unknown }[] = [];
    const github = {
      asApp: () => ({
        request: async (route: string, params: unknown) => {
          sent.push({ route, params });
          return { status: 204 };
        },
      }),
    } as unknown as GitHubClientFactory;
    return { github, sent };
  }

  it("U-WH-9 an installation from an unlisted account -> 202 ignored; the stub DB/queue are never called", async () => {
    const { app, queue, calls } = await setup(ALLOW);
    const res = await post(app, install("stranger"));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "ignored" });
    expect(calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("U-WH-10 a repository event is matched on the repository owner; a listed account reaches the store", async () => {
    const { app, calls } = await setup(ALLOW);
    const pr = (owner: string) =>
      JSON.stringify({
        action: "opened",
        installation: { id: 77 },
        repository: { id: 5, owner: { login: owner } },
      });
    const refused = await post(app, pr("stranger"), "pull_request");
    expect(refused.json()).toEqual({ status: "ignored" });
    expect(calls).toEqual([]);
    // Matched case-insensitively; the untouchable DB then fails the store, so this is a 500.
    const allowed = await post(app, pr("horae-dev"), "pull_request");
    expect(allowed.statusCode).toBe(500);
    expect(calls).not.toEqual([]);
  });

  it("U-WH-11 GRAFT_UNINSTALL_UNLISTED=on removes the App on installation.created only", async () => {
    const { github, sent } = recordingGitHub();
    const { app } = await setup({ ...ALLOW, GRAFT_UNINSTALL_UNLISTED: "on" }, github);
    await post(app, install("stranger", "new_permissions_accepted"));
    await post(app, install("stranger"));
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([
      { route: "DELETE /app/installations/{installation_id}", params: { installation_id: 77 } },
    ]);
  });

  it("U-WH-12 GRAFT_UNINSTALL_UNLISTED off (the default) never removes the App", async () => {
    const { github, sent } = recordingGitHub();
    const { app } = await setup(ALLOW, github);
    await post(app, install("stranger"));
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([]);
  });
});
