import { describe, expect, it } from "vitest";
import { createGitHubClientFactory } from "../../src/github/client-factory.js";
import {
  MANAGED_COMMENT_MARKER,
  parseManagedComment,
  renderManagedComment,
  upsertManagedSection,
} from "../../src/github/managed-comment.js";
import { refuseAllGate } from "../../src/github/mutation-guard.js";
import { TEST_PRIVATE_KEY } from "../helpers/config.js";
import { createFakeGitHubApi, type FakeComment } from "../helpers/fake-github-api.js";
import { EXPECTED_COMMENT, EXPECTED_SECTION } from "../helpers/provenance-scenario.js";

const APP_ID = 12345;

async function setup() {
  const api = createFakeGitHubApi({ appId: APP_ID });
  const client = await createGitHubClientFactory({
    appId: APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    baseUrl: "https://api.github.com",
    gate: refuseAllGate,
    fetch: api.fetch,
  }).forInstallation(1);
  const base = {
    owner: "graft-sandbox",
    repo: "sample-ts",
    issueNumber: 2,
    appId: APP_ID,
    knownCommentId: null as number | null,
  };
  const call = (over: Partial<Parameters<typeof upsertManagedSection>[1]> = {}) =>
    upsertManagedSection(client, { ...base, section: "provenance", markdown: "P1", ...over });
  const writes = () =>
    api.requests.filter((r) => r.method !== "GET" && !r.path.includes("access_tokens"));
  return { api, call, writes };
}

const ours = (id: number, body: string, over: Partial<FakeComment> = {}): FakeComment => ({
  id,
  body,
  user: { login: "graft-dev[bot]", type: "Bot" },
  performed_via_github_app: { id: APP_ID },
  ...over,
});

describe("managed comment", () => {
  it("U-MC-1 renders only a provenance section byte-exact", () => {
    expect(renderManagedComment(new Map([["provenance", EXPECTED_SECTION]]))).toBe(
      EXPECTED_COMMENT,
    );
  });

  it("U-MC-2 parse then render keeps an intent section and an unknown section byte-for-byte", () => {
    const sections = new Map([
      ["zz-future", "future\n\n  stuff <b>"],
      ["provenance", "P"],
      ["intent", "### Intent\n\nline"],
    ]);
    const body = renderManagedComment(sections);
    // Known sections come first in SECTION_ORDER, unknown ones after.
    expect([...(parseManagedComment(body)?.keys() ?? [])]).toEqual([
      "intent",
      "provenance",
      "zz-future",
    ]);
    const parsed = parseManagedComment(body);
    expect(parsed?.get("intent")).toBe("### Intent\n\nline");
    expect(parsed?.get("zz-future")).toBe("future\n\n  stuff <b>");
    expect(renderManagedComment(parsed ?? new Map())).toBe(body);
    expect(() => renderManagedComment(new Map([["Bad Name", "x"]]))).toThrow();
  });

  it("U-MC-3 parseManagedComment is null unless the marker is the first line", () => {
    expect(parseManagedComment(`hello\n${MANAGED_COMMENT_MARKER}\n`)).toBeNull();
    expect(parseManagedComment(` ${MANAGED_COMMENT_MARKER}`)).toBeNull();
    expect(parseManagedComment("")).toBeNull();
    expect(parseManagedComment(MANAGED_COMMENT_MARKER)?.size).toBe(0);
  });

  it("U-MC-4 a valid knownCommentId is the only comment fetched and patched; other sections are kept", async () => {
    const { api, call, writes } = await setup();
    const existing = renderManagedComment(
      new Map([
        ["intent", "INTENT"],
        ["provenance", "OLD"],
      ]),
    );
    api.state.comments.push(ours(7, "unrelated"), ours(8, existing));
    const res = await call({ knownCommentId: 8 });
    expect(res).toEqual({ commentId: 8, action: "updated" });
    expect(api.requests.some((r) => r.path.endsWith("/issues/2/comments"))).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "PATCH",
      path: expect.stringMatching(/comments\/8$/),
    });
    const body = api.state.comments.find((c) => c.id === 8)?.body ?? "";
    expect(parseManagedComment(body)?.get("intent")).toBe("INTENT");
    expect(parseManagedComment(body)?.get("provenance")).toBe("P1");
  });

  it("U-MC-5 a 404 knownCommentId falls back to listing; ours is found by marker and app id", async () => {
    const { api, call, writes } = await setup();
    api.state.comments.push(ours(5, renderManagedComment(new Map([["provenance", "OLD"]]))));
    const res = await call({ knownCommentId: 999 });
    expect(res).toEqual({ commentId: 5, action: "updated" });
    expect(writes().map((w) => w.method)).toEqual(["PATCH"]);
  });

  it("U-MC-6 a marker comment from someone else (other app id, or none) is ignored", async () => {
    const { api, call } = await setup();
    const body = renderManagedComment(new Map([["provenance", "FAKE"]]));
    api.state.comments.push(
      ours(1, body, { performed_via_github_app: { id: 999 } }),
      ours(2, body, { performed_via_github_app: null, user: { login: "human", type: "User" } }),
      ours(3, body, {
        performed_via_github_app: undefined,
        user: { login: "graft-dev[bot]", type: "User" },
      }),
    );
    const res = await call({ knownCommentId: 1 });
    expect(res.action).toBe("created");
    expect(res.commentId).not.toBe(1);
    expect(api.state.comments).toHaveLength(4);
    expect(api.state.comments[0]?.body).toContain("FAKE");
  });

  it("U-MC-7 an identical rendered body is 'unchanged' and sends no write", async () => {
    const { api, call, writes } = await setup();
    const first = await call();
    expect(first.action).toBe("created");
    const before = writes().length;
    const again = await call({ knownCommentId: first.commentId });
    expect(again).toEqual({ commentId: first.commentId, action: "unchanged" });
    expect(writes()).toHaveLength(before);
    expect(api.state.comments).toHaveLength(1);
  });

  it("U-MC-8 a section with a graft marker, or over 20,000 characters, throws before any request", async () => {
    const { api, call } = await setup();
    const permanent = { name: "PermanentJobError", reason: "invalid_output" };
    await expect(
      call({ markdown: "x <!-- graft:section:policy:start --> y" }),
    ).rejects.toMatchObject(permanent);
    await expect(call({ markdown: "x".repeat(20_001) })).rejects.toMatchObject(permanent);
    expect(api.requests).toHaveLength(0);
    await expect(call({ markdown: "x".repeat(20_000) })).resolves.toMatchObject({
      action: "created",
    });
  });

  it("U-MC-9 D13 fallback: with no performed_via_github_app, the App's bot login plus the marker identifies our comment", async () => {
    const { api, call } = await setup();
    api.state.omitPerformedViaApp = true;
    const created = await call({ appBotLogin: "graft-dev[bot]" });
    expect(created.action).toBe("created");
    expect(api.state.comments[0]?.performed_via_github_app).toBeUndefined();

    // Found again by login, via the known id and via listing.
    expect(
      await call({ appBotLogin: "Graft-Dev[bot]", knownCommentId: created.commentId }),
    ).toEqual({
      commentId: created.commentId,
      action: "unchanged",
    });
    expect(await call({ appBotLogin: "graft-dev[bot]", markdown: "P2" })).toEqual({
      commentId: created.commentId,
      action: "updated",
    });
    expect(api.state.comments).toHaveLength(1);
  });

  it("U-MC-10 D13 fallback is strict: a human with the marker, a different bot, or no slug configured is not adopted", async () => {
    const { api, call } = await setup();
    const body = renderManagedComment(new Map([["provenance", "FAKE"]]));
    api.state.comments.push(
      ours(1, body, { performed_via_github_app: null, user: { login: "graft-dev", type: "User" } }),
      ours(2, body, {
        performed_via_github_app: null,
        user: { login: "other-app[bot]", type: "Bot" },
      }),
      ours(3, body, {
        performed_via_github_app: null,
        user: { login: "graft-dev[bot]", type: "Bot" },
      }),
    );
    // Without the slug the fallback is off.
    expect((await call()).action).toBe("created");
    // With the slug only comment 3 qualifies.
    const res = await call({ appBotLogin: "graft-dev[bot]", markdown: "P9" });
    expect(res.commentId).toBe(3);
    expect(api.state.comments[0]?.body).toContain("FAKE");
    expect(api.state.comments[1]?.body).toContain("FAKE");
  });
});
