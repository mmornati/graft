import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../../src/core/context.js";
import { createLogger } from "../../src/core/logger.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import { attributeReactions, type ReactionInput } from "../../src/modules/intent/feedback.js";
import {
  feedbackAction,
  rerequestIntent,
  scheduleIntent,
} from "../../src/modules/intent/handlers.js";
import { fixedClock, testConfig } from "../helpers/config.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { loadFixture, setPath } from "../helpers/fixtures.js";
import { silentLog, untouchableDb } from "../helpers/stubs.js";

const A = { id: "card-a", publishedAt: new Date("2026-10-14T10:00:00Z") };
const B = { id: "card-b", publishedAt: new Date("2026-10-14T12:00:00Z") };
const rx = (
  userId: number,
  login: string,
  content: string,
  createdAt: string,
  userType = "User",
): ReactionInput => ({ userId, login, userType, content, createdAt });

describe("attributeReactions", () => {
  it("U-FB-1 a reaction belongs to the card displayed when it was made", () => {
    const rows = attributeReactions(
      [
        rx(1, "u1", "+1", "2026-10-14T11:00:00Z"),
        rx(2, "u2", "-1", "2026-10-14T13:00:00Z"),
        rx(3, "u3", "+1", "2026-10-14T09:00:00Z"),
      ],
      [B, A],
      "author",
    );
    expect(rows.map((r) => [r.card_id, r.user_id, r.verdict])).toEqual([
      ["card-a", 1, "up"],
      ["card-b", 2, "down"],
    ]);
  });

  it("U-FB-7 displays, not cards: A, B, A again credits the later reaction to A; a notice display takes none", () => {
    const rows = attributeReactions(
      [
        rx(1, "u1", "+1", "2026-10-14T11:00:00Z"),
        rx(2, "u2", "-1", "2026-10-14T13:00:00Z"),
        rx(3, "u3", "+1", "2026-10-14T15:00:00Z"),
        rx(4, "u4", "-1", "2026-10-14T17:00:00Z"),
      ],
      [
        A,
        B,
        { id: "card-a", publishedAt: new Date("2026-10-14T14:00:00Z") },
        { id: "card-c", publishedAt: new Date("2026-10-14T16:00:00Z"), available: false },
      ],
      "author",
    );
    expect(rows.map((r) => [r.card_id, r.user_id])).toEqual([
      ["card-a", 1],
      ["card-a", 3],
      ["card-b", 2],
    ]);
  });

  it("U-FB-2 the same user changing their mind on a card leaves the latest reaction", () => {
    const rows = attributeReactions(
      [rx(1, "u1", "+1", "2026-10-14T10:30:00Z"), rx(1, "u1", "-1", "2026-10-14T11:30:00Z")],
      [A, B],
      "author",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "down",
      reacted_at: new Date("2026-10-14T11:30:00Z"),
    });
  });

  it("U-FB-3 other reactions, bots and null users are ignored", () => {
    const rows = attributeReactions(
      [
        rx(1, "u1", "laugh", "2026-10-14T11:00:00Z"),
        rx(2, "u2", "heart", "2026-10-14T11:00:00Z"),
        rx(3, "bot", "+1", "2026-10-14T11:00:00Z", "Bot"),
        rx(4, "u4", "+1", "not a date"),
      ],
      [A],
      "author",
    );
    expect(rows).toEqual([]);
  });

  it("U-FB-4 is_pr_author compares logins case-insensitively", () => {
    const rows = attributeReactions(
      [
        rx(1, "Graft-Dev", "+1", "2026-10-14T11:00:00Z"),
        rx(2, "other", "+1", "2026-10-14T11:00:00Z"),
      ],
      [A],
      "graft-dev",
    );
    expect(rows.map((r) => [r.user_login, r.is_pr_author])).toEqual([
      ["Graft-Dev", true],
      ["other", false],
    ]);
  });

  it("U-FB-5 two users and two cards give at most four rows in a stable order", () => {
    const reactions = [
      rx(2, "u2", "+1", "2026-10-14T13:00:00Z"),
      rx(1, "u1", "+1", "2026-10-14T13:00:00Z"),
      rx(2, "u2", "-1", "2026-10-14T11:00:00Z"),
      rx(1, "u1", "-1", "2026-10-14T11:00:00Z"),
    ];
    const rows = attributeReactions(reactions, [A, B], "x");
    expect(rows.map((r) => `${r.card_id}:${r.user_id}:${r.verdict}`)).toEqual([
      "card-a:1:down",
      "card-a:2:down",
      "card-b:1:up",
      "card-b:2:up",
    ]);
    expect(attributeReactions([...reactions].reverse(), [B, A], "x")).toEqual(rows);
  });

  it("U-FB-6 pure: inputs are not mutated", () => {
    const reactions = [rx(1, "u1", "+1", "2026-10-14T11:00:00Z")];
    const cards = [B, A];
    const before = structuredClone({ reactions, cards });
    attributeReactions(reactions, cards, "x");
    expect({ reactions, cards }).toEqual(before);
  });
});

describe("intent payload handling", () => {
  function ctx(logTo?: Writable): { ctx: JobContext; queue: FakeJobQueue; calls: string[] } {
    const { db, calls } = untouchableDb();
    const queue = new FakeJobQueue();
    return {
      ctx: {
        db,
        queue,
        github: {} as GitHubClientFactory,
        log: logTo ? createLogger({ logLevel: "info" }, logTo) : silentLog,
        clock: fixedClock,
        config: testConfig(),
        llm: forbiddenLlm(),
      },
      queue,
      calls,
    };
  }
  const event = (name: string, mutate?: (p: Record<string, unknown>) => void) => {
    const { payload } = loadFixture(name);
    mutate?.(payload);
    return { name: name.split(".")[0], payload, deliveryId: "d-1", id: "d-1" } as never;
  };

  it("U-PAY-6 intent.schedule rejects a mismatched number and is not registered for closed", async () => {
    const c = ctx();
    await scheduleIntent.handle(
      event("pull_request.opened", (p) => setPath(p, "pull_request.number", 999)),
      c.ctx,
    );
    expect(c.queue.sent).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(scheduleIntent.on).not.toContain("pull_request.closed");
    expect([...scheduleIntent.on].sort()).toEqual([
      "pull_request.edited",
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ]);
    // closed payload is also rejected by the schema's action enum
    await scheduleIntent.handle(event("pull_request.closed"), c.ctx);
    expect(c.queue.sent).toEqual([]);
  });

  it("U-PAY-7 intent.rerequest rejects a pull_request body delivered as check_run", async () => {
    const c = ctx();
    const pr = loadFixture("pull_request.opened").payload;
    await rerequestIntent.handle(
      { name: "check_run", payload: pr, deliveryId: "d" } as never,
      c.ctx,
    );
    expect(c.queue.sent).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it("U-PAY-8 intent.feedback-action ignores bad identifiers, apps, check names and bots", async () => {
    const c = ctx();
    const ev = (mutate: (p: Record<string, unknown>) => void) =>
      event("check_run.requested_action", mutate);
    await feedbackAction.handle(
      ev((p) => setPath(p, "requested_action.identifier", "delete_all")),
      c.ctx,
    );
    await feedbackAction.handle(
      ev((p) => setPath(p, "check_run.app.id", 999)),
      c.ctx,
    );
    await feedbackAction.handle(
      ev((p) => setPath(p, "check_run.name", "graft/provenance")),
      c.ctx,
    );
    await feedbackAction.handle(
      ev((p) => setPath(p, "sender.type", "Bot")),
      c.ctx,
    );
    expect(c.queue.sent).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it("U-PAY-9 warnings carry issue paths only, never payload strings", async () => {
    let out = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        out += String(chunk);
        cb();
      },
    });
    const c = ctx(stream);
    await scheduleIntent.handle(
      event("pull_request.opened", (p) => {
        setPath(p, "pull_request.title", 42);
        setPath(p, "pull_request.body", "BODY_CANARY_TEXT");
        setPath(p, "pull_request.number", 999);
      }),
      c.ctx,
    );
    expect(out).toContain("payload_shape_mismatch");
    expect(out).toContain("pull_request.title");
    expect(out).not.toContain("BODY_CANARY_TEXT");
  });
});
