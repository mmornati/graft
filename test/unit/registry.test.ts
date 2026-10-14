import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JobContext } from "../../src/core/context.js";
import { createLogger } from "../../src/core/logger.js";
import { defineJob } from "../../src/queue/job.js";
import { defineWebhookHandler } from "../../src/webhooks/handler.js";
import { createRegistry } from "../../src/webhooks/registry.js";
import { silentLog } from "../helpers/stubs.js";

const noop = async () => {};
const h = (name: string, on: string[]) =>
  defineWebhookHandler({ name, on: on as never, handle: noop });

describe("registry", () => {
  it("U-REG-1 handlersFor matches event and event.action keys, in order, without duplicates", () => {
    const r = createRegistry({
      webhookHandlers: [
        h("a", ["installation.created"]),
        h("b", ["installation"]),
        h("c", ["installation", "installation.created"]),
        h("d", ["pull_request"]),
      ],
      jobs: [],
    });
    expect(r.handlersFor("installation", "created").map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(r.handlersFor("installation", "deleted").map((x) => x.name)).toEqual(["b", "c"]);
    expect(r.handlersFor("installation", undefined).map((x) => x.name)).toEqual(["b", "c"]);
  });

  it("U-REG-2 an unregistered event is not handled", () => {
    const r = createRegistry({ webhookHandlers: [h("a", ["installation"])], jobs: [] });
    expect(r.isHandled("pull_request", "opened")).toBe(false);
    expect(r.isHandled("ping", undefined)).toBe(false);
    expect(r.isHandled("installation", "created")).toBe(true);
  });

  it("U-REG-3 duplicate handler names throw; duplicate job names throw", () => {
    expect(() =>
      createRegistry({ webhookHandlers: [h("a", ["x"]), h("a", ["y"])], jobs: [] }),
    ).toThrow(/duplicate webhook handler/);
    const job = defineJob({ name: "x.y", schema: z.object({}), handle: noop });
    expect(() => createRegistry({ webhookHandlers: [], jobs: [job, job] })).toThrow(
      /duplicate job/,
    );
    const clash = defineJob({ name: "github.webhook", schema: z.object({}), handle: noop });
    expect(() => createRegistry({ webhookHandlers: [], jobs: [clash] })).toThrow(/duplicate job/);
  });

  it("U-REG-4 github.webhook is always in jobs", () => {
    const r = createRegistry({ webhookHandlers: [], jobs: [] });
    expect(r.jobs.map((j) => j.name)).toContain("github.webhook");
  });
});

function ctxWith(log = silentLog): JobContext {
  return { log } as unknown as JobContext;
}
const data = (event: string, action?: string) => ({
  deliveryId: "d1",
  event,
  ...(action ? { action } : {}),
  payload: {},
});

describe("dispatch job", () => {
  it("U-DISPATCH-1 calls matching handlers in order and rethrows the first error", async () => {
    const calls: string[] = [];
    const ok = (n: string) =>
      defineWebhookHandler({
        name: n,
        on: ["installation"],
        handle: async () => void calls.push(n),
      });
    const boom = defineWebhookHandler({
      name: "boom",
      on: ["installation"],
      handle: async () => {
        calls.push("boom");
        throw new Error("first failure");
      },
    });
    const never = ok("never");
    const r = createRegistry({ webhookHandlers: [ok("one"), boom, never], jobs: [] });
    await expect(r.webhookJob.handle(data("installation", "created"), ctxWith())).rejects.toThrow(
      "first failure",
    );
    expect(calls).toEqual(["one", "boom"]);
  });

  it("U-DISPATCH-2 with no matching handler it completes and logs at warn", async () => {
    const r = createRegistry({ webhookHandlers: [], jobs: [] });
    const log = createLogger({ logLevel: "silent" });
    const warn = vi.spyOn(log, "warn");
    await expect(
      r.webhookJob.handle(data("pull_request", "opened"), ctxWith(log)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
