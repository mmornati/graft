import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyGitHubError, toJobError } from "../../src/github/errors.js";
import { PermanentJobError, sanitizeError } from "../../src/queue/errors.js";

const http = (status: number, message = "boom", headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { status, response: { headers } });

describe("github error classification", () => {
  it("U-GHE-1 404 and 410 are not_found; 422 is invalid", () => {
    expect(classifyGitHubError(http(404))).toBe("not_found");
    expect(classifyGitHubError(http(410))).toBe("not_found");
    expect(classifyGitHubError(http(422))).toBe("invalid");
  });

  it("U-GHE-2 429 and the 403 rate-limit forms are rate_limited", () => {
    expect(classifyGitHubError(http(429))).toBe("rate_limited");
    expect(classifyGitHubError(http(403, "x", { "x-ratelimit-remaining": "0" }))).toBe(
      "rate_limited",
    );
    expect(classifyGitHubError(http(403, "x", { "retry-after": "60" }))).toBe("rate_limited");
    expect(classifyGitHubError(http(403, "You have exceeded a secondary rate limit"))).toBe(
      "rate_limited",
    );
    expect(classifyGitHubError(http(403, "x", { "X-RateLimit-Remaining": "0" }))).toBe(
      "rate_limited",
    );
  });

  it("U-GHE-3 plain 403 and 401 are forbidden; 5xx and non-HTTP errors are transient", () => {
    expect(classifyGitHubError(http(403))).toBe("forbidden");
    expect(classifyGitHubError(http(403, "x", { "x-ratelimit-remaining": "42" }))).toBe(
      "forbidden",
    );
    expect(classifyGitHubError(http(401))).toBe("forbidden");
    expect(classifyGitHubError(http(502))).toBe("transient");
    expect(classifyGitHubError(new TypeError("fetch failed"))).toBe("transient");
    expect(classifyGitHubError("weird")).toBe("transient");
    expect(classifyGitHubError(undefined)).toBe("transient");
  });

  it("U-GHE-4 toJobError makes PermanentJobError (with reason) for permanent classes, else the original", () => {
    for (const [status, reason] of [
      [404, "not_found"],
      [410, "not_found"],
      [401, "forbidden"],
      [403, "forbidden"],
      [422, "invalid"],
    ] as const) {
      const e = toJobError(http(status), "pulls.get");
      expect(e).toBeInstanceOf(PermanentJobError);
      expect((e as PermanentJobError).reason).toBe(reason);
      expect(e.message).toContain("pulls.get");
    }
    // Retryable classes stay retryable (not a PermanentJobError) but are a new, sanitized error.
    for (const err of [
      http(429),
      http(403, "x", { "retry-after": "1" }),
      http(500),
      new TypeError("fetch failed"),
    ]) {
      const e = toJobError(err, "x");
      expect(e).not.toBe(err);
      expect(e).not.toBeInstanceOf(PermanentJobError);
      expect(e.message).toBe((err as Error).message);
      expect(e.cause).toBeUndefined();
    }
    expect((toJobError(http(500), "x") as unknown as { status: number }).status).toBe(500);
    const perm = new PermanentJobError("m", "repo_mismatch");
    const again = toJobError(perm, "x");
    expect(again).toBeInstanceOf(PermanentJobError);
    expect((again as PermanentJobError).reason).toBe("repo_mismatch");
  });

  it("U-GHE-5 sanitizeError keeps status, method, route, request id and a short message, nothing else", () => {
    const SENTINEL = "RENDERED_CARD_SENTINEL";
    const octokitLike = Object.assign(new Error(`Server error ${"x".repeat(500)}`), {
      name: "HttpError",
      status: 500,
      request: {
        method: "POST",
        url: "https://api.github.com/repos/o/r/check-runs/123456?x=1",
        headers: { authorization: "token ghs_SECRET" },
        body: JSON.stringify({ output: { summary: SENTINEL } }),
      },
      response: {
        headers: { "x-github-request-id": "ABCD:1234", "set-cookie": "c=SECRET" },
        data: { message: SENTINEL },
      },
      cause: new Error(SENTINEL),
    });
    for (const e of [sanitizeError(octokitLike), toJobError(octokitLike, "publish")]) {
      expect(e).not.toBe(octokitLike);
      const text = `${JSON.stringify(e)}\n${e.stack}\n${e.message}\n${inspect(e, { depth: 8 })}`;
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("authorization");
      expect(e.cause).toBeUndefined();
      expect(e.message.length).toBeLessThanOrEqual(210);
      expect(e).toMatchObject({
        name: "HttpError",
        status: 500,
        method: "POST",
        route: "/repos/o/r/check-runs/:n",
        requestId: "ABCD:1234",
      });
    }
    // A permanent error keeps its reason and a sanitized cause.
    const perm = toJobError(Object.assign(octokitLike, { status: 422 }), "publish");
    expect(perm).toBeInstanceOf(PermanentJobError);
    expect((perm as PermanentJobError).reason).toBe("invalid");
    expect(inspect(perm, { depth: 8 })).not.toContain(SENTINEL);
    expect((perm.cause as { route?: string }).route).toBe("/repos/o/r/check-runs/:n");
    // Not an Error at all.
    expect(sanitizeError({ body: SENTINEL }).message).toBe("");
    expect(sanitizeError("x")).toBeInstanceOf(Error);
  });
});
