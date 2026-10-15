import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { clearPolicyCache, loadBasePolicy, resolveBaseCommit } from "../../src/policy/load.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  type FakeContent,
  fakeSha,
  INSTALLATION_ID,
  OWNER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";

const C1 = fakeSha(0xc1);
const C2 = fakeSha(0xc2);
const POLICY = [
  "version: 1",
  "sensitive_paths: ['secret-glob-marker/**']",
  "rules:",
  "  - name: secret-rule-name-marker",
  "    match: { paths: ['x/**'] }",
  "    require: { team: secret-team-marker }",
  "",
].join("\n");

let api: FakeGitHubApi;
const client = () => fakeGitHubFactory(api).forInstallation(INSTALLATION_ID);
const put = (ref: string, entry: FakeContent, path = "graft.yaml") => {
  const byPath = api.state.contents.get(ref) ?? new Map<string, FakeContent>();
  byPath.set(path, entry);
  api.state.contents.set(ref, byPath);
};
const target = (commitSha = C1, log?: ReturnType<typeof createLogger>) => ({
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  commitSha,
  ...(log ? { log } : {}),
});
const contentRequests = () => api.requests.filter((r) => r.path.includes("/contents/"));

beforeEach(() => {
  clearPolicyCache();
  api = createFakeGitHubApi();
});

describe("policy loader", () => {
  it("U-LOAD-1 a 404 is missing; a file is ok, read at exactly the commit given", async () => {
    const octokit = await client();
    expect(await loadBasePolicy(octokit, target(C2))).toEqual({
      status: "missing",
      commitSha: C2,
      fileSha: null,
    });
    put(C1, { kind: "file", text: POLICY });
    const loaded = await loadBasePolicy(octokit, target(C1));
    expect(loaded).toMatchObject({ status: "ok", commitSha: C1 });
    if (loaded.status !== "ok") throw new Error("not ok");
    expect(loaded.fileSha).toMatch(/^[0-9a-f]{40}$/);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.policy.sensitivePaths).toEqual(["secret-glob-marker/**"]);
    expect(contentRequests().map((r) => r.ref)).toEqual([C2, C1]);
    expect(contentRequests().every((r) => r.path.endsWith("/contents/graft.yaml"))).toBe(true);
  });

  it("U-LOAD-2 a directory, symlink, submodule or followed symlink is file_not_regular", async () => {
    const octokit = await client();
    const cases: [string, FakeContent, boolean][] = [
      ["dir", { kind: "dir" }, false],
      ["symlink", { kind: "symlink", target: "docs/real.yaml" }, true],
      ["submodule", { kind: "submodule" }, true],
      ["followed", { kind: "file", text: POLICY, path: "docs/real.yaml" }, true],
    ];
    for (const [label, entry, hasSha] of cases) {
      clearPolicyCache();
      const ref = fakeSha(label.length + 100);
      put(ref, entry);
      const loaded = await loadBasePolicy(octokit, target(ref));
      expect(loaded.status, label).toBe("invalid");
      if (loaded.status !== "invalid") continue;
      expect(
        loaded.errors.map((e) => e.code),
        label,
      ).toEqual(["file_not_regular"]);
      expect(loaded.fileSha === null, label).toBe(!hasSha);
    }
  });

  it("U-LOAD-3 an oversized file or encoding none is file_too_large, and the content is never decoded", async () => {
    const octokit = await client();
    // Content that would be rejected as non-UTF-8 if it were ever decoded.
    put(C1, { kind: "sized", text: "ÿþ not decoded", size: 40_000 });
    const big = await loadBasePolicy(octokit, target(C1));
    expect(big).toMatchObject({ status: "invalid" });
    if (big.status !== "invalid") throw new Error("unreachable");
    expect(big.errors).toEqual([
      { code: "file_too_large", location: null, line: null, column: null, detail: 40_000 },
    ]);
    put(C2, { kind: "large", size: 2_000_000 });
    const large = await loadBasePolicy(octokit, target(C2));
    expect(large).toMatchObject({
      status: "invalid",
      errors: [{ code: "file_too_large", detail: 2_000_000 }],
    });
  });

  it("U-LOAD-7 a parsed file without a blob SHA is a permanent error, not a retried one", async () => {
    const octokit = await client();
    put(C1, { kind: "file", text: POLICY, omitSha: true });
    const failure = await loadBasePolicy(octokit, target(C1)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PermanentJobError);
  });

  it("U-LOAD-4 loads are cached per commit; a 5xx is not cached and throws a retryable error", async () => {
    const octokit = await client();
    put(C1, { kind: "file", text: POLICY });
    put(C2, { kind: "file", text: "version: 1\n" });
    const [a, b] = await Promise.all([
      loadBasePolicy(octokit, target(C1)),
      loadBasePolicy(octokit, target(C1)),
    ]);
    expect(a).toBe(b);
    await loadBasePolicy(octokit, target(C1));
    expect(contentRequests()).toHaveLength(1);
    await loadBasePolicy(octokit, target(C2));
    expect(contentRequests()).toHaveLength(2);
    // A different repository with the same commit is a different key.
    await loadBasePolicy(octokit, { ...target(C1), repositoryId: REPO_ID + 1 });
    expect(contentRequests()).toHaveLength(3);

    const C3 = fakeSha(0xc3);
    put(C3, { kind: "file", text: "version: 1\n" });
    api.failNext("GET", /\/contents\//, 502);
    const err = await loadBasePolicy(octokit, target(C3)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(await loadBasePolicy(octokit, target(C3))).toMatchObject({ status: "ok" });
    expect(contentRequests()).toHaveLength(5);
  });

  it("U-LOAD-4 a content error that cannot help a retry (403) is permanent", async () => {
    const octokit = await client();
    api.failNext("GET", /\/contents\//, 403);
    const err = await loadBasePolicy(octokit, target(fakeSha(0xc9))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
  });

  it("U-LOAD-5 resolveBaseCommit: the tip, a 404 is permanent base_missing, a 5xx is retryable", async () => {
    const octokit = await client();
    api.state.branches.set("release/1.x", C2);
    expect(await resolveBaseCommit(octokit, { owner: OWNER, repo: REPO, baseRef: "main" })).toBe(
      fakeSha(0xba5e),
    );
    expect(
      await resolveBaseCommit(octokit, { owner: OWNER, repo: REPO, baseRef: "release/1.x" }),
    ).toBe(C2);
    const missing = await resolveBaseCommit(octokit, {
      owner: OWNER,
      repo: REPO,
      baseRef: "gone",
    }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermanentJobError);
    expect((missing as PermanentJobError).reason).toBe("base_missing");
    api.failNext("GET", /\/git\/ref\//, 502);
    const transient = await resolveBaseCommit(octokit, {
      owner: OWNER,
      repo: REPO,
      baseRef: "main",
    }).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(PermanentJobError);
  });

  it("U-LOAD-6 the log holds no glob, rule name, team slug or YAML text", async () => {
    let logged = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        logged += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "info" }, stream);
    const octokit = await client();
    put(C1, { kind: "file", text: POLICY });
    put(C2, {
      kind: "file",
      text: "version: 1\nrules:\n  - name: secret-rule-name-marker\n    aprove: auto\n",
    });
    await loadBasePolicy(octokit, target(C1, log));
    await loadBasePolicy(octokit, target(C2, log));
    expect(logged).toContain('"status":"ok"');
    expect(logged).toContain('"status":"invalid"');
    expect(logged).toContain(`"commitSha7":"${C1.slice(0, 7)}"`);
    for (const secret of [
      "secret-glob-marker",
      "secret-rule-name-marker",
      "secret-team-marker",
      "version: 1",
      "aprove",
    ]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});
