import { describe, expect, it } from "vitest";
import { classifyGitHubError, toJobError } from "../../src/github/errors.js";
import { PermanentJobError } from "../../src/queue/errors.js";

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
    for (const err of [
      http(429),
      http(403, "x", { "retry-after": "1" }),
      http(500),
      new TypeError("fetch failed"),
    ]) {
      expect(toJobError(err, "x")).toBe(err);
    }
    const perm = new PermanentJobError("m", "repo_mismatch");
    expect(toJobError(perm, "x")).toBe(perm);
  });
});
