/**
 * Shared world for the policy tests: an installed repo, PR 2, a base branch `main` at B1 whose
 * `graft.yaml` is served by the fake contents API (and a different one at the PR head, which must
 * never be read).
 */
import { readFileSync } from "node:fs";
import type { Db } from "../../src/db/client.js";
import type { EvaluateData } from "../../src/modules/policy/job.js";
import type { FakeGitHubApi } from "./fake-github-api.js";
import {
  type FakeContent,
  type FakeFile,
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeFile,
  makePull,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "./github-builders.js";
import { canaryPatch } from "./intent-scenario.js";

/** The base branch tip the fake serves for `main` and the pull request's `base.sha`. */
export const B1 = fakeSha(0xba5e);
export const B2 = fakeSha(0xba5f);

/** The spec's example policy (docs/examples/graft.yaml). */
export const EXAMPLE_POLICY = readFileSync(
  new URL("../../docs/examples/graft.yaml", import.meta.url),
  "utf8",
);

/** A policy whose names, globs and team are unmistakable, to prove none of them is stored. */
export const MARKER_POLICY = [
  "version: 1",
  "sensitive_paths:",
  "  - marker-sens-zq/**",
  "default:",
  "  require: { humans: 1, team: marker-default-team-zq }",
  "rules:",
  "  - name: marker-rule-zq",
  "    match: { paths: ['infra/**', 'marker-glob-zq/**'] }",
  "    require: { humans: 1, team: marker-team-zq }",
  "",
].join("\n");

export const EVAL_DATA: EvaluateData = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  trigger: "pr",
  deliveryId: "d-policy",
};

export function putContent(
  api: FakeGitHubApi,
  ref: string,
  entry: FakeContent | string | null,
  path = "graft.yaml",
): void {
  const byPath = api.state.contents.get(ref) ?? new Map<string, FakeContent>();
  if (entry === null) byPath.delete(path);
  else byPath.set(path, typeof entry === "string" ? { kind: "file", text: entry } : entry);
  api.state.contents.set(ref, byPath);
}

export const srcFile = (path = "src/retry.ts"): FakeFile =>
  makeFile({ path, additions: 6, deletions: 2, patch: canaryPatch() });

export interface PolicyScenarioOptions {
  /** The base branch's graft.yaml; null serves none. Default: the spec example. */
  policy?: string | null;
  files?: FakeFile[];
  pull?: Parameters<typeof makePull>[0];
}

export function loadPolicyScenario(api: FakeGitHubApi, o: PolicyScenarioOptions = {}): void {
  const files = o.files ?? [srcFile()];
  api.state.pulls.set(
    PR_NUMBER,
    makePull({
      title: "Fix the retry loop",
      body: "Retries failed webhook deliveries.",
      changed_files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      ...o.pull,
    }),
  );
  api.state.files.set(PR_NUMBER, files);
  api.state.branches.set("main", B1);
  putContent(api, B1, o.policy === undefined ? EXAMPLE_POLICY : o.policy);
  // A permissive file at the PR head and at the pull ref: the engine must never read these.
  const permissive =
    "version: 1\ndefault:\n  require: { humans: 1 }\nrules:\n  - match: { risk: [trivial, logic, sensitive] }\n    approve: auto\n";
  putContent(api, HEAD_SHA, permissive);
  putContent(api, `refs/pull/${PR_NUMBER}/head`, permissive);
}

/** Every `repos.getContent` request, as the `ref` it asked for. */
export const contentRefs = (api: FakeGitHubApi): (string | undefined)[] =>
  api.requests.filter((r) => /\/contents\//.test(r.path)).map((r) => r.ref);

/** Writes to the repository (check runs and comments), not the access-token call. */
export const repoWrites = (api: FakeGitHubApi) =>
  api.requests.filter((r) => r.method !== "GET" && !r.path.includes("access_tokens"));

export interface JobRow {
  id: string;
  name: string;
  data: Record<string, unknown>;
  singleton_key: string | null;
  start_after: Date;
  created_on: Date;
}

export async function jobsNamed(db: Db, name: string): Promise<JobRow[]> {
  const { sql } = await import("kysely");
  const res = await sql<JobRow>`
    select id, name, data, singleton_key, start_after, created_on
    from pgboss.job where name = ${name} order by created_on, id`.execute(db);
  return res.rows;
}
