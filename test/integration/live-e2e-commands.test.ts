/** setup, cleanup, verify, the preflight and the dry run, against the fake world and the test database. */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { e2eMain } from "../../src/e2e/cli.js";
import { MARKER_PATH } from "../../src/e2e/guard.js";
import type { Act } from "../../src/e2e/plan.js";
import { SCENARIOS } from "../../src/e2e/scenarios/index.js";
import { sandboxFiles } from "../../src/e2e/setup.js";
import { forToken } from "../../src/github/client-factory.js";
import { TEST_DATABASE_URL, testConfig } from "../helpers/config.js";
import {
  ACTOR,
  createLiveEnv,
  INSTALLATION_ID,
  type LiveEnv,
  OUTSIDER,
  ROOT,
  sandboxSeed,
} from "../helpers/live-e2e-env.js";

let env: LiveEnv;
const SANDBOX = "mmornati/graft-sandbox";
beforeAll(async () => {
  env = await createLiveEnv();
});
afterAll(() => env.close());
beforeEach(() => {
  env.out.length = 0;
  env.err.length = 0;
});

const run = (argv: string[]) =>
  e2eMain(argv, { out: (s) => env.out.push(s), err: (s) => env.err.push(s) }, env.deps);
const output = () => env.out.join("") + env.err.join("");
const dryRun = (extra: string[] = []) => run(["run", "--dry-run", "--confirm", SANDBOX, ...extra]);

describe("setup and cleanup refusals", () => {
  it("U-LIVE-CLI-2 setup on a missing repo without --create exits 3 with zero writes; --create without --yes on a non-TTY exits 3; cleanup without --yes exits 3 and prints its plan", async () => {
    await env.newWorld({ repoExists: false });
    expect(await run(["setup", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("sandbox missing; rerun with --create --yes");
    expect(env.world.writes()).toEqual([]);

    env.out.length = 0;
    env.err.length = 0;
    expect(await run(["setup", "--create", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("without --yes");
    expect(env.world.writes()).toEqual([]);

    // Dry run of --create prints the plan and writes nothing.
    env.out.length = 0;
    expect(await run(["setup", "--create", "--dry-run", "--confirm", SANDBOX])).toBe(0);
    expect(output()).toContain("plan: create private repository mmornati/graft-sandbox");
    expect(env.world.writes()).toEqual([]);

    // cleanup: a plan and no changes without --yes on a non-TTY.
    await env.newWorld();
    await env.install();
    const w = env.world;
    const octokit = forToken(ACTOR.token, { fetch: w.fetch });
    const main = (
      await octokit.rest.git.getRef({ owner: "mmornati", repo: "graft-sandbox", ref: "heads/main" })
    ).data.object.sha;
    await octokit.rest.git.createRef({
      owner: "mmornati",
      repo: "graft-sandbox",
      ref: "refs/heads/graft-e2e/e2e-20261015-abcdef/s01",
      sha: main,
    });
    const before = w.writes().length;
    env.out.length = 0;
    env.err.length = 0;
    expect(await run(["cleanup", "--run-id", "e2e-20261015-abcdef", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("plan: close 0 PRs and 0 issues, delete 1 branches");
    expect(output()).toContain("refusing to clean up without --yes");
    expect(w.writes().length).toBe(before);
  }, 60_000);
});

describe("preflight", () => {
  async function healthy() {
    await env.newWorld();
    await env.install();
    delete env.deps.env.CI;
    env.deps.readDotEnv = () => null;
    env.deps.readyz = async () =>
      (await env.server.inject({ method: "GET", url: "/readyz" })).statusCode === 200;
    env.deps.isAlive = () => false;
  }

  it("U-LIVE-CLI-3 a healthy environment passes the preflight (a dry run)", async () => {
    await healthy();
    expect(await dryRun()).toBe(0);
    expect(output()).toContain("== s01 Agent typo fix");
  }, 60_000);

  const cases: {
    name: string;
    check: string;
    setup: () => Promise<void> | void;
    argv?: string[];
  }[] = [
    {
      name: "CI is set",
      check: "ci",
      setup: () => {
        env.deps.env.CI = "true";
      },
    },
    {
      name: "--confirm names another repository",
      check: "confirm",
      setup: () => undefined,
      argv: ["--confirm", "mmornati/ai-running-coach"],
    },
    {
      name: ".env holds a GRAFT_E2E_ key",
      check: "env_tokens",
      setup: () => {
        env.deps.readDotEnv = () => ({ GRAFT_E2E_ACTOR_TOKEN: "x" });
      },
    },
    {
      name: "the actor token is wrong",
      check: "actor_token",
      setup: () => {
        env.deps.env.GRAFT_E2E_ACTOR_TOKEN = "ghp_wrongtoken0123456789abcdefghijkl";
      },
    },
    {
      name: "the actor is not the owner",
      check: "actor_owner",
      setup: () => {
        env.deps.env.GRAFT_E2E_ACTOR_TOKEN = OUTSIDER.token;
      },
    },
    {
      name: "the sandbox does not exist",
      check: "sandbox_exists",
      setup: async () => env.newWorld({ repoExists: false }),
    },
    {
      name: "the marker is missing",
      check: "sandbox_marker",
      setup: async () => {
        const seed = await sandboxSeed();
        seed.delete(MARKER_PATH);
        await env.newWorld({ seedFiles: seed });
        await env.install();
      },
    },
    {
      name: "the App is not installed on the sandbox",
      check: "app_installation",
      setup: () => {
        env.world.installed = false;
      },
    },
    {
      name: "the repository answers under another name",
      check: "sandbox_renamed",
      setup: () => {
        env.world.answersAs = "mmornati/renamed-sandbox";
      },
    },
    {
      name: "the App is installed on all repositories",
      check: "installation_scope",
      setup: () => {
        env.world.installation.selection = "all";
      },
    },
    {
      name: "the App is installed on an extra repository",
      check: "installation_scope",
      setup: () => {
        env.world.installation.extraRepos.push({ id: 99, full_name: "mmornati/ai-running-coach" });
      },
    },
    {
      name: "the database is unreachable",
      check: "database",
      setup: () => {
        env.deps.openReadOnlyDb = () =>
          createDb("postgres://graft:graft@127.0.0.1:1/none", { max: 1, readOnly: true });
      },
    },
    {
      name: "Graft has no rows for the sandbox",
      check: "installation_rows",
      setup: async () => void (await sql`truncate installations cascade`.execute(env.t.db)),
    },
    {
      name: "the server does not answer",
      check: "readyz",
      setup: () => {
        env.deps.readyz = async () => false;
      },
    },
    {
      name: "a queued job is older than 2 minutes",
      check: "stale_jobs",
      setup: async () => {
        await env.t.deps.queue.boss.createQueue("e2e.stale");
        await env.t.deps.queue.boss.send("e2e.stale", {});
        await sql`update pgboss.job set created_on = now() - interval '10 minutes', start_after = now() - interval '10 minutes' where name = 'e2e.stale'`.execute(
          env.t.db,
        );
      },
    },
    {
      name: "graft.yaml on main differs from the starter",
      check: "policy_drift",
      setup: async () => {
        const seed = await sandboxSeed();
        seed.set("graft.yaml", "version: 1\n");
        env.world.seedMain(seed, "drift");
      },
    },
    {
      name: "the actor login is an agent login",
      check: "actor_agent",
      setup: () => {
        env.deps.loadConfig = () =>
          testConfig({ GRAFT_AGENT_LOGINS: "mmornati", GITHUB_APP_SLUG: "graft-dev" });
      },
    },
    {
      name: "more than 50 open run PRs",
      check: "open_prs",
      setup: () => env.world.addOpenRunPrs(51),
    },
    {
      name: "another live process holds the lock",
      check: "lock",
      setup: async () => {
        await mkdir(env.outDir, { recursive: true });
        await writeFile(path.join(env.outDir, ".lock"), "424242\n");
        env.deps.isAlive = (pid: number) => pid === 424242;
      },
    },
  ];

  for (const c of cases) {
    it(`U-LIVE-CLI-3 ${c.name}: exit 3, one line naming "${c.check}", no secret`, async () => {
      const config = env.deps.loadConfig;
      const open = env.deps.openReadOnlyDb;
      try {
        await healthy();
        await c.setup();
        const code = await run(["run", "--dry-run", ...(c.argv ?? ["--confirm", SANDBOX])]);
        const text = output().trim();
        expect(code, text).toBe(3);
        expect(text).toContain(c.check);
        expect(text.split("\n")).toHaveLength(1);
        for (const secret of [ACTOR.token, OUTSIDER.token]) expect(text).not.toContain(secret);
      } finally {
        env.deps.loadConfig = config;
        env.deps.openReadOnlyDb = open;
        env.deps.env.GRAFT_E2E_ACTOR_TOKEN = ACTOR.token;
        delete env.deps.env.CI;
        env.deps.readDotEnv = () => null;
        env.deps.isAlive = () => false;
        await sql`delete from pgboss.job where name = 'e2e.stale'`.execute(env.t.db);
        await sql`truncate installations cascade`.execute(env.t.db).catch(() => undefined);
        await mkdir(env.outDir, { recursive: true });
        await writeFile(path.join(env.outDir, ".lock"), "").catch(() => undefined);
      }
    }, 60_000);
  }

  it("U-LIVE-CLI-3 a pending migration stops the preflight", async () => {
    const admin = new URL(TEST_DATABASE_URL);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query("DROP DATABASE IF EXISTS graft_e2e_empty WITH (FORCE)");
    await client.query("CREATE DATABASE graft_e2e_empty");
    const open = env.deps.openReadOnlyDb;
    try {
      await healthy();
      const empty = new URL(TEST_DATABASE_URL);
      empty.pathname = "/graft_e2e_empty";
      env.deps.openReadOnlyDb = () => createDb(empty.toString(), { max: 1, readOnly: true });
      expect(await dryRun()).toBe(3);
      expect(output()).toContain("migrations");
    } finally {
      env.deps.openReadOnlyDb = open;
      await client.query("DROP DATABASE IF EXISTS graft_e2e_empty WITH (FORCE)");
      await client.end();
    }
  }, 60_000);
});

describe("dry run", () => {
  it("U-LIVE-PLAN-2 the whole suite: zero writes, no sweep-feedback or sync-reviewers call, every act printed once", async () => {
    await env.newWorld();
    await env.install();
    delete env.deps.env.CI;
    const calls: string[][] = [];
    const realOps = env.deps.ops;
    env.deps.ops = async (argv, o) => {
      calls.push(argv);
      return realOps(argv, o);
    };
    try {
      expect(await dryRun(["--interactive", "--with-source-baseline"])).toBe(0);
    } finally {
      env.deps.ops = realOps;
    }
    expect(env.world.writes()).toEqual([]);
    expect(calls).toEqual([]);
    const text = env.out.join("");
    const printedActs = text.split("\n").filter((l) => l.startsWith("  act ")).length;
    const planned = SCENARIOS.flatMap((def) =>
      def
        .plan({
          runId: "e2e-20261015-abcdef",
          installationId: INSTALLATION_ID,
          owner: "mmornati",
          repo: "graft-sandbox",
          actor: "mmornati",
          outsider: "outsider-e2e",
          sentinels: { T: "t", B: "b", C: "c", D: "d" },
          interactive: true,
          outsiderMode: "collaborator",
          waitCron: false,
          day: "2026-10-15",
          mode: () => "live",
          sentinelsOf: () => ({ T: "t", B: "b", C: "c", D: "d" }),
        })
        .filter((s) => s.kind === "act"),
    );
    expect(printedActs).toBe(planned.length);
    expect(text).toContain("react");
    expect(text).toContain("pushMain");
    expect(text).toContain("ops   s08.sweep");
    // Nothing was created on disk but possibly the (empty) output directory.
    const files = await readdir(env.outDir).catch(() => []);
    expect(files.filter((f) => f.startsWith("e2e-"))).toEqual([]);
    void ({} as Act);
  }, 60_000);

  it("a plan whose cost bound exceeds --max-cost-usd is refused with exit 3", async () => {
    await env.newWorld();
    await env.install();
    expect(await run(["run", "--confirm", SANDBOX, "--max-cost-usd", "0.01"])).toBe(3);
    expect(output()).toContain("budget");
    expect(env.world.writes()).toEqual([]);
  }, 60_000);
});

describe("read-only session", () => {
  it("I-LIVE-READONLY-1 the runner's database session rejects an insert", async () => {
    const db = env.deps.openReadOnlyDb(TEST_DATABASE_URL);
    try {
      await expect(
        db
          .insertInto("installations")
          .values({
            id: 1,
            account_id: 1,
            account_login: "x",
            account_type: "User",
            repository_selection: "selected",
            suspended_at: null,
            deleted_at: null,
          })
          .execute(),
      ).rejects.toThrow(/read-only transaction/);
      await expect(sql`delete from installations`.execute(db)).rejects.toThrow(
        /read-only transaction/,
      );
      expect((await sql<{ n: number }>`select 1 as n`.execute(db)).rows[0]?.n).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});

describe("setup", () => {
  it("I-LIVE-SETUP-1 --create --yes builds the sandbox, disables Actions and creates the label; a second --yes writes nothing; a drifted graft.yaml is restored with one commit", async () => {
    await env.newWorld({ repoExists: false });
    await env.install();
    const w = env.world;
    const pushes: { sandbox: string; source: string; drop: string[]; files: string[] }[] = [];
    env.deps.gitPusher = {
      async copyAndPush(o) {
        pushes.push({
          sandbox: o.sandbox,
          source: o.source,
          drop: o.drop,
          files: [...o.files.keys()].sort(),
        });
        const files = new Map(o.files);
        files.set("README.md", "# copy\n");
        files.set(MARKER_PATH, `${o.marker("abc1234")}\n`);
        w.seedMain(files, "Files-only copy");
        return { sourceCommit: "abc1234" };
      },
    };
    // The outsider accepts the invitation while setup waits.
    env.deps.sleep = async () => w.acceptInvitation(OUTSIDER.login);
    const args = ["setup", "--create", "--yes", "--invite-outsider", "--confirm", SANDBOX];
    expect(await run(args)).toBe(0);
    expect(output()).toContain("created mmornati/graft-sandbox");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      sandbox: SANDBOX,
      source: "mmornati/ai-running-coach",
      drop: [".github/workflows/", ".circleci/"],
    });
    const expected = await sandboxFiles(ROOT);
    expect(pushes[0]?.files).toEqual([...expected.keys()].sort());
    const marker = JSON.parse(w.fileAt("main", MARKER_PATH) ?? "{}");
    expect(marker).toMatchObject({
      graftE2eSandbox: 1,
      repo: SANDBOX,
      source: "mmornati/ai-running-coach",
      sourceCommit: "abc1234",
    });
    for (const [p, text] of expected) expect(w.fileAt("main", p), p).toBe(text);
    expect(w.repoState()).toMatchObject({ actionsEnabled: false, labels: ["graft-e2e"] });
    expect(w.repoState().collaborators.get(OUTSIDER.login)).toBe("accepted");
    const sandboxJson = path.join(env.outDir, "sandbox.json");
    expect((await stat(sandboxJson)).mode & 0o777).toBe(0o600);
    const info = JSON.parse(await readFile(sandboxJson, "utf8"));
    expect(info).toMatchObject({
      repo: SANDBOX,
      installationId: INSTALLATION_ID,
      outsiderMode: "collaborator",
    });
    expect(JSON.stringify(info)).not.toContain(ACTOR.token);

    // A second run writes nothing.
    const writes = w.writes().length;
    env.out.length = 0;
    expect(await run(["setup", "--yes", "--confirm", SANDBOX])).toBe(0);
    expect(w.writes().length).toBe(writes);
    expect(output()).toContain("fixtures: up to date");

    // Drift: graft.yaml changed on main. Without --yes it is only reported.
    const tip = w.refs()?.get("heads/main") as string;
    const octokit = forToken(ACTOR.token, { fetch: w.fetch });
    const blob = await octokit.rest.git.createBlob({
      owner: "mmornati",
      repo: "graft-sandbox",
      content: "version: 1\n# drifted\n",
      encoding: "utf-8",
    });
    const tree = await octokit.rest.git.createTree({
      owner: "mmornati",
      repo: "graft-sandbox",
      base_tree: (
        await octokit.rest.git.getCommit({
          owner: "mmornati",
          repo: "graft-sandbox",
          commit_sha: tip,
        })
      ).data.tree.sha,
      tree: [{ path: "graft.yaml", mode: "100644", type: "blob", sha: blob.data.sha }],
    });
    const drift = await octokit.rest.git.createCommit({
      owner: "mmornati",
      repo: "graft-sandbox",
      message: "drift",
      tree: tree.data.sha,
      parents: [tip],
    });
    await octokit.rest.git.updateRef({
      owner: "mmornati",
      repo: "graft-sandbox",
      ref: "heads/main",
      sha: drift.data.sha,
      force: false,
    });

    env.out.length = 0;
    const reportOnly = w.writes().length;
    expect(await run(["setup", "--confirm", SANDBOX])).toBe(0);
    expect(output()).toContain("fixtures drifted: graft.yaml");
    expect(w.writes().length).toBe(reportOnly);

    expect(await run(["setup", "--yes", "--confirm", SANDBOX])).toBe(0);
    const added = w
      .writes()
      .slice(reportOnly)
      .map(
        (r) =>
          `${r.method} ${decodeURIComponent(r.path).replace(/^\/repos\/mmornati\/graft-sandbox/, "")}`,
      );
    expect(added).toEqual([
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/main",
    ]);
    const restored = w.refs()?.get("heads/main") as string;
    expect(w.commits.get(restored)?.parents).toEqual([drift.data.sha]);
    expect(w.fileAt("main", "graft.yaml")).toBe(expected.get("graft.yaml"));
  }, 120_000);

  it("a renamed sandbox is reported as renamed, not as missing, and nothing is written", async () => {
    await env.newWorld();
    await env.install();
    env.world.answersAs = "mmornati/renamed-sandbox";
    expect(await run(["setup", "--create", "--yes", "--confirm", SANDBOX])).toBe(3);
    const text = output();
    expect(text).toContain("renamed or moved");
    expect(text).toContain("docs/e2e/runbook.md");
    expect(text).not.toContain("rerun with --create");
    expect(env.world.writes()).toEqual([]);
  }, 60_000);

  it("a created repository that is not the sandbox stops setup before any push, and creation stays closed", async () => {
    await env.newWorld({ repoExists: false });
    await env.install();
    env.world.createdAs = "mmornati/someone-elses";
    let pushed = 0;
    env.deps.gitPusher = {
      async copyAndPush() {
        pushed += 1;
        return { sourceCommit: "x" };
      },
    };
    expect(await run(["setup", "--create", "--yes", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("the created repository is not the sandbox; nothing was pushed");
    expect(pushed).toBe(0);
  }, 60_000);

  it("a repository that exists without the marker is refused", async () => {
    const seed = await sandboxSeed();
    seed.delete(MARKER_PATH);
    await env.newWorld({ seedFiles: seed });
    await env.install();
    expect(await run(["setup", "--yes", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("exists but is not a Graft e2e sandbox");
    expect(env.world.writes()).toEqual([]);
  }, 60_000);
});

describe("cleanup", () => {
  it("I-LIVE-CLEAN-1 closes the run's PRs and issues, deletes only its branches, never deletes a repository, does nothing twice, leaves another run alone", async () => {
    await env.newWorld();
    await env.install();
    const w = env.world;
    const octokit = forToken(ACTOR.token, { fetch: w.fetch });
    const [owner, repo] = ["mmornati", "graft-sandbox"];
    const main = (await octokit.rest.git.getRef({ owner, repo, ref: "heads/main" })).data.object
      .sha;
    const X = "e2e-20261015-aaaaaa";
    const Y = "e2e-20261015-bbbbbb";
    const mk = async (runId: string, scenario: string) => {
      const branch = `graft-e2e/${runId}/${scenario}`;
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: main });
      // A branch needs a different tree to open a PR: reuse main's and accept an empty diff.
      const pr = await octokit.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base: "main",
        title: `[graft-e2e ${runId} ${scenario}] title`,
      });
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.data.number,
        labels: ["graft-e2e"],
      });
      return pr.data.number;
    };
    const px = await mk(X, "s01");
    const py = await mk(Y, "s01");
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/graft-e2e/${Y}/s02`,
      sha: main,
    });
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/graft-e2e/${X}/s02`,
      sha: main,
    });
    const ix = (
      await octokit.rest.issues.create({
        owner,
        repo,
        title: `[graft-e2e ${X}] e2e task`,
        labels: ["graft-e2e"],
      })
    ).data.number;
    const iy = (
      await octokit.rest.issues.create({
        owner,
        repo,
        title: `[graft-e2e ${Y}] e2e task`,
        labels: ["graft-e2e"],
      })
    ).data.number;
    // Looks like a run PR but its title prefix does not match: all three markers must agree.
    await octokit.rest.git.createRef({ owner, repo, ref: "refs/heads/graft-e2e/other", sha: main });
    const odd = (
      await octokit.rest.pulls.create({
        owner,
        repo,
        head: "graft-e2e/other",
        base: "main",
        title: "unrelated",
      })
    ).data.number;
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: odd, labels: ["graft-e2e"] });
    // Let the webhook-driven jobs of the setup settle so they do not race the cleanup.
    const before = w.writes().length;

    env.out.length = 0;
    expect(await run(["cleanup", "--run-id", X, "--yes", "--confirm", SANDBOX])).toBe(0);
    const sent = w
      .writes()
      .slice(before)
      .map(
        (r) =>
          `${r.method} ${decodeURIComponent(r.path).replace(/^\/repos\/mmornati\/graft-sandbox/, "")}`,
      );
    expect(sent.filter((s) => s.startsWith("DELETE")).sort()).toEqual([
      `DELETE /git/refs/heads/graft-e2e/${X}/s01`,
      `DELETE /git/refs/heads/graft-e2e/${X}/s02`,
    ]);
    expect(sent.some((s) => /^DELETE \/?$/.test(s) || s === "DELETE ")).toBe(false);
    expect(
      w.writes().some((r) => r.method === "DELETE" && /^\/repos\/[^/]+\/[^/]+$/.test(r.path)),
    ).toBe(false);
    expect(w.prs.get(px)?.state).toBe("closed");
    expect(w.prs.get(py)?.state).toBe("open");
    expect(w.prs.get(odd)?.state).toBe("open");
    const issues = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: "graft-e2e",
      state: "open",
    });
    expect(issues.data.filter((i) => !i.pull_request).map((i) => i.number)).toEqual([iy]);
    void ix;
    const refs = [...(w.refs()?.keys() ?? [])].sort();
    expect(refs).toContain("heads/main");
    expect(refs).toContain(`heads/graft-e2e/${Y}/s01`);
    expect(refs).toContain(`heads/graft-e2e/${Y}/s02`);
    expect(refs).toContain("heads/graft-e2e/other");
    expect(refs.filter((r) => r.includes(X))).toEqual([]);

    // A second call sends no write.
    const afterFirst = w.writes().length;
    env.out.length = 0;
    expect(await run(["cleanup", "--run-id", X, "--yes", "--confirm", SANDBOX])).toBe(0);
    expect(output()).toContain("nothing to clean up");
    expect(w.writes().length).toBe(afterFirst);

    // --all cleans every run and still never the unrelated branch or main.
    expect(await run(["cleanup", "--all", "--yes", "--confirm", SANDBOX])).toBe(0);
    expect(w.prs.get(py)?.state).toBe("closed");
    expect([...(w.refs()?.keys() ?? [])].sort()).toEqual(["heads/graft-e2e/other", "heads/main"]);
    expect(
      w.writes().some((r) => r.method === "DELETE" && /^\/repos\/[^/]+\/[^/]+$/.test(r.path)),
    ).toBe(false);
  }, 120_000);
});
