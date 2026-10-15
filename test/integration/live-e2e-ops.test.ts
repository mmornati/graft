/** The product changes the runner needs: `pilot sweep-feedback` and `baseline --auth token`. */
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { createDb } from "../../src/db/client.js";
import { forToken, makeGetOnly } from "../../src/github/client-factory.js";
import { createTestApp, fakeGitHubFactory, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { fakeSha, makeReaction, OWNER, REPO, REPO_ID } from "../helpers/github-builders.js";
import { addInstallation } from "../helpers/pilot-seed.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
let api: FakeGitHubApi;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  api = createFakeGitHubApi();
});

function ops(argv: string[], extra: Partial<OpsDeps> = {}) {
  let out = "";
  let err = "";
  const deps: OpsDeps = {
    loadConfig: () => testConfig(),
    openDb: (url) => createDb(url, { max: 2 }),
    github: () => fakeGitHubFactory(api),
    now: () => FIXED_NOW,
    sleep: async () => undefined,
    ...extra,
  };
  return opsMain(
    argv,
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    deps,
  ).then((code) => ({ code, out, err }));
}

describe("pilot sweep-feedback", () => {
  it("U-LIVE-OPS-1 --installation is required and validated; the usage line is there", async () => {
    const missing = await ops(["pilot", "sweep-feedback"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--installation must be a positive integer");
    expect(missing.err).toContain("graft pilot sweep-feedback --installation <id>");
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      const r = await ops(["pilot", "sweep-feedback", "--installation", bad]);
      expect(r.code, bad).toBe(2);
    }
    expect((await ops(["pilot", "sweep-feedback", "--installation", "1", "--bogus"])).code).toBe(2);
    const usage = await ops(["pilot"]);
    expect(usage.err).toContain("sweep-feedback");
  });

  it("I-LIVE-SWEEP-1 polls only the given installation's changes, records the reactions and sends no job", async () => {
    const day = 86_400_000;
    await seedWorld(t.db); // installation 1000001, repository 2000001 (graft-sandbox/sample-ts)
    await addInstallation(t.db, {
      id: 1000002,
      login: "other-org",
      repos: [{ id: 2000002, name: "other-repo" }],
    });
    const seedChange = async (repositoryId: number, n: number, commentId: number) => {
      const row = await t.db
        .insertInto("changes")
        .values({
          repository_id: repositoryId,
          pr_number: n,
          pr_node_id: `n${n}`,
          task_id: null,
          head_sha: fakeSha(n),
          base_ref: "main",
          author_login: "author-x",
          state: "open",
          merge_commit_sha: null,
          opened_at: new Date(FIXED_NOW.getTime() - 5 * day),
          closed_at: null,
          merged_at: null,
          graft_comment_id: commentId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const shownAt = new Date(FIXED_NOW.getTime() - day);
      const card = await sql<{
        id: string;
      }>`insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, goal, risk_class, risk_floor, verifier_status,
          files_total, files_listed, files_full, files_partial, files_omitted, lines_added, lines_deleted, inputs_truncated, published_at)
        values (${row.id}, ${fakeSha(n)}, 'v', ${"c".repeat(64)}, 'ok', 'g', 'logic', 'trivial', 'agree', 1, 1, 1, 0, 0, 1, 0, false, ${shownAt}) returning id`.execute(
        t.db,
      );
      await sql`insert into intent_displays (change_id, card_id, status, shown_at)
        values (${row.id}, ${card.rows[0]?.id as string}, 'ok', ${shownAt})`.execute(t.db);
      return row.id;
    };
    const a = await seedChange(REPO_ID, 2, 900);
    const b = await seedChange(2000002, 3, 901);
    const reactedAt = new Date(FIXED_NOW.getTime() - 12 * 3600_000).toISOString();
    api.state.reactions.set(900, [
      makeReaction(1, "reviewer-1", "+1", reactedAt),
      makeReaction(2, "reviewer-2", "-1", reactedAt),
    ]);
    api.state.reactions.set(901, [makeReaction(3, "reviewer-3", "+1", reactedAt)]);

    const res = await ops(["pilot", "sweep-feedback", "--installation", "1000001"]);
    expect(res.err).toBe("");
    expect(res.out).toBe("polled 1 PRs, 2 votes recorded, 0 skipped\n");
    expect(res.code).toBe(0);
    const rows = await t.db
      .selectFrom("intent_feedback")
      .select(["change_id", "verdict"])
      .execute();
    expect(rows.every((r) => r.change_id === a)).toBe(true);
    expect(rows.map((r) => r.verdict).sort()).toEqual(["down", "up"]);
    expect(rows.some((r) => r.change_id === b)).toBe(false);
    // Only installation A's repository was asked for reactions; no job was sent.
    expect(api.requests.map((r) => r.path).filter((p) => p.includes("/reactions"))).toEqual([
      `/repos/${OWNER}/${REPO}/issues/comments/900/reactions`,
    ]);
    const jobs = await sql<{
      n: string;
    }>`select count(*)::text as n from pgboss.job where name = 'intent.feedback.poll'`.execute(
      t.db,
    );
    expect(jobs.rows[0]?.n).toBe("0");
    // A second run is idempotent.
    expect((await ops(["pilot", "sweep-feedback", "--installation", "1000001"])).out).toBe(
      "polled 1 PRs, 2 votes recorded, 0 skipped\n",
    );
    expect((await ops(["pilot", "sweep-feedback", "--installation", "1000002"])).out).toContain(
      "polled 0 PRs",
    );
  });
});

describe("baseline --auth token", () => {
  const token = "ghp_baselineTOKEN0123456789abcdefghijk";

  it("U-LIVE-BASE-1 token mode needs --dry-run and the token variable; with both it needs no repositories row, sends only GETs and writes no row", async () => {
    const noDry = await ops(
      [
        "baseline",
        "--repo",
        `${OWNER}/${REPO}`,
        "--from",
        "2026-09-01",
        "--to",
        "2026-10-01",
        "--auth",
        "token",
      ],
      { baselineToken: () => token },
    );
    expect(noDry.code).toBe(2);
    expect(noDry.err).toContain("--auth token is only allowed with --dry-run");
    expect(noDry.err).not.toContain(token);

    const noToken = await ops(
      [
        "baseline",
        "--repo",
        `${OWNER}/${REPO}`,
        "--from",
        "2026-09-01",
        "--to",
        "2026-10-01",
        "--auth",
        "token",
        "--dry-run",
      ],
      { baselineToken: () => undefined },
    );
    expect(noToken.code).toBe(2);
    expect(noToken.err).toContain("GRAFT_BASELINE_GITHUB_TOKEN");

    const bogus = await ops([
      "baseline",
      "--repo",
      `${OWNER}/${REPO}`,
      "--from",
      "2026-09-01",
      "--to",
      "2026-10-01",
      "--auth",
      "oauth",
      "--dry-run",
    ]);
    expect(bogus.code).toBe(2);

    // No repositories row exists: the app mode would stop with "repository not found".
    const app = await ops([
      "baseline",
      "--repo",
      `${OWNER}/${REPO}`,
      "--from",
      "2026-09-01",
      "--to",
      "2026-10-01",
      "--dry-run",
    ]);
    expect(app.err).toContain("repository not found");

    api = createFakeGitHubApi();
    const seen: string[] = [];
    const res = await ops(
      [
        "baseline",
        "--repo",
        `${OWNER}/${REPO}`,
        "--from",
        "2026-09-01",
        "--to",
        "2026-10-01",
        "--dry-run",
        "--auth",
        "token",
        "--base",
        "main",
      ],
      {
        baselineToken: () => token,
        tokenClient: (tok, config) => {
          expect(tok).toBe(token);
          const client = forToken(tok, { baseUrl: config.githubApiUrl, fetch: api.fetch });
          client.hook.before(
            "request",
            (o) => void seen.push(`${String(o.method)} ${String(o.url)}`),
          );
          return client;
        },
      },
    );
    expect(res.err).toBe("");
    expect(res.code).toBe(0);
    expect(res.out.startsWith("dry run: nothing written")).toBe(true);
    expect(api.requests.length).toBeGreaterThan(0);
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    const runs = await sql<{ n: string }>`select count(*)::text as n from review_time_runs`.execute(
      t.db,
    );
    expect(runs.rows[0]?.n).toBe("0");
  });

  it("the token client refuses to write", async () => {
    const seen: string[] = [];
    const client = makeGetOnly(forToken(token, { fetch: api.fetch }), (m, u) => {
      seen.push(`${m} ${u}`);
    });
    await expect(
      client.rest.issues.create({ owner: OWNER, repo: REPO, title: "x" }),
    ).rejects.toThrow(/read-only client refused POST/);
    expect(api.requests).toEqual([]);
    // The refused write is still logged, so b2's "zero non-GET" check can see it.
    expect(seen).toEqual(["POST /repos/{owner}/{repo}/issues"]);
  });
});
