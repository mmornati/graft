import { describe, expect, it } from "vitest";
import { createGitHubClientFactory } from "../../src/github/client-factory.js";
import {
  checkRunWrite,
  classifyWrite,
  ENABLE_AUTO_MERGE_MUTATION,
  guardBodyAllowed,
  type MutationGate,
  MutationRefusedError,
  mcpBodyAllowed,
} from "../../src/github/mutation-guard.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { TEST_PRIVATE_KEY } from "../helpers/config.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import { makePull, OWNER, REPO } from "../helpers/github-builders.js";

const SHA = "a".repeat(40);
/** Phase 1 step 5 (§12): a ref the guard may create is `graft-revert/<event uuid>`. */
const EVENT = "3f0c1a52-b6d8-4e0f-8a7d-2c4b1e5f6a30";

describe("mutation guard: classification", () => {
  it("U-MG-1 each route of the table classifies as listed; trailing slash and case are handled; a query string is unknown (step 7, D3)", () => {
    const p0 = { kind: "phase0" };
    const rows: [string, string, unknown][] = [
      ["POST", "/app/installations/45/access_tokens", { kind: "auth" }],
      ["POST", "/app/hook/deliveries/7/attempts", { kind: "app" }],
      ["DELETE", "/app/installations/45", { kind: "app" }],
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
        `/repos/o/r/git/refs/heads/graft-revert/${EVENT}`,
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
      // Phase 1 step 7 (D3): a write path with a query is refused on every route.
      expect(classifyWrite(method, `${path}?x=1&y=2`), `${method} ${path}?x`).toEqual({
        kind: "unknown",
      });
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

  it("U-MG-2 dot segments, encoded slashes, empty segments and fragments are unknown", () => {
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
      // Step 5 review 1, finding 1: a fragment is never stripped, it makes the path unknown.
      "/repos/o/r/check-runs#",
      "/repos/o/r/check-runs#x",
      "/repos/o/r/check-runs/1#",
      "/repos/o/r/git/refs#",
      "/repos/o/r/check-runs?x=#",
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
    expect(classifyWrite("DELETE", `/repos/o/r/git/refs/heads/graft-revert/${EVENT}`)).toEqual({
      kind: "phase1",
      features: ["guard"],
      owner: "o",
      repo: "r",
    });
    // Step 5 review 1, nit 9: only `graft-revert/<uuid>`, never a branch a human named.
    for (const name of ["x", "a/b", `${EVENT}/x`, EVENT.toUpperCase()]) {
      expect(classifyWrite("DELETE", `/repos/o/r/git/refs/heads/graft-revert/${name}`)).toEqual({
        kind: "unknown",
      });
    }
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
    c.rest.git.createRef({
      owner: OWNER,
      repo: REPO,
      ref: `refs/heads/graft-revert/${EVENT}`,
      sha: SHA,
    });

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
      .create({
        owner: OWNER,
        repo: REPO,
        name: "x",
        head_sha: SHA,
        status: "completed",
        conclusion: "neutral",
      })
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

  it("U-MG-9b a per-request baseUrl cannot move a write to another host: refused unknown_route, nothing sent", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api, allowAll).forInstallation(1, { feature: "guard" });
    for (const baseUrl of [
      "https://other.host",
      "https://other.host/",
      "https://api.github.com.evil.example",
    ]) {
      expect(
        (
          await refusal(
            client.request("POST /repos/{owner}/{repo}/check-runs", {
              owner: OWNER,
              repo: REPO,
              name: "x",
              head_sha: SHA,
              baseUrl,
            }),
          )
        ).refusal,
        baseUrl,
      ).toBe("unknown_route");
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

  it("U-MG-23 removing an installation passes for the App client only; an installation client is refused", async () => {
    const api = createFakeGitHubApi();
    const factory = fakeGitHubFactory(api, allowAll);
    const installation = await factory.forInstallation(1, { feature: "guard" });
    const e = await refusal(
      installation.request("DELETE /app/installations/{installation_id}", { installation_id: 5 }),
    );
    expect(e.refusal).toBe("unknown_route");
    expect(api.requests).toEqual([]);
    const sent = await factory
      .asApp()
      .request("DELETE /app/installations/{installation_id}", { installation_id: 5 })
      .catch((x: unknown) => x);
    expect(sent).not.toBeInstanceOf(MutationRefusedError);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /app/installations/5",
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
    await client.rest.checks.create({
      owner: OWNER,
      repo: REPO,
      name: "x",
      head_sha: SHA,
      status: "completed",
      conclusion: "neutral",
    });
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

describe("mutation guard: check-run bodies (Phase 1 step 2, D11)", () => {
  type Client = Awaited<ReturnType<ReturnType<typeof fakeGitHubFactory>["forInstallation"]>>;
  const NON_NEUTRAL: Record<string, unknown>[] = [
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "action_required" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { status: "queued" },
  ];
  // GitHub creates a run without a status as `queued`: on a POST these are not neutral, while a
  // PATCH with the same body leaves the stored status and conclusion alone (review 1, finding 2).
  const POST_ONLY_NON_NEUTRAL: Record<string, unknown>[] = [
    {},
    { status: "completed" },
    { conclusion: "neutral" },
    { output: { title: "t", summary: "s" } },
  ];
  const create = (c: Client, body: Record<string, unknown>) =>
    c.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: OWNER,
      repo: REPO,
      head_sha: SHA,
      ...(body as { name: string }),
    });
  const createRest = (c: Client, body: Record<string, unknown>) =>
    c.rest.checks.create({
      owner: OWNER,
      repo: REPO,
      head_sha: SHA,
      ...(body as { name: string }),
    });
  const update = (c: Client, body: Record<string, unknown>) =>
    c.rest.checks.update({ owner: OWNER, repo: REPO, check_run_id: 7, ...body });
  const patchRaw = (c: Client, body: Record<string, unknown>) =>
    c.request(`PATCH /repos/${OWNER}/${REPO}/check-runs/7`, body);
  const checkWrites = (api: ReturnType<typeof createFakeGitHubApi>) =>
    api.requests.filter((r) => r.method !== "GET" && r.path.includes("/check-runs"));
  const countingGate = (verdict: () => Awaited<ReturnType<MutationGate>>) => {
    const asked: unknown[] = [];
    const gate: MutationGate = async (q) => {
      asked.push(q);
      return verdict();
    };
    return { asked, gate };
  };

  it("U-MG-12 a neutral, completed check through the default client passes and never asks the gate", async () => {
    const api = createFakeGitHubApi();
    const factory = fakeGitHubFactory(api, async () => {
      throw new Error("the gate must not be asked");
    });
    const client = await factory.forInstallation(1);
    await createRest(client, { name: "graft/intent", status: "completed", conclusion: "neutral" });
    await createRest(client, { name: "graft/policy", status: "completed", conclusion: "neutral" });
    // No status and no conclusion at all leaves the stored ones alone: still Phase 0.
    await patchRaw(client, {
      name: "graft/provenance",
      output: { title: "t", summary: "s" },
    }).catch(() => undefined);
    for (const body of POST_ONLY_NON_NEUTRAL) {
      await patchRaw(client, { name: "graft/policy", ...body }).catch(() => undefined);
    }
    expect(checkWrites(api)).toHaveLength(3 + POST_ONLY_NON_NEUTRAL.length);
  });

  it("U-MG-13 a non-neutral body through the default client is refused no_feature, for every form of the call", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api, async () => ({ allowed: true })).forInstallation(1);
    for (const body of NON_NEUTRAL) {
      const named = { name: "graft/policy", ...body };
      for (const call of [create, createRest, update, patchRaw]) {
        const e = await refusal(call(client, named));
        expect(e.refusal, JSON.stringify(named)).toBe("no_feature");
      }
      // A body given as `data` is the body Octokit sends: it is read, not the other options.
      const viaData = await refusal(
        client.request("POST /repos/{owner}/{repo}/check-runs", {
          owner: OWNER,
          repo: REPO,
          conclusion: "neutral",
          data: { ...named, head_sha: SHA },
        } as never),
      );
      expect(viaData.refusal).toBe("no_feature");
    }
    // A create that does not say completed + neutral would be queued: refused, in every form.
    for (const body of POST_ONLY_NON_NEUTRAL) {
      const named = { name: "graft/policy", ...body };
      for (const call of [create, createRest]) {
        const e = await refusal(call(client, named));
        expect(e.refusal, `POST ${JSON.stringify(named)}`).toBe("no_feature");
      }
      const viaData = await refusal(
        client.request("POST /repos/{owner}/{repo}/check-runs", {
          owner: OWNER,
          repo: REPO,
          status: "completed",
          conclusion: "neutral",
          data: { ...named, head_sha: SHA },
        } as never),
      );
      expect(viaData.refusal, `POST data ${JSON.stringify(named)}`).toBe("no_feature");
    }
    expect(checkWrites(api)).toEqual([]);
  });

  it("U-MG-14 through a policy client the gate decides: mode_report when it denies, sent when it allows, asked once per request", async () => {
    const api = createFakeGitHubApi();
    let allowed = false;
    const { asked, gate } = countingGate(() =>
      allowed ? { allowed: true } : { allowed: false, reason: "mode_report" },
    );
    const policy = await fakeGitHubFactory(api, gate).forInstallation(1, { feature: "policy" });
    const body = { name: "graft/policy", status: "completed", conclusion: "failure" };
    expect((await refusal(createRest(policy, body))).refusal).toBe("mode_report");
    expect(asked).toEqual([{ installationId: 1, owner: OWNER, repo: REPO, feature: "policy" }]);
    expect(checkWrites(api)).toEqual([]);
    allowed = true;
    await createRest(policy, body);
    await update(policy, { name: "graft/policy", status: "in_progress" }).catch(() => undefined);
    expect(asked).toHaveLength(3);
    expect(checkWrites(api).map((r) => r.body?.conclusion ?? r.body?.status)).toEqual([
      "failure",
      "in_progress",
    ]);
    // A neutral write through the same client never asks.
    await createRest(policy, { name: "graft/policy", status: "completed", conclusion: "neutral" });
    expect(asked).toHaveLength(3);
  });

  it("U-MG-15 a non-neutral body for another check, or with no name, is refused feature_not_allowed", async () => {
    const api = createFakeGitHubApi();
    const { asked, gate } = countingGate(() => ({ allowed: true }));
    const factory = fakeGitHubFactory(api, gate);
    const policy = await factory.forInstallation(1, { feature: "policy" });
    const plain = await factory.forInstallation(1);
    for (const name of ["graft/intent", "graft/provenance", "graft/Policy", "other", undefined]) {
      const body = { ...(name === undefined ? {} : { name }), conclusion: "failure" };
      expect((await refusal(patchRaw(policy, body))).refusal, String(name)).toBe(
        "feature_not_allowed",
      );
      expect((await refusal(patchRaw(plain, body))).refusal, String(name)).toBe(
        "feature_not_allowed",
      );
    }
    expect(asked).toEqual([]);
    expect(checkWrites(api)).toEqual([]);
  });

  it("U-MG-16 a guard or mcp client sending a non-neutral graft/policy check is refused feature_not_allowed", async () => {
    const api = createFakeGitHubApi();
    const { asked, gate } = countingGate(() => ({ allowed: true }));
    const factory = fakeGitHubFactory(api, gate);
    for (const feature of ["guard", "mcp"] as const) {
      const client = await factory.forInstallation(1, { feature });
      const e = await refusal(createRest(client, { name: "graft/policy", conclusion: "success" }));
      expect(e.refusal, feature).toBe("feature_not_allowed");
    }
    expect(asked).toEqual([]);
    expect(checkWrites(api)).toEqual([]);
  });

  it("U-MG-17 the refusal message names the route and says non-neutral, with no body text and no conclusion", async () => {
    const api = createFakeGitHubApi();
    const client = await fakeGitHubFactory(api).forInstallation(1);
    const e = await refusal(
      createRest(client, {
        name: "graft/policy",
        conclusion: "action_required",
        output: { title: "secret-title-zq", summary: "secret-summary-zq" },
      }),
    );
    expect(e.message).toBe(
      "GitHub write refused by the mutation guard: POST /repos/{owner}/{repo}/check-runs (non-neutral check run) (feature none): no_feature",
    );
    for (const s of [
      "secret-title-zq",
      "secret-summary-zq",
      "action_required",
      "graft/policy",
      OWNER,
      REPO,
    ]) {
      expect(e.message).not.toContain(s);
    }
    // A body that cannot be read as an object is refused, never assumed neutral.
    const odd = await refusal(
      client.request("POST /repos/{owner}/{repo}/check-runs", {
        owner: OWNER,
        repo: REPO,
        data: "conclusion=failure",
      } as never),
    );
    expect(odd.refusal).toBe("unknown_route");
    expect(odd.message).not.toContain("conclusion=failure");
  });
});

describe("mutation guard: the guard's revert writes (Phase 1 step 5, §12)", () => {
  type Client = Awaited<ReturnType<ReturnType<typeof fakeGitHubFactory>["forInstallation"]>>;
  const BRANCH = `graft-revert/${EVENT}`;
  const ID = `graft-guard:${OWNER}/${REPO}#501`;
  const writes: [string, (c: Client) => Promise<unknown>][] = [
    [
      "POST git/trees",
      (c) =>
        c.rest.git.createTree({
          owner: OWNER,
          repo: REPO,
          tree: [{ path: "a", mode: "100644", type: "blob", sha: SHA }],
        }),
    ],
    [
      "POST git/commits",
      (c) =>
        c.rest.git.createCommit({
          owner: OWNER,
          repo: REPO,
          message: "m",
          tree: SHA,
          parents: [SHA],
        }),
    ],
    [
      "POST git/refs",
      (c) =>
        c.rest.git.createRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${BRANCH}`, sha: SHA }),
    ],
    [
      "DELETE git/refs",
      (c) =>
        c.request(`DELETE /repos/{owner}/{repo}/git/refs/heads/${BRANCH}`, {
          owner: OWNER,
          repo: REPO,
        }),
    ],
    [
      "POST pulls",
      (c) =>
        c.rest.pulls.create({ owner: OWNER, repo: REPO, head: BRANCH, base: "main", title: "t" }),
    ],
    [
      "POST labels",
      (c) =>
        c.rest.issues.addLabels({
          owner: OWNER,
          repo: REPO,
          issue_number: 501,
          labels: ["graft:revert"],
        }),
    ],
    [
      "POST graphql",
      async (c) => {
        // Finding 7: the node id must be one this client read (a GET, never refused).
        await c.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: 501 }).catch(() => {});
        return c.graphql(ENABLE_AUTO_MERGE_MUTATION, {
          pullRequestId: "PR_x",
          mergeMethod: "SQUASH",
          clientMutationId: ID,
        });
      },
    ],
  ];
  const withPull = (api: ReturnType<typeof createFakeGitHubApi>) => {
    api.state.pulls.set(501, makePull({ number: 501, node_id: "PR_x" }));
    return api;
  };
  const sentCount = (api: ReturnType<typeof createFakeGitHubApi>) =>
    api.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/access_tokens")).length;

  it("U-MG-18 every revert write: sent with a guard client in enforce; mode_report in report; no_feature without a feature; feature_not_allowed for policy", async () => {
    for (const [name, call] of writes) {
      const api = withPull(createFakeGitHubApi());
      let allowed = true;
      const asked: unknown[] = [];
      const gate: MutationGate = async (q) => {
        asked.push(q);
        return allowed ? { allowed: true } : { allowed: false, reason: "mode_report" };
      };
      const factory = fakeGitHubFactory(api, gate);
      const guard = await factory.forInstallation(1, { feature: "guard" });
      const sent = await call(guard).catch((e: unknown) => e);
      expect(sent, name).not.toBeInstanceOf(MutationRefusedError);
      expect(sentCount(api), name).toBe(1);
      expect(asked, name).toEqual([
        { installationId: 1, owner: OWNER, repo: REPO, feature: "guard" },
      ]);
      allowed = false;
      expect((await refusal(call(guard))).refusal, name).toBe("mode_report");
      const plain = await factory.forInstallation(1);
      expect((await refusal(call(plain))).refusal, name).toBe("no_feature");
      const policy = await factory.forInstallation(1, { feature: "policy" });
      expect((await refusal(call(policy))).refusal, name).toBe("feature_not_allowed");
      // The `mcp` feature: refused on every guard-only route (its pulls are step 6's).
      if (name !== "POST pulls") {
        const mcp = await factory.forInstallation(1, { feature: "mcp" });
        expect((await refusal(call(mcp))).refusal, name).toBe("feature_not_allowed");
      }
      expect(sentCount(api), name).toBe(1);
      expect(asked, name).toHaveLength(2);
    }
  });

  it("U-MG-19 GraphQL: only the constant document with a graft-guard id, for a pull request the client created or read in the repository it names", async () => {
    const api = createFakeGitHubApi();
    const asked: { owner: string; repo: string }[] = [];
    const gate: MutationGate = async (q) => {
      asked.push({ owner: q.owner, repo: q.repo });
      return { allowed: true };
    };
    const guard = await fakeGitHubFactory(api, gate).forInstallation(1, { feature: "guard" });
    const vars = { pullRequestId: "PR_x", mergeMethod: "SQUASH", clientMutationId: ID };
    const unknown = [
      () => guard.graphql("query { viewer { login } }"),
      () => guard.graphql(`${ENABLE_AUTO_MERGE_MUTATION} `, vars),
      () =>
        guard.graphql(
          ENABLE_AUTO_MERGE_MUTATION.replace("SQUASH", "MERGE").replace("enable", "disable"),
          vars,
        ),
      () =>
        guard.graphql(ENABLE_AUTO_MERGE_MUTATION, { ...vars, clientMutationId: "graft-guard:o/r" }),
      () => guard.graphql(ENABLE_AUTO_MERGE_MUTATION, { ...vars, clientMutationId: "other:o/r#1" }),
      () =>
        guard.graphql(ENABLE_AUTO_MERGE_MUTATION, {
          ...vars,
          clientMutationId: undefined as never,
        }),
      () =>
        guard.request("POST /graphql", {
          data: { query: ENABLE_AUTO_MERGE_MUTATION, variables: vars, operationName: "x" },
        } as never),
      () =>
        guard.request("POST /graphql", {
          data: { query: [ENABLE_AUTO_MERGE_MUTATION], variables: vars },
        } as never),
    ];
    for (const call of unknown) expect((await refusal(call())).refusal).toBe("unknown_route");
    expect(asked).toEqual([]);
    expect(sentCount(api)).toBe(0);
    // Step 5 review 1, finding 7: the node id must be a pull request this client created or
    // read, with the number and the repository the client mutation id names. Until it is, the
    // write is refused before the gate is asked.
    withPull(api);
    const bound = [
      () =>
        guard.graphql(ENABLE_AUTO_MERGE_MUTATION, {
          ...vars,
          clientMutationId: `graft-guard:${OWNER}/${REPO}#501`,
        }),
    ];
    for (const call of bound) {
      const e = await refusal(call());
      expect(e.refusal).toBe("feature_not_allowed");
      expect(e.route).toContain("(pull request)");
    }
    expect(asked).toEqual([]);
    await guard.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: 501 });
    for (const clientMutationId of [
      `graft-guard:${OWNER}/${REPO}#502`,
      `graft-guard:acme/app#501`,
    ]) {
      const e = await refusal(
        guard.graphql(ENABLE_AUTO_MERGE_MUTATION, { ...vars, clientMutationId }),
      );
      expect(e.refusal, clientMutationId).toBe("feature_not_allowed");
    }
    // Another client never inherits what this one read.
    const other = await fakeGitHubFactory(api, gate).forInstallation(1, { feature: "guard" });
    expect(
      (
        await refusal(
          other.graphql(ENABLE_AUTO_MERGE_MUTATION, {
            ...vars,
            clientMutationId: `graft-guard:${OWNER}/${REPO}#501`,
          }),
        )
      ).refusal,
    ).toBe("feature_not_allowed");
    expect(asked).toEqual([]);
    expect(sentCount(api)).toBe(0);
    // Read, matching number and repository: the gate is asked for that repository, and it is sent.
    const answered = await guard
      .graphql(ENABLE_AUTO_MERGE_MUTATION, {
        ...vars,
        clientMutationId: `graft-guard:${OWNER}/${REPO}#501`,
      })
      .catch((e: unknown) => e);
    expect(answered).not.toBeInstanceOf(MutationRefusedError);
    expect(asked).toEqual([{ owner: OWNER, repo: REPO }]);
    expect(sentCount(api)).toBe(1);
    // A pull request seen through a create or a list binds as well.
    const created = await fakeGitHubFactory(api, gate).forInstallation(1, { feature: "guard" });
    api.state.branches.set(`graft-revert/${EVENT}`, SHA);
    const pr = (
      await created.rest.pulls.create({
        owner: OWNER,
        repo: REPO,
        head: `graft-revert/${EVENT}`,
        base: "main",
        title: "t",
      })
    ).data;
    expect(
      await created
        .graphql(ENABLE_AUTO_MERGE_MUTATION, {
          ...vars,
          pullRequestId: pr.node_id,
          clientMutationId: `graft-guard:${OWNER}/${REPO}#${pr.number}`,
        })
        .catch((e: unknown) => e),
    ).not.toBeInstanceOf(MutationRefusedError);
    expect(sentCount(api)).toBe(3);
    const listed = await fakeGitHubFactory(api, gate).forInstallation(1, { feature: "guard" });
    await listed.rest.pulls.list({ owner: OWNER, repo: REPO, state: "all" });
    expect(
      await listed
        .graphql(ENABLE_AUTO_MERGE_MUTATION, {
          ...vars,
          pullRequestId: pr.node_id,
          clientMutationId: `graft-guard:${OWNER}/${REPO}#${pr.number}`,
        })
        .catch((e: unknown) => e),
    ).not.toBeInstanceOf(MutationRefusedError);
    // GitHub Enterprise Server: …/api/v3 sends GraphQL to …/api/graphql.
    const ghe = await createGitHubClientFactory({
      appId: 12345,
      privateKey: TEST_PRIVATE_KEY,
      baseUrl: "https://ghe.example/api/v3",
      gate,
      fetch: api.fetch,
    }).forInstallation(1, { feature: "mcp" });
    expect((await refusal(ghe.graphql(ENABLE_AUTO_MERGE_MUTATION, vars))).refusal).toBe(
      "feature_not_allowed",
    );
    expect((await refusal(ghe.graphql("query { viewer { login } }"))).refusal).toBe(
      "unknown_route",
    );
  });

  it("U-MG-20 bodies: a ref outside graft-revert/<uuid>, a PR head outside it, a label other than graft:revert; merge and ref updates stay unknown", async () => {
    const api = createFakeGitHubApi();
    const guard = await fakeGitHubFactory(api, async () => ({ allowed: true })).forInstallation(1, {
      feature: "guard",
    });
    for (const ref of [
      "refs/heads/main",
      "refs/heads/graft-revert/x",
      `refs/heads/graft-revert/${EVENT}/x`,
      `refs/tags/graft-revert/${EVENT}`,
      `refs/heads/graft-revert/${EVENT.toUpperCase()}`,
      `refs/heads/feature/graft-revert/${EVENT}`,
    ]) {
      const e = await refusal(
        guard.rest.git.createRef({ owner: OWNER, repo: REPO, ref, sha: SHA }),
      );
      expect(e.refusal, ref).toBe("feature_not_allowed");
      expect(e.message).not.toContain(ref);
    }
    for (const head of ["main", "graft-revert/x", `other:${BRANCH}`, `${BRANCH}x`]) {
      const e = await refusal(
        guard.rest.pulls.create({ owner: OWNER, repo: REPO, head, base: "main", title: "t" }),
      );
      expect(e.refusal, head).toBe("feature_not_allowed");
    }
    // Step 5 review 1, nit 9: the base is a plain branch name.
    for (const base of ["other:main", "", "a b", undefined]) {
      const e = await refusal(
        guard.request("POST /repos/{owner}/{repo}/pulls", {
          owner: OWNER,
          repo: REPO,
          data: { head: BRANCH, base, title: "t" },
        } as never),
      );
      expect(e.refusal, String(base)).toBe("feature_not_allowed");
    }
    // Step 5 review 1, finding 1: a fragment in the route string never reaches a body rule; the
    // write is unknown, whatever its body.
    for (const frag of ["#", "#x"]) {
      for (const call of [
        () =>
          guard.request(`POST /repos/{owner}/{repo}/git/refs${frag}`, {
            owner: OWNER,
            repo: REPO,
            ref: "refs/heads/main2",
            sha: SHA,
          }),
        () =>
          guard.request(`POST /repos/{owner}/{repo}/git/refs${frag}`, {
            owner: OWNER,
            repo: REPO,
            ref: `refs/heads/${BRANCH}`,
            sha: SHA,
          }),
        () =>
          guard.request(`POST /repos/{owner}/{repo}/pulls${frag}`, {
            owner: OWNER,
            repo: REPO,
            head: "main",
            base: "main",
            title: "t",
          }),
        () =>
          guard.request(`POST /repos/{owner}/{repo}/issues/{n}/labels${frag}`, {
            owner: OWNER,
            repo: REPO,
            n: 3,
            labels: ["bug"],
          }),
      ]) {
        expect((await refusal(call())).refusal, frag).toBe("unknown_route");
      }
    }
    // The body rules fail closed: a guard route they do not know is refused, a bodiless one is
    // allowed only by name, and a fragment or an escape is never normalised away.
    expect(guardBodyAllowed("POST", "/repos/o/r/git/trees", {})).toBe(true);
    expect(guardBodyAllowed("POST", "/repos/o/r/git/commits/", {})).toBe(true);
    expect(guardBodyAllowed("DELETE", `/repos/o/r/git/refs/heads/${BRANCH}`, undefined)).toBe(true);
    for (const [method, path] of [
      ["POST", "/repos/o/r/git/blobs"],
      ["POST", "/repos/o/r/check-runs"],
      ["PATCH", "/repos/o/r/pulls/1"],
      ["DELETE", "/repos/o/r/git/refs/heads/main"],
      ["POST", "/repos/o/r/git/trees#"],
      ["POST", "/repos/o/r/git/refs#"],
      ["POST", "/repos/o/r/git/trees%2F"],
    ] as const) {
      expect(guardBodyAllowed(method, path, {}), `${method} ${path}`).toBe(false);
    }
    for (const body of [
      { labels: ["bug"] },
      { labels: ["graft:revert", "bug"] },
      { labels: ["GRAFT:REVERT"] },
      { labels: [] },
      { labels: ["graft:revert"], extra: 1 },
      { labels: "graft:revert" },
    ]) {
      const e = await refusal(
        guard.request("POST /repos/{owner}/{repo}/issues/{n}/labels", {
          owner: OWNER,
          repo: REPO,
          n: 3,
          data: body,
        } as never),
      );
      expect(e.refusal, JSON.stringify(body)).toBe("feature_not_allowed");
    }
    for (const [method, path] of [
      ["PUT", "/repos/o/r/pulls/1/merge"],
      ["PATCH", "/repos/o/r/git/refs/heads/main"],
      ["PATCH", `/repos/o/r/git/refs/heads/graft-revert/${EVENT}`],
      ["PATCH", "/repos/o/r/pulls/1"],
      ["POST", "/repos/o/r/git/blobs"],
    ] as const) {
      expect(classifyWrite(method, path), `${method} ${path}`).toEqual({ kind: "unknown" });
    }
    const merge = await refusal(
      guard.request("PUT /repos/{owner}/{repo}/pulls/{n}/merge", {
        owner: OWNER,
        repo: REPO,
        n: 1,
      }),
    );
    expect(merge.refusal).toBe("unknown_route");
    expect(sentCount(api)).toBe(0);
  });
});

describe("mutation guard: the mcp feature's one write (Phase 1 step 6, §9)", () => {
  type Client = Awaited<ReturnType<ReturnType<typeof fakeGitHubFactory>["forInstallation"]>>;
  const GOOD = {
    title: "Add x",
    body: "Adds x.\n\nGraft-Agent: codex",
    head: "feat/x",
    base: "main",
    draft: false,
    maintainer_can_modify: false,
  };
  const open = (c: Client, body: Record<string, unknown>) =>
    c.request("POST /repos/{owner}/{repo}/pulls", { owner: OWNER, repo: REPO, ...body } as never);
  const setup = (verdict: Awaited<ReturnType<MutationGate>>) => {
    const api = createFakeGitHubApi();
    api.state.branches.set("feat/x", SHA);
    const asked: unknown[] = [];
    const factory = fakeGitHubFactory(api, async (q) => {
      asked.push(q);
      return verdict;
    });
    const sent = () =>
      api.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/access_tokens"));
    return { api, asked, factory, sent };
  };

  it("U-MG-MCP-1 POST …/pulls from an mcp client with a valid body: sent when the gate allows, mode_off when it does not; a bad body never asks the gate", async () => {
    const allowed = setup({ allowed: true });
    const mcp = await allowed.factory.forInstallation(1, { feature: "mcp" });
    await open(mcp, GOOD);
    expect(allowed.sent().map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /repos/${OWNER}/${REPO}/pulls`,
    ]);
    expect(allowed.asked).toEqual([
      { installationId: 1, owner: OWNER, repo: REPO, feature: "mcp" },
    ]);
    // Every key is optional but head and base; `maintainer_can_modify` absent is fine.
    const { maintainer_can_modify: _m, draft: _d, body: _b, ...minimal } = GOOD;
    await open(mcp, { ...minimal, head: "feat/x" }).catch(() => undefined);
    expect(allowed.asked).toHaveLength(2);

    const denied = setup({ allowed: false, reason: "mode_off" });
    const off = await denied.factory.forInstallation(1, { feature: "mcp" });
    expect((await refusal(open(off, GOOD))).refusal).toBe("mode_off");
    expect(denied.sent()).toEqual([]);
    expect(denied.asked).toHaveLength(1);
    expect((await refusal(open(off, { ...GOOD, issue: 5 }))).refusal).toBe("feature_not_allowed");
    expect(denied.asked).toHaveLength(1);
  });

  it("U-MG-MCP-2 refused feature_not_allowed: an issue key, maintainer_can_modify true, an owner: head, a graft-revert/ head, an extra key, a body that is not a plain object", async () => {
    const s = setup({ allowed: true });
    const mcp = await s.factory.forInstallation(1, { feature: "mcp" });
    const bad: Record<string, unknown>[] = [
      { ...GOOD, issue: 5 },
      { ...GOOD, maintainer_can_modify: true },
      { ...GOOD, maintainer_can_modify: "false" },
      { ...GOOD, head: `${OWNER}:feat/x` },
      { ...GOOD, head: `graft-revert/${EVENT}` },
      { ...GOOD, base: "other:main" },
      { ...GOOD, head: "../x" },
      { ...GOOD, labels: ["x"] },
      { ...GOOD, head: undefined },
      { ...GOOD, base: 7 },
    ];
    for (const body of bad) {
      const e = await refusal(open(mcp, body));
      expect([e.refusal, e.route], JSON.stringify(body)).toEqual([
        "feature_not_allowed",
        "/repos/{owner}/{repo}/pulls (body)",
      ]);
    }
    // A raw string body (`data`) is not a plain object.
    const raw = await refusal(
      mcp.request("POST /repos/{owner}/{repo}/pulls", {
        owner: OWNER,
        repo: REPO,
        data: JSON.stringify(GOOD),
      } as never),
    );
    expect(raw.refusal).toBe("feature_not_allowed");
    expect(mcpBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls`, [GOOD])).toBe(false);
    expect(mcpBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls`, null)).toBe(false);
    expect(mcpBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls`, GOOD)).toBe(true);
    expect(mcpBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls#x`, GOOD)).toBe(false);
    expect(s.sent()).toEqual([]);
    expect(s.asked).toEqual([]);
  });

  it("U-MG-MCP-3 the guard body rule is unchanged; a guard client cannot send the mcp body, nor an mcp client the guard's", async () => {
    const s = setup({ allowed: true });
    const guard = await s.factory.forInstallation(1, { feature: "guard" });
    const mcp = await s.factory.forInstallation(1, { feature: "mcp" });
    expect((await refusal(open(guard, GOOD))).refusal).toBe("feature_not_allowed");
    const revert = { head: `graft-revert/${EVENT}`, base: "main", title: "Revert #5" };
    expect((await refusal(open(mcp, revert))).refusal).toBe("feature_not_allowed");
    expect(s.asked).toEqual([]);
    expect(guardBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls`, revert)).toBe(true);
    expect(guardBodyAllowed("POST", `/repos/${OWNER}/${REPO}/pulls`, GOOD)).toBe(false);
    await open(guard, revert).catch(() => undefined);
    expect(s.asked).toEqual([{ installationId: 1, owner: OWNER, repo: REPO, feature: "guard" }]);
  });

  it("U-MG-MCP-4 an mcp client sending POST …/git/refs, …/labels, a comment, a check run or /graphql → feature_not_allowed or unknown_route; no other route exists for mcp", async () => {
    const s = setup({ allowed: true });
    const mcp = await s.factory.forInstallation(1, { feature: "mcp" });
    const refs = await refusal(
      mcp.rest.git.createRef({ owner: OWNER, repo: REPO, ref: "refs/heads/feat/y", sha: SHA }),
    );
    expect(refs.refusal).toBe("feature_not_allowed");
    const labels = await refusal(
      mcp.rest.issues.addLabels({ owner: OWNER, repo: REPO, issue_number: 5, labels: ["x"] }),
    );
    expect(labels.refusal).toBe("feature_not_allowed");
    const graphql = await refusal(mcp.graphql("mutation { x }"));
    expect(graphql.refusal).toBe("unknown_route");
    const merge = await refusal(
      mcp.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
        owner: OWNER,
        repo: REPO,
        pull_number: 5,
      }),
    );
    expect(merge.refusal).toBe("unknown_route");
    const check = await refusal(
      mcp.rest.checks.create({
        owner: OWNER,
        repo: REPO,
        name: "graft/policy",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
      }),
    );
    expect(check.refusal).toBe("feature_not_allowed");
    expect(s.sent()).toEqual([]);
    expect(s.asked).toEqual([]);
    // In the route table, mcp appears on POST …/pulls only.
    for (const [method, path] of [
      ["POST", "/repos/o/r/git/refs"],
      ["POST", "/repos/o/r/git/trees"],
      ["POST", "/repos/o/r/git/commits"],
      ["POST", "/repos/o/r/issues/3/labels"],
      ["DELETE", `/repos/o/r/git/refs/heads/graft-revert/${EVENT}`],
    ] as const) {
      const c = classifyWrite(method, path);
      expect(c.kind === "phase1" && c.features, path).toEqual(["guard"]);
    }
  });
});

describe("mutation guard: writes with a query string (Phase 1 step 7, D3)", () => {
  type Client = Awaited<ReturnType<ReturnType<typeof fakeGitHubFactory>["forInstallation"]>>;
  const BRANCH = `graft-revert/${EVENT}`;
  const P = `/repos/${OWNER}/${REPO}`;
  /** Every write route of the table, each with a body its own rule accepts, and a query. */
  const routes: [string, string, Record<string, unknown>][] = [
    [
      "POST",
      `${P}/check-runs?x=1`,
      { name: "graft/x", head_sha: SHA, status: "completed", conclusion: "neutral" },
    ],
    ["PATCH", `${P}/check-runs/12?x=1`, { status: "completed", conclusion: "neutral" }],
    ["POST", `${P}/issues/3/comments?x=1`, { body: "b" }],
    ["PATCH", `${P}/issues/comments/9?x=1`, { body: "b" }],
    ["POST", `${P}/git/trees?x=1`, { tree: [] }],
    ["POST", `${P}/git/commits?x=1`, { message: "m", tree: SHA, parents: [SHA] }],
    ["POST", `${P}/git/refs?x=1`, { ref: `refs/heads/${BRANCH}`, sha: SHA }],
    ["DELETE", `${P}/git/refs/heads/${BRANCH}?x=1`, {}],
    ["POST", `${P}/pulls?x=1`, { head: BRANCH, base: "main", title: "t" }],
    ["POST", `${P}/issues/3/labels?x=1`, { labels: ["graft:revert"] }],
  ];
  const send = (c: Client, method: string, path: string, body: Record<string, unknown>) =>
    c.request(`${method} ${path}`, { ...body, headers: {} } as never);

  it("U-MG-21 a query on every write route is unknown_route for the default, policy, guard and mcp clients; the step 5 review 2 probe is refused", async () => {
    const api = createFakeGitHubApi();
    const asked: unknown[] = [];
    const gate: MutationGate = async (q) => {
      asked.push(q);
      return { allowed: true };
    };
    const factory = fakeGitHubFactory(api, gate);
    const clients: [string, Client][] = [
      ["default", await factory.forInstallation(1)],
      ["policy", await factory.forInstallation(1, { feature: "policy" })],
      ["guard", await factory.forInstallation(1, { feature: "guard" })],
      ["mcp", await factory.forInstallation(1, { feature: "mcp" })],
    ];
    for (const [name, c] of clients) {
      for (const [method, path, body] of routes) {
        const e = await refusal(send(c, method, path, body));
        expect(e.refusal, `${name} ${method} ${path}`).toBe("unknown_route");
        expect(e.message, path).not.toContain("x=1");
      }
    }
    // The step 5 review 2 probe: a valid guard body, and the query names other branches.
    const guard = clients[2]?.[1] as Client;
    const probe = await refusal(
      guard.request(`POST ${P}/pulls?head=main&base=release`, {
        head: BRANCH,
        base: "main",
        title: "Revert",
      } as never),
    );
    expect(probe.refusal).toBe("unknown_route");
    // The rules read the same path: none of them accepts a query.
    expect(guardBodyAllowed("POST", `${P}/pulls?head=main`, { head: BRANCH, base: "main" })).toBe(
      false,
    );
    expect(
      mcpBodyAllowed("POST", `${P}/pulls?head=main`, { head: "feat/x", base: "main", title: "t" }),
    ).toBe(false);
    expect(checkRunWrite("PATCH", `${P}/check-runs/12?x=1`)).toBeNull();
    // Without the query the same route still classifies.
    expect(classifyWrite("POST", `${P}/pulls`).kind).toBe("phase1");
    const sent = api.requests.filter(
      (r) => r.method !== "GET" && !r.path.endsWith("/access_tokens"),
    );
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("U-MG-22 a GET with a query passes; a guard client's pulls.list by head still records node ids, and its GraphQL write is allowed", async () => {
    const api = createFakeGitHubApi();
    api.state.pulls.set(
      501,
      makePull({ number: 501, node_id: "PR_q", head: { sha: SHA, ref: BRANCH } as never }),
    );
    const factory = fakeGitHubFactory(api, allowAll);
    const guard = await factory.forInstallation(1, { feature: "guard" });
    const listed = await guard.rest.pulls.list({
      owner: OWNER,
      repo: REPO,
      head: `${OWNER}:${BRANCH}`,
      state: "all",
    });
    expect(listed.data.map((p) => p.number)).toEqual([501]);
    expect(classifyWrite("GET", `${P}/pulls?head=x&state=all`)).toEqual({ kind: "read" });
    // The node id was recorded from the listing: the auto-merge write for #501 is allowed.
    const sent = await guard
      .graphql(ENABLE_AUTO_MERGE_MUTATION, {
        pullRequestId: "PR_q",
        mergeMethod: "SQUASH",
        clientMutationId: `graft-guard:${OWNER}/${REPO}#501`,
      })
      .catch((e: unknown) => e);
    expect(sent).not.toBeInstanceOf(MutationRefusedError);
    expect(api.requests.some((r) => r.method === "POST" && r.path === "/graphql")).toBe(true);
  });
});
