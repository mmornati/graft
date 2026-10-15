import { describe, expect, it } from "vitest";
import { buildClients } from "../../src/e2e/clients.js";
import {
  assertMarker,
  checkRequest,
  GuardRefusal,
  isProtected,
  PROTECTED_REPOS,
  parseSandboxConfig,
  pickSandbox,
  refDeletableForRun,
  SandboxConfigError,
} from "../../src/e2e/guard.js";
import { Abort, openSession } from "../../src/e2e/preflight.js";
import { SecretRegistry } from "../../src/e2e/secrets.js";
import type { E2eDeps } from "../../src/e2e/types.js";
import { testConfig } from "../helpers/config.js";

const RUN = "e2e-20261015-abcdef";
const config = parseSandboxConfig(
  JSON.stringify({
    version: 1,
    sandboxes: [
      {
        repo: "mmornati/graft-sandbox",
        source: "mmornati/ai-running-coach",
        visibility: "private",
        defaultBranch: "main",
      },
    ],
  }),
);
const sandbox = config.sandboxes[0] as (typeof config.sandboxes)[number];

describe("sandbox guard", () => {
  it("U-LIVE-GUARD-1 a sandbox equal to its source, to mmornati/ai-running-coach (any case) or missing from the JSON is refused", () => {
    const entry = (repo: string, source = "mmornati/ai-running-coach") => ({
      repo,
      source,
      visibility: "private",
      defaultBranch: "main",
    });
    const text = (e: unknown) => JSON.stringify({ version: 1, sandboxes: [e] });
    expect(() => parseSandboxConfig(text(entry("mmornati/ai-running-coach")))).toThrow(
      SandboxConfigError,
    );
    expect(() => parseSandboxConfig(text(entry("MMornati/AI-Running-Coach")))).toThrow(
      SandboxConfigError,
    );
    expect(() => parseSandboxConfig(text(entry("someone/else", "someone/else")))).toThrow(
      SandboxConfigError,
    );
    expect(() => parseSandboxConfig(text(entry("other/other-repo", "other/other-repo")))).toThrow(
      SandboxConfigError,
    );
    expect(() => parseSandboxConfig("{not json")).toThrow(SandboxConfigError);
    expect(() => parseSandboxConfig(JSON.stringify({ version: 2, sandboxes: [] }))).toThrow(
      SandboxConfigError,
    );
    // The committed file is valid and lists exactly the sandbox.
    expect(pickSandbox(config, undefined).repo).toBe("mmornati/graft-sandbox");
    expect(pickSandbox(config, "MMORNATI/graft-sandbox").repo).toBe("mmornati/graft-sandbox");
    // Not listed in the JSON, or a protected repository, passed as --sandbox.
    expect(() => pickSandbox(config, "mmornati/other")).toThrow(GuardRefusal);
    expect(() => pickSandbox(config, "mmornati/ai-running-coach")).toThrow(GuardRefusal);
    expect(isProtected("MMORNATI/AI-RUNNING-COACH")).toBe(true);
    expect(PROTECTED_REPOS).toContain("mmornati/ai-running-coach");
  });

  it("U-LIVE-GUARD-1 a repository without the marker, or with a marker naming another repository, is refused", () => {
    const good = JSON.stringify({ graftE2eSandbox: 1, repo: "mmornati/graft-sandbox" });
    expect(() => assertMarker(good, sandbox)).not.toThrow();
    expect(() => assertMarker(null, sandbox)).toThrow(GuardRefusal);
    expect(() => assertMarker("not json", sandbox)).toThrow(GuardRefusal);
    expect(() =>
      assertMarker(JSON.stringify({ graftE2eSandbox: 1, repo: "mmornati/other" }), sandbox),
    ).toThrow(GuardRefusal);
    expect(() => assertMarker(JSON.stringify({ repo: "mmornati/graft-sandbox" }), sandbox)).toThrow(
      GuardRefusal,
    );
  });
});

function harness(
  over: {
    allowCreate?: boolean;
    prIds?: string[];
    outsiderLogin?: string;
    forkVerified?: boolean;
    visibility?: "private" | "public";
  } = {},
) {
  const seen: { method: string; url: string }[] = [];
  const fetchFn = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ method: (init?.method ?? "GET").toUpperCase(), url });
    const res = new Response(
      JSON.stringify({
        number: 1,
        id: 1,
        data: { markPullRequestReadyForReview: { pullRequest: { id: "x" } } },
        ref: "r",
        object: { sha: "a" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  const clients = buildClients({
    config: testConfig(),
    fetch: fetchFn,
    actorToken: "ghp_actor0123456789abcdefghijABCD",
    outsiderToken: "ghp_outsider0123456789abcdefghijAB",
    secrets: new SecretRegistry(),
    now: () => 0,
    sleep: async () => undefined,
    mutationSpacingMs: 0,
    maxRequests: 100,
    guard: {
      sandbox: "mmornati/graft-sandbox",
      visibility: over.visibility ?? "private",
      config,
      canDeleteRef: refDeletableForRun(RUN),
      isRunPullRequestId: (id) => (over.prIds ?? ["PR_known"]).includes(id),
      allowCreateRepo: () => over.allowCreate === true,
      outsiderLogin: over.outsiderLogin,
      forkVerified: () => over.forkVerified === true,
    },
  });
  return { clients, seen };
}

describe("write hook", () => {
  it("U-LIVE-GUARD-2 refused writes throw before anything reaches the fetch; allowed routes pass; the probe client refuses every write", async () => {
    const { clients, seen } = harness();
    const a = clients.actor;
    const refused: [string, () => Promise<unknown>][] = [
      [
        "POST to the source",
        () => a.rest.issues.create({ owner: "mmornati", repo: "ai-running-coach", title: "x" }),
      ],
      [
        "POST to the source, any case",
        () => a.rest.issues.create({ owner: "MMornati", repo: "AI-Running-Coach", title: "x" }),
      ],
      [
        "PUT to the source",
        () =>
          a.rest.repos.addCollaborator({
            owner: "mmornati",
            repo: "ai-running-coach",
            username: "u",
          }),
      ],
      [
        "POST to another repo",
        () => a.rest.issues.create({ owner: "mmornati", repo: "other", title: "x" }),
      ],
      [
        "DELETE the sandbox",
        () => a.rest.repos.delete({ owner: "mmornati", repo: "graft-sandbox" }),
      ],
      [
        "DELETE the source",
        () => a.rest.repos.delete({ owner: "mmornati", repo: "ai-running-coach" }),
      ],
      [
        "delete main",
        () => a.rest.git.deleteRef({ owner: "mmornati", repo: "graft-sandbox", ref: "heads/main" }),
      ],
      [
        "delete another run's branch",
        () =>
          a.rest.git.deleteRef({
            owner: "mmornati",
            repo: "graft-sandbox",
            ref: "heads/graft-e2e/e2e-20261015-zzzzzz/s01",
          }),
      ],
      [
        "delete a branch without the prefix",
        () =>
          a.rest.git.deleteRef({
            owner: "mmornati",
            repo: "graft-sandbox",
            ref: "heads/graft-e2e/s01",
          }),
      ],
      [
        "POST /user/repos outside setup",
        () => a.rest.repos.createForAuthenticatedUser({ name: "graft-sandbox", private: true }),
      ],
      [
        "a GraphQL mutation that deletes",
        () =>
          a.graphql(
            "mutation($pullRequestId: ID) { closePullRequest(input: {pullRequestId: $pullRequestId}) { clientMutationId } }",
            { pullRequestId: "PR_known" },
          ),
      ],
      [
        "markReady with an unknown PR id",
        () =>
          a.graphql(
            "mutation($pullRequestId: ID) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } }",
            { pullRequestId: "PR_other" },
          ),
      ],
      [
        "markReady plus a second mutation",
        () =>
          a.graphql(
            "mutation($pullRequestId: ID) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } closePullRequest(input: {pullRequestId: $pullRequestId}) { clientMutationId } }",
            { pullRequestId: "PR_known" },
          ),
      ],
      [
        "the outsider outside the allowed routes",
        () =>
          clients.outsider?.rest.repos.addCollaborator({
            owner: "mmornati",
            repo: "graft-sandbox",
            username: "x",
          }) as Promise<unknown>,
      ],
      [
        "the outsider on the source",
        () =>
          clients.outsider?.rest.issues.create({
            owner: "mmornati",
            repo: "ai-running-coach",
            title: "x",
          }) as Promise<unknown>,
      ],
      [
        "the app client creating an issue",
        () =>
          clients.app.request("POST /repos/{owner}/{repo}/issues", {
            owner: "mmornati",
            repo: "graft-sandbox",
            title: "x",
          }),
      ],
    ];
    for (const [name, fn] of refused) {
      const err = await fn().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(GuardRefusal);
    }
    expect(seen).toEqual([]);

    // Allowed routes pass.
    await a.rest.issues.create({ owner: "mmornati", repo: "graft-sandbox", title: "x" });
    await a.rest.git.deleteRef({
      owner: "mmornati",
      repo: "graft-sandbox",
      ref: `heads/graft-e2e/${RUN}/s01`,
    });
    await a.graphql(
      "mutation($pullRequestId: ID) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } }",
      { pullRequestId: "PR_known" },
    );
    await clients.outsider?.rest.reactions.createForIssueComment({
      owner: "mmornati",
      repo: "graft-sandbox",
      comment_id: 1,
      content: "+1",
    });
    await a.rest.pulls.get({ owner: "mmornati", repo: "ai-running-coach", pull_number: 1 }); // GET anywhere
    expect(seen.map((s) => s.method)).toEqual(["POST", "DELETE", "POST", "POST", "GET"]);
  });

  it("U-LIVE-GUARD-2 POST /user/repos passes only inside setup --create --yes, for the sandbox name and visibility", async () => {
    const closed = harness({ allowCreate: false });
    expect(
      await closed.clients.actor.rest.repos
        .createForAuthenticatedUser({ name: "graft-sandbox", private: true })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
    const open = harness({ allowCreate: true });
    await open.clients.actor.rest.repos.createForAuthenticatedUser({
      name: "graft-sandbox",
      private: true,
    });
    expect(open.seen).toHaveLength(1);
    expect(
      await open.clients.actor.rest.repos
        .createForAuthenticatedUser({ name: "something-else", private: true })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
    expect(
      await open.clients.actor.rest.repos
        .createForAuthenticatedUser({ name: "graft-sandbox", private: false })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
  });

  it("U-LIVE-GUARD-2 the fork of the outsider is writable only in public mode after its parent was verified", async () => {
    const before = harness({
      visibility: "public",
      outsiderLogin: "outsider",
      forkVerified: false,
    });
    expect(
      await before.clients.outsider?.rest.git
        .createRef({
          owner: "outsider",
          repo: "graft-sandbox",
          ref: `refs/heads/graft-e2e/${RUN}/s08`,
          sha: "a",
        })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
    const after = harness({ visibility: "public", outsiderLogin: "outsider", forkVerified: true });
    await after.clients.outsider?.rest.git.createRef({
      owner: "outsider",
      repo: "graft-sandbox",
      ref: `refs/heads/graft-e2e/${RUN}/s08`,
      sha: "a",
    });
    expect(after.seen).toHaveLength(1);
    expect(
      await after.clients.outsider?.rest.git
        .createRef({ owner: "outsider", repo: "other-repo", ref: "refs/heads/x", sha: "a" })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
    // In private mode the outsider has no fork routes.
    const priv = harness({ visibility: "private", outsiderLogin: "outsider", forkVerified: true });
    expect(
      await priv.clients.outsider?.rest.git
        .createRef({ owner: "outsider", repo: "graft-sandbox", ref: "refs/heads/x", sha: "a" })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(GuardRefusal);
  });
});

function sessionDeps(
  over: Partial<E2eDeps> & { dotenv?: Record<string, string> | null } = {},
): E2eDeps {
  return {
    loadConfig: () => testConfig(),
    env: { GRAFT_E2E_ACTOR_TOKEN: "ghp_ACTORsecret0123456789abcdefABCD" },
    readDotEnv: () => over.dotenv ?? null,
    openReadOnlyDb: () => {
      throw new Error("the database must not be opened before the .env check");
    },
    ops: async () => ({ code: 0, out: "", err: "" }),
    readyz: async () => true,
    now: () => new Date("2026-10-15T10:00:00Z"),
    sleep: async () => undefined,
    prompt: async () => "",
    spawn: async () => ({ code: 1, stdout: "", stderr: "" }),
    outDir: "/nonexistent-e2e-runs",
    isTty: false,
    rootDir: new URL("../../", import.meta.url).pathname,
    fetch: (async () => {
      throw new Error("no network before the .env check");
    }) as typeof fetch,
    ...over,
  } as E2eDeps;
}

describe(".env hygiene", () => {
  it("U-LIVE-GUARD-3 a GRAFT_E2E_ key, or an actor token as any value, aborts with exit 3 naming the variable and never the value", async () => {
    const io = { out: () => undefined, err: () => undefined };
    const token = "ghp_ACTORsecret0123456789abcdefABCD";
    const cases: { dotenv: Record<string, string>; names: string }[] = [
      { dotenv: { GRAFT_E2E_ACTOR_TOKEN: "something" }, names: "GRAFT_E2E_ACTOR_TOKEN" },
      { dotenv: { GRAFT_E2E_ANYTHING: "1" }, names: "GRAFT_E2E_ANYTHING" },
      { dotenv: { SOME_OTHER_KEY: token }, names: "SOME_OTHER_KEY" },
    ];
    for (const c of cases) {
      const err = await openSession(sessionDeps({ dotenv: c.dotenv }), io, {
        command: "run",
        confirm: "mmornati/graft-sandbox",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Abort);
      expect((err as Abort).code).toBe(3);
      expect((err as Abort).line).toContain("env_tokens");
      expect((err as Abort).line).toContain(c.names);
      expect((err as Abort).line).not.toContain(token);
      expect((err as Abort).line).not.toContain("something");
    }
  });
});

describe("probe client", () => {
  it("U-LIVE-GUARD-2 the probe client refuses every non-GET, and the app client only redelivers webhooks", () => {
    const ctx = {
      sandbox: "mmornati/graft-sandbox",
      visibility: "private" as const,
      config,
      canDeleteRef: refDeletableForRun(RUN),
      isRunPullRequestId: () => true,
      allowCreateRepo: () => true,
      forkVerified: () => true,
    };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const p of [
        "/repos/mmornati/graft-sandbox/issues",
        "/repos/other/repo/issues",
        "/graphql",
        "/user/repos",
      ]) {
        expect(() => checkRequest("probe", { method, path: p }, ctx), `${method} ${p}`).toThrow(
          GuardRefusal,
        );
      }
    }
    expect(() =>
      checkRequest("probe", { method: "GET", path: "/repos/mmornati/ai-running-coach/pulls" }, ctx),
    ).not.toThrow();
    expect(() =>
      checkRequest("app", { method: "POST", path: "/app/hook/deliveries/12/attempts" }, ctx),
    ).not.toThrow();
    expect(() =>
      checkRequest("app", { method: "POST", path: "/repos/mmornati/graft-sandbox/issues" }, ctx),
    ).toThrow(GuardRefusal);
    expect(() =>
      checkRequest("app", { method: "DELETE", path: "/app/hook/deliveries/12/attempts" }, ctx),
    ).toThrow(GuardRefusal);
  });
});

describe("installation scope", () => {
  const sandboxRef = { repo: "mmornati/graft-sandbox", repositoryId: 500 };
  const only = [{ id: 500, full_name: "mmornati/graft-sandbox" }];

  it("U-LIVE-GUARD-4 the App must be on selected repositories and list exactly the sandbox (id and name)", async () => {
    const { scopeProblems } = await import("../../src/e2e/scope.js");
    const codes = (selection: string, repos: { id: number; full_name: string }[]) =>
      scopeProblems(
        { repositorySelection: selection, repositories: repos },
        sandboxRef,
        config,
      ).map((p) => p.code);
    expect(codes("selected", only)).toEqual([]);
    expect(codes("all", only)).toEqual(["selection"]);
    expect(codes("selected", [...only, { id: 7, full_name: "mmornati/ai-running-coach" }])).toEqual(
      ["protected", "extra_repository"],
    );
    expect(codes("selected", [...only, { id: 8, full_name: "mmornati/other" }])).toEqual([
      "extra_repository",
    ]);
    // The name alone is not enough: a different id with the sandbox's name is another repository.
    expect(codes("selected", [{ id: 501, full_name: "mmornati/graft-sandbox" }])).toEqual([
      "sandbox_missing",
      "extra_repository",
    ]);
    expect(codes("selected", [{ id: 500, full_name: "mmornati/renamed" }])).toEqual([
      "sandbox_missing",
      "extra_repository",
    ]);
    expect(codes("selected", [])).toEqual(["sandbox_missing"]);
  });

  it("U-LIVE-GUARD-4 s10 ignores a delivery of another repository or installation with the same PR number", async () => {
    const { findPrDelivery } = await import("../../src/e2e/hooks.js");
    const deliveries: {
      id: number;
      repo: number;
      payloadRepo?: number;
      inst: number;
      number: number;
    }[] = [
      { id: 40, repo: 500, payloadRepo: 999, inst: 1, number: 2 },
      { id: 30, repo: 999, inst: 1, number: 2 },
      { id: 20, repo: 500, inst: 2, number: 2 },
      { id: 10, repo: 500, inst: 1, number: 2 },
    ];
    const app = {
      rest: {
        apps: {
          listWebhookDeliveries: async () => ({
            headers: {},
            data: deliveries.map((d) => ({
              id: d.id,
              guid: `g${d.id}`,
              delivered_at: "2026-10-15T10:00:00Z",
              redelivery: false,
              status_code: 202,
              event: "pull_request",
              action: "opened",
              installation_id: d.inst,
              repository_id: d.repo,
            })),
          }),
          getWebhookDelivery: async ({ delivery_id }: { delivery_id: number }) => {
            const d = deliveries.find((x) => x.id === delivery_id) as (typeof deliveries)[number];
            return {
              data: {
                request: {
                  payload: {
                    pull_request: { number: d.number },
                    repository: { id: d.payloadRepo ?? d.repo },
                    installation: { id: d.inst },
                  },
                },
              },
            };
          },
        },
      },
    };
    const found = await findPrDelivery(app as never, {
      event: "pull_request",
      action: "opened",
      installationId: 1,
      repositoryId: 500,
      prNumber: 2,
      redelivery: false,
    });
    expect(found?.id).toBe(10);
    // A payload whose repository differs from what the list claims is ignored too.
    deliveries[3] = { id: 10, repo: 500, inst: 1, number: 3 };
    expect(
      await findPrDelivery(app as never, {
        event: "pull_request",
        action: "opened",
        installationId: 1,
        repositoryId: 500,
        prNumber: 2,
        redelivery: false,
      }),
    ).toBeNull();
  });
});

describe("narrowed routes and redirects", () => {
  const ctx = (visibility: "private" | "public" = "private") => ({
    sandbox: "mmornati/graft-sandbox",
    visibility,
    config,
    canDeleteRef: refDeletableForRun(RUN),
    isRunPullRequestId: () => true,
    allowCreateRepo: () => false,
    installationId: 777,
    outsiderLogin: "outsider",
    forkVerified: () => true,
  });
  const sb = "/repos/mmornati/graft-sandbox";

  it("U-LIVE-GUARD-5 the actor cannot change or transfer the repository itself", () => {
    for (const [method, p] of [
      ["PATCH", sb],
      ["PUT", sb],
      ["POST", `${sb}/transfer`],
    ] as const) {
      expect(() => checkRequest("actor", { method, path: p }, ctx()), `${method} ${p}`).toThrow(
        GuardRefusal,
      );
    }
    expect(() =>
      checkRequest("actor", { method: "PUT", path: `${sb}/actions/permissions` }, ctx()),
    ).not.toThrow();
    expect(() =>
      checkRequest("actor", { method: "PATCH", path: `${sb}/pulls/4` }, ctx()),
    ).not.toThrow();
  });

  it("U-LIVE-GUARD-5 the outsider may only do what its plan does", () => {
    const run = `refs/heads/graft-e2e/${RUN}/s08`;
    const ok: [string, string, unknown?][] = [
      ["POST", `${sb}/issues/comments/9/reactions`],
      ["POST", `${sb}/pulls`],
      ["POST", `${sb}/pulls/8/requested_reviewers`],
      ["POST", `${sb}/git/blobs`],
      ["POST", `${sb}/git/trees`],
      ["POST", `${sb}/git/commits`],
      ["POST", `${sb}/git/refs`, { ref: run }],
      ["PATCH", `${sb}/git/refs/heads/graft-e2e/${RUN}/s08`],
    ];
    for (const [method, p, body] of ok) {
      expect(
        () => checkRequest("outsider", { method, path: p, body }, ctx()),
        `${method} ${p}`,
      ).not.toThrow();
    }
    const refused: [string, string, unknown?][] = [
      ["PUT", `${sb}/pulls/8/merge`],
      ["PATCH", `${sb}/pulls/8`],
      ["POST", `${sb}/pulls/8/reviews`],
      ["PATCH", `${sb}/git/refs/heads/main`],
      ["POST", `${sb}/git/refs`, { ref: "refs/heads/main" }],
      ["POST", `${sb}/git/refs`, { ref: "refs/heads/graft-e2e/other" }],
      ["DELETE", `${sb}/git/refs/heads/main`],
      ["PUT", `${sb}/contents/graft.yaml`],
      ["POST", `${sb}/issues`],
      ["PATCH", sb],
    ];
    for (const [method, p, body] of refused) {
      expect(
        () => checkRequest("outsider", { method, path: p, body }, ctx()),
        `${method} ${p}`,
      ).toThrow(GuardRefusal);
    }
    // Public mode: the sandbox only takes reactions, pull requests and the fork; the fork takes git data.
    const pub = ctx("public");
    expect(() =>
      checkRequest("outsider", { method: "POST", path: `${sb}/forks` }, pub),
    ).not.toThrow();
    expect(() =>
      checkRequest("outsider", { method: "POST", path: `${sb}/git/refs`, body: { ref: run } }, pub),
    ).toThrow(GuardRefusal);
    const fork = "/repos/outsider/graft-sandbox";
    expect(() =>
      checkRequest(
        "outsider",
        { method: "POST", path: `${fork}/git/refs`, body: { ref: run } },
        pub,
      ),
    ).not.toThrow();
    expect(() =>
      checkRequest("outsider", { method: "POST", path: `${fork}/merge-upstream` }, pub),
    ).not.toThrow();
    expect(() =>
      checkRequest("outsider", { method: "PUT", path: `${fork}/contents/x` }, pub),
    ).toThrow(GuardRefusal);
  });

  it("U-LIVE-GUARD-5 installation tokens are minted only by the app and probe clients, for the run's installation", () => {
    const mint = (id: number) => `/app/installations/${id}/access_tokens`;
    expect(() => checkRequest("app", { method: "POST", path: mint(777) }, ctx())).not.toThrow();
    expect(() => checkRequest("probe", { method: "POST", path: mint(777) }, ctx())).not.toThrow();
    expect(() => checkRequest("probe", { method: "POST", path: mint(778) }, ctx())).toThrow(
      GuardRefusal,
    );
    // Before the installation is known (setup, cleanup) nothing is minted.
    expect(() =>
      checkRequest(
        "probe",
        { method: "POST", path: mint(777) },
        { ...ctx(), installationId: undefined },
      ),
    ).toThrow(GuardRefusal);
    expect(() => checkRequest("actor", { method: "POST", path: mint(777) }, ctx())).toThrow(
      GuardRefusal,
    );
    expect(() => checkRequest("outsider", { method: "POST", path: mint(777) }, ctx())).toThrow(
      GuardRefusal,
    );
  });

  it("U-LIVE-GUARD-5 a redirect of a write is never followed and is refused", async () => {
    const sent: { method: string; redirect: unknown }[] = [];
    const clients = buildClients({
      config: testConfig(),
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent.push({ method: String(init?.method), redirect: init?.redirect });
        const res = new Response(null, {
          status: 307,
          headers: { location: "https://api.github.com/repos/mmornati/ai-running-coach/issues" },
        });
        Object.defineProperty(res, "url", { value: "https://api.github.com/x" });
        return res;
      }) as typeof fetch,
      actorToken: "ghp_actor0123456789abcdefghijABCD",
      secrets: new SecretRegistry(),
      now: () => 0,
      sleep: async () => undefined,
      mutationSpacingMs: 0,
      maxRequests: 10,
      guard: {
        sandbox: "mmornati/graft-sandbox",
        visibility: "private",
        config,
        canDeleteRef: refDeletableForRun(RUN),
        isRunPullRequestId: () => true,
        allowCreateRepo: () => false,
        forkVerified: () => false,
      },
    });
    const err = await clients.actor.rest.issues
      .create({ owner: "mmornati", repo: "graft-sandbox", title: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(String((err as Error).message)).toContain("redirect");
    expect(sent).toEqual([{ method: "POST", redirect: "manual" }]);
  });
});
