import { describe, expect, it } from "vitest";
import { createGitHubClientFactory } from "../../src/github/client-factory.js";
import {
  classifyWrite,
  type MutationGate,
  MutationRefusedError,
} from "../../src/github/mutation-guard.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { TEST_PRIVATE_KEY } from "../helpers/config.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import { OWNER, REPO } from "../helpers/github-builders.js";

const SHA = "a".repeat(40);

describe("mutation guard: classification", () => {
  it("U-MG-1 each route of the table classifies as listed; trailing slash, query string and case are handled", () => {
    const p0 = { kind: "phase0" };
    const rows: [string, string, unknown][] = [
      ["POST", "/app/installations/45/access_tokens", { kind: "auth" }],
      ["POST", "/app/hook/deliveries/7/attempts", { kind: "app" }],
      ["POST", "/repos/o/r/check-runs", p0],
      ["PATCH", "/repos/o/r/check-runs/12", p0],
      ["POST", "/repos/o/r/issues/3/comments", p0],
      ["PATCH", "/repos/o/r/issues/comments/9", p0],
      [
        "POST",
        "/repos/o/r/git/trees",
        { kind: "phase1", features: ["guard"], owner: "o", repo: "r" },
      ],
      [
        "POST",
        "/repos/o/r/git/commits",
        { kind: "phase1", features: ["guard"], owner: "o", repo: "r" },
      ],
      [
        "POST",
        "/repos/o/r/git/refs",
        { kind: "phase1", features: ["guard"], owner: "o", repo: "r" },
      ],
      [
        "DELETE",
        "/repos/o/r/git/refs/heads/graft-revert/x",
        { kind: "phase1", features: ["guard"], owner: "o", repo: "r" },
      ],
      [
        "POST",
        "/repos/o/r/issues/3/labels",
        { kind: "phase1", features: ["guard"], owner: "o", repo: "r" },
      ],
      [
        "POST",
        "/repos/o/r/pulls",
        { kind: "phase1", features: ["guard", "mcp"], owner: "o", repo: "r" },
      ],
    ];
    for (const [method, path, want] of rows) {
      expect(classifyWrite(method, path), `${method} ${path}`).toEqual(want);
      expect(classifyWrite(method, `${path}/`), `${method} ${path}/`).toEqual(want);
      expect(classifyWrite(method, `${path}?x=1&y=2`), `${method} ${path}?x`).toEqual(want);
      expect(classifyWrite(method.toLowerCase(), path), `lower ${method} ${path}`).toEqual(want);
    }
    expect(classifyWrite("get", "/repos/o/r/pulls")).toEqual({ kind: "read" });
    expect(classifyWrite("HEAD", "/anything")).toEqual({ kind: "read" });
    // The method matters: the same path with another method is not on the table.
    expect(classifyWrite("DELETE", "/repos/o/r/check-runs")).toEqual({ kind: "unknown" });
    expect(classifyWrite("PUT", "/repos/o/r/check-runs/1")).toEqual({ kind: "unknown" });
    expect(classifyWrite("POST", "/repos/o/r/check-runs/1")).toEqual({ kind: "unknown" });
    expect(classifyWrite("PATCH", "/repos/o/r/check-runs/abc")).toEqual({ kind: "unknown" });
  });

  it("U-MG-2 dot segments, encoded slashes and empty segments are unknown", () => {
    for (const path of [
      "/repos/o/r/git/refs/../check-runs",
      "/repos/o/r/git/refs/./",
      "/repos/../r/check-runs",
      "/repos/o/./check-runs",
      "/repos/o%2Fx/r/check-runs",
      "/repos/o/r/check-runs%2F1",
      "/repos/o/r/git/refs/heads%2Fgraft-revert%2Fx",
      "/repos//o/r/check-runs",
      "/repos/o//check-runs",
      "//repos/o/r/check-runs",
      "/repos/o/r/check-runs//",
      "repos/o/r/check-runs",
      "/repos/o/r/check-runs/%31",
    ]) {
      expect(classifyWrite("POST", path), path).toEqual({ kind: "unknown" });
      expect(classifyWrite("PATCH", path), path).toEqual({ kind: "unknown" });
      expect(classifyWrite("DELETE", path), path).toEqual({ kind: "unknown" });
    }
  });

  it("U-MG-3 deleting a ref outside heads/graft-revert/ is unknown; inside it is a guard route", () => {
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/heads/main")).toEqual({ kind: "unknown" });
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/heads/graft-revert")).toEqual({
      kind: "unknown",
    });
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/heads/graft-revertx/y")).toEqual({
      kind: "unknown",
    });
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/tags/graft-revert/x")).toEqual({
      kind: "unknown",
    });
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/heads/graft-revert/x")).toEqual({
      kind: "phase1",
      features: ["guard"],
      owner: "o",
      repo: "r",
    });
    expect(classifyWrite("DELETE", "/repos/o/r/git/refs/heads/graft-revert/a/b")).toMatchObject({
      kind: "phase1",
    });
  });

  it("U-MG-4 graphql, merge, branch protection, reviews and review dismissals are unknown", () => {
    for (const [method, path] of [
      ["POST", "/graphql"],
      ["PUT", "/repos/o/r/pulls/1/merge"],
      ["PUT", "/repos/o/r/branches/main/protection"],
      ["POST", "/repos/o/r/pulls/1/reviews"],
      ["PUT", "/repos/o/r/pulls/1/reviews/2/dismissals"],
      ["PATCH", "/repos/o/r/pulls/1"],
      ["PUT", "/repos/o/r/contents/graft.yaml"],
      ["DELETE", "/repos/o/r/issues/comments/1"],
      ["POST", `/repos/o/r/statuses/${SHA}`],
      ["POST", "/repos/o/r/actions/runs/1/rerun"],
    ] as const) {
      expect(classifyWrite(method, path), `${method} ${path}`).toEqual({ kind: "unknown" });
    }
  });
});

const allowAll: MutationGate = async () => ({ allowed: true });

async function refusal(promise: Promise<unknown>): Promise<MutationRefusedError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(MutationRefusedError);
    return e as MutationRefusedError;
  }
  throw new Error("expected the request to be refused");
}

describe("mutation guard: the hook", () => {
  const createRef = (
    c: Awaited<ReturnType<ReturnType<typeof fakeGitHubFactory>["forInstallation"]>>,
  ) =>
    c.rest.git.createRef({ owner: OWNER, repo: REPO, ref: "refs/heads/graft-revert/x", sha: SHA });

  it("U-MG-5 a GHE base URL (…/api/v3) is stripped before the path is matched", async () => {
    const api = createFakeGitHubApi();
    const factory = createGitHubClientFactory({
      appId: 12345,
      privateKey: TEST_PRIVATE_KEY,
      baseUrl: "https://ghe.example/api/v3",
      gate: allowAll,
      fetch: api.fetch,
    });
    const client = await factory.forInstallation(1, { feature: "guard" });
    // A phase 0 write passes the guard: the request goes on to the token call (the fake serves
    // no /api/v3 paths, so it ends there with a 404, which is not a refusal).
    const sent = await client.rest.checks
      .create({ owner: OWNER, repo: REPO, name: "x", head_sha: SHA })
      .catch((e: unknown) => e);
    expect(sent).not.toBeInstanceOf(MutationRefusedError);
    expect(api.requests.map((r) => r.path)).toContain("/api/v3/app/installations/1/access_tokens");
    // A phase 1 write with the wrong feature is refused for the right reason, not "unknown_route".
    const mcp = await factory.forInstallation(1, { feature: "mcp" });
    expect((await refusal(createRef(mcp))).refusal).toBe("feature_not_allowed");
    // An unknown route is still unknown behind the prefix.
    const e = await refusal(
      client.request("PUT /repos/{owner}/{repo}/pulls/{n}/merge", { owner: "o", repo: "r", n: 1 }),
    );
    expect(e.refusal).toBe("unknown_route");
  });

  it("U-MG-6 a refused request sends nothing, and the error holds no body text or expanded names", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api).forInstallation(1);
    const e = await refusal(createRef(client));
    expect(e.refusal).toBe("no_feature");
    expect(api.requests).toEqual([]);
    expect(e).toBeInstanceOf(PermanentJobError);
    expect(e.reason).toBe("mutation_refused");
    expect(e.message).toBe(
      "GitHub write refused by the mutation guard: POST /repos/{owner}/{repo}/git/refs (feature none): no_feature",
    );
    for (const secret of [OWNER, REPO, SHA, "graft-revert", "refs/heads"]) {
      expect(e.message).not.toContain(secret);
    }
    // An unknown route with a literal URL is templated too.
    const unknown = await refusal(
      client.request(`PUT /repos/${OWNER}/${REPO}/pulls/14/merge`, { merge_method: "squash" }),
    );
    expect(unknown.message).toContain("PUT /repos/{owner}/{repo}/pulls/{n}/merge");
    expect(unknown.message).not.toContain(OWNER);
    expect(unknown.message).not.toContain("squash");
    expect(api.requests).toEqual([]);
  });

  it("U-MG-7 the asApp() client refuses a phase 0 route with app_client; reads and tokens still pass", async () => {
    const api = createFakeGitHubApi();
    const app = fakeGitHubFactory(api).asApp();
    const e = await refusal(
      app.rest.checks.create({ owner: OWNER, repo: REPO, name: "x", head_sha: SHA }),
    );
    expect(e.refusal).toBe("app_client");
    expect(api.requests).toEqual([]);
    // Phase 1 routes have no installation to ask the gate about.
    expect((await refusal(createRef(app as never))).refusal).toBe("app_client");
    // A read goes through (the fake answers 404, which is not a refusal).
    await app.request("GET /app/installations/{id}", { id: 1 }).catch(() => undefined);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /app/installations/1"]);
  });

  it("U-MG-9 a write to another host is refused unknown_route and sends nothing, even for a phase 0 route", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api, allowAll).forInstallation(1, { feature: "guard" });
    for (const url of [
      "POST https://other.host/repos/o/r/check-runs",
      "POST https://api.github.com.evil.example/repos/o/r/check-runs",
    ]) {
      expect((await refusal(client.request(url, { name: "x" }))).refusal, url).toBe(
        "unknown_route",
      );
    }
    expect(api.requests).toEqual([]);
  });

  it("U-MG-10 the redelivery route passes for the App client only; an installation client is refused", async () => {
    const api = createFakeGitHubApi();
    const factory = fakeGitHubFactory(api, allowAll);
    const installation = await factory.forInstallation(1, { feature: "guard" });
    const e = await refusal(
      installation.request("POST /app/hook/deliveries/{id}/attempts", { id: 5 }),
    );
    expect(e.refusal).toBe("unknown_route");
    expect(api.requests).toEqual([]);
    const sent = await factory
      .asApp()
      .request("POST /app/hook/deliveries/{id}/attempts", { id: 5 })
      .catch((x: unknown) => x);
    expect(sent).not.toBeInstanceOf(MutationRefusedError);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /app/hook/deliveries/5/attempts",
    ]);
  });

  it("U-MG-11 a refused literal URL logs no branch or label name", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api).forInstallation(1);
    const e = await refusal(
      client.request(`DELETE /repos/${OWNER}/${REPO}/git/refs/heads/secret-branch-name`),
    );
    expect(e.message).toContain("DELETE /repos/{owner}/{repo}/git/refs/heads/{x}");
    expect(e.message).not.toContain("secret-branch-name");
  });

  it("U-MG-8 a phase 1 route with a feature client: the gate's reason when it denies, sent when it allows", async () => {
    const api = createFakeGitHubApi();
    const asked: unknown[] = [];
    let verdict: Awaited<ReturnType<MutationGate>> = { allowed: false, reason: "mode_report" };
    const gate: MutationGate = async (q) => {
      asked.push(q);
      return verdict;
    };
    const factory = fakeGitHubFactory(api, gate);

    const guard = await factory.forInstallation(1, { feature: "guard" });
    expect((await refusal(createRef(guard))).refusal).toBe("mode_report");
    expect(asked).toEqual([{ installationId: 1, owner: OWNER, repo: REPO, feature: "guard" }]);
    expect(api.requests).toEqual([]);

    // The route allows the guard and mcp features for pulls, but not mcp for refs.
    const mcp = await factory.forInstallation(1, { feature: "mcp" });
    expect((await refusal(createRef(mcp))).refusal).toBe("feature_not_allowed");
    expect(asked).toHaveLength(1);

    verdict = { allowed: true };
    await createRef(guard).catch(() => undefined);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      `POST /repos/${OWNER}/${REPO}/git/refs`,
    );
    // The default client still cannot make it, whatever the gate says.
    const plain = await factory.forInstallation(1);
    expect((await refusal(createRef(plain))).refusal).toBe("no_feature");
    expect(asked).toHaveLength(2);
  });

  it("phase 0 writes never ask the gate", async () => {
    const api = createFakeGitHubApi();
    const factory = fakeGitHubFactory(api, async () => {
      throw new Error("the gate must not be asked");
    });
    const client = await factory.forInstallation(1);
    await client.rest.checks.create({ owner: OWNER, repo: REPO, name: "x", head_sha: SHA });
    await client.rest.issues.createComment({
      owner: OWNER,
      repo: REPO,
      issue_number: 2,
      body: "b",
    });
    expect(api.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(
      expect.arrayContaining([`/repos/${OWNER}/${REPO}/check-runs`]),
    );
  });
});
