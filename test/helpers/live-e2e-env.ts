/**
 * A complete offline environment for the live e2e runner: the fake GitHub world, an in-process
 * Graft server and worker on the test database, a fake LLM keyed by the fixture file in the diff,
 * and an `E2eDeps` whose `ops` calls the real ops CLI against the world.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { applyCronSchedules } from "../../src/app/crons.js";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { createLogger } from "../../src/core/logger.js";
import { createDb } from "../../src/db/client.js";
import { MARKER_PATH } from "../../src/e2e/guard.js";
import { sandboxFiles } from "../../src/e2e/setup.js";
import type { E2eDeps } from "../../src/e2e/types.js";
import { createGitHubClientFactory, forToken } from "../../src/github/client-factory.js";
import { refuseAllGate } from "../../src/github/mutation-guard.js";
import { buildServer } from "../../src/http/server.js";
import { agreeingVerifier, createFakeLlm, type FakeReply } from "../../src/llm/fake.js";
import { unconfiguredLlm } from "../../src/llm/index.js";
import type { LlmClient, LlmRequest } from "../../src/llm/types.js";
import { startWorker } from "../../src/queue/worker.js";
import { createTestApp, jobContext, postRaw, type TestApp } from "./app.js";
import { TEST_PRIVATE_KEY, testConfig } from "./config.js";
import { truncateAll } from "./db.js";
import {
  createFakeGitHubWorld,
  type FakeGitHubWorld,
  type WorldUser,
} from "./fake-github-world.js";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SANDBOX_OWNER = "mmornati";
export const SANDBOX_REPO = "graft-sandbox";
export const INSTALLATION_ID = 777_001;
export const ACTOR: WorldUser = {
  login: "mmornati",
  id: 111_001,
  token: "ghp_ACTORtoken0123456789abcdefABCDEF01",
};
export const OUTSIDER: WorldUser = {
  login: "outsider-e2e",
  id: 222_002,
  token: "ghp_OUTSIDERtoken0123456789abcdefAB02",
};

export type LlmChoice = "live" | "none";

const writer = (over: Record<string, unknown>): FakeReply => ({
  json: {
    goal: "Fix a spelling mistake in the guide.",
    behavior_changes: ["The spelling of one word in the guide is corrected."],
    risk_class: "trivial",
    risk_reason: "Only prose changes.",
    out_of_scope_edits: [],
    instructions_in_data: false,
    ...over,
  },
});

/** Writer and verifier replies keyed by the fixture file named in the prompt. */
export function e2eLlmHandler(req: LlmRequest): FakeReply {
  if (req.purpose === "verifier") {
    if (req.user.includes("graft-e2e/src/pace.py")) {
      const m =
        /<untrusted_data_[0-9a-f]+ kind="intent_card">\n([\s\S]*?)\n<\/untrusted_data_/.exec(
          req.user,
        );
      const card = JSON.parse(m?.[1] ?? '{"claims":[]}') as { claims: { id: string }[] };
      return {
        json: {
          claims: card.claims.map((c) => ({
            id: c.id,
            verdict: "contradicted",
            reason: "The diff changes the rounding.",
          })),
          missing_behavior_changes: ["The pace is now rounded down."],
          unexplained_files: [],
          risk_class: "logic",
          risk_reason: "The rounding changes.",
          instructions_in_data: false,
        },
      };
    }
    return agreeingVerifier(req);
  }
  if (req.user.includes("graft-e2e/src/zones.py")) {
    return writer({
      goal: "Change a heart-rate zone threshold.",
      behavior_changes: ["Zone 3 now ends at 65% of the maximum heart rate."],
      risk_class: "logic",
      risk_reason: "A threshold changes.",
      instructions_in_data: true,
    });
  }
  if (req.user.includes("graft-e2e/src/pace.py")) {
    return writer({
      goal: "Fix a docstring typo in the pace helper.",
      behavior_changes: [
        "The pace is rounded down instead of to the nearest value.",
        "The maximum pace limit rises from 15 to 20.",
      ],
      risk_class: "logic",
      risk_reason: "The pace calculation changes.",
      out_of_scope_edits: [
        {
          path: "graft-e2e/src/pace.py",
          reason: "Changes the calculation, not only the docstring.",
        },
      ],
    });
  }
  return writer({});
}

export interface LiveEnv {
  t: TestApp;
  server: Awaited<ReturnType<typeof buildServer>>;
  world: FakeGitHubWorld;
  deps: E2eDeps;
  out: string[];
  err: string[];
  outDir: string;
  logged(): string;
  setLlm(choice: LlmChoice): void;
  llmCalls(): number;
  resetLlmCalls(): void;
  newWorld(o?: {
    private?: boolean;
    outsider?: boolean;
    repoExists?: boolean;
    omitPerformedViaApp?: boolean;
    rateLimit?: boolean;
    seedFiles?: Map<string, string>;
  }): Promise<void>;
  /** Delivers `installation.created` for the sandbox so the installation rows exist. */
  install(): Promise<void>;
  close(): Promise<void>;
}

/** The sandbox as `setup` leaves it: a source copy (one file), the marker, graft.yaml, graft-e2e/. */
export async function sandboxSeed(): Promise<Map<string, string>> {
  const files = await sandboxFiles(ROOT);
  files.set("README.md", "# ai-running-coach (copy)\n");
  files.set(
    MARKER_PATH,
    `${JSON.stringify({ graftE2eSandbox: 1, repo: `${SANDBOX_OWNER}/${SANDBOX_REPO}`, source: "mmornati/ai-running-coach", sourceCommit: "abc", createdAt: "2026-10-01T00:00:00Z" })}\n`,
  );
  return files;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function createLiveEnv(
  o: { llm?: LlmChoice; slug?: string | null; extraConfig?: Record<string, string> } = {},
): Promise<LiveEnv> {
  let logged = "";
  const stream = new Writable({
    write(chunk, _e, cb) {
      logged += String(chunk);
      cb();
    },
  });
  const log = createLogger({ logLevel: "warn" }, stream);
  const slug = o.slug === undefined ? "graft-dev" : o.slug;
  const configEnv: Record<string, string> = {
    ...(slug ? { GITHUB_APP_SLUG: slug } : {}),
    ...(o.extraConfig ?? {}),
  };
  const config = testConfig(configEnv);

  // Calls that reach a model (the fake): the unconfigured client answers without one.
  let calls = 0;
  const fakeModel = (): LlmClient =>
    createFakeLlm((req) => {
      calls += 1;
      return e2eLlmHandler(req);
    });
  let current: LlmClient = o.llm === "none" ? unconfiguredLlm() : fakeModel();
  const llm: LlmClient = { complete: (r) => current.complete(r) };
  const holder: { world: FakeGitHubWorld } = { world: undefined as unknown as FakeGitHubWorld };
  const worldFetch: typeof fetch = (input, init) => holder.world.fetch(input, init);

  const t = await createTestApp({
    supervise: true,
    log,
    llm,
    config: configEnv,
    clock: { now: () => new Date() },
    github: createGitHubClientFactory({
      appId: config.githubAppId,
      privateKey: TEST_PRIVATE_KEY,
      baseUrl: "https://api.github.com",
      gate: refuseAllGate,
      fetch: worldFetch,
    }),
  });
  await applyCronSchedules(t.deps.queue, config);
  const server = await buildServer(t.deps);
  await startWorker(t.deps.queue, t.deps.registry, jobContext(t), {
    concurrency: 4,
    pollingIntervalSeconds: 0.5,
  });

  const out: string[] = [];
  const err: string[] = [];
  const outDir = await mkdtemp(path.join(os.tmpdir(), "graft-e2e-test-"));

  const opsDeps = (extra: Partial<OpsDeps> = {}): OpsDeps => ({
    loadConfig: () => config,
    openDb: (url) => createDb(url, { max: 3 }),
    github: () =>
      createGitHubClientFactory({
        appId: config.githubAppId,
        privateKey: TEST_PRIVATE_KEY,
        baseUrl: "https://api.github.com",
        gate: refuseAllGate,
        fetch: worldFetch,
      }),
    now: () => new Date(),
    sleep: (ms) => realSleep(Math.min(ms, 5)),
    ...extra,
  });

  const deps: E2eDeps = {
    loadConfig: () => config,
    env: {
      GRAFT_E2E_ACTOR_TOKEN: ACTOR.token,
      GRAFT_E2E_OUTSIDER_TOKEN: OUTSIDER.token,
    },
    readDotEnv: () => null,
    fetch: worldFetch,
    openReadOnlyDb: (url) => createDb(url, { max: 3, readOnly: true }),
    async ops(argv, opt = {}) {
      let so = "";
      let se = "";
      const code = await opsMain(
        argv,
        {
          out: (s) => {
            so += s;
          },
          err: (s) => {
            se += s;
          },
        },
        opsDeps(
          opt.baselineToken === undefined
            ? {}
            : {
                baselineToken: () => opt.baselineToken,
                tokenClient: (token, c) =>
                  forToken(token, { baseUrl: c.githubApiUrl, fetch: worldFetch }),
                onTokenRequest: (method, url) => {
                  opt.requestLog?.push({ method, url });
                },
              },
        ),
      );
      return { code, out: so, err: se };
    },
    readyz: async () => (await server.inject({ method: "GET", url: "/readyz" })).statusCode === 200,
    now: () => new Date(),
    // 20 times faster than real: the waits poll every 100 ms instead of 2 s.
    sleep: (ms) => realSleep(Math.max(1, Math.round(ms / 20))),
    prompt: async () => "y",
    spawn: async (command, args) => {
      if (command === "git" && args[0] === "rev-parse")
        return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: "" };
    },
    outDir,
    isTty: false,
    rootDir: ROOT,
    mutationSpacingMs: 0,
    target: "offline",
    pid: process.pid,
    isAlive: () => false,
  };

  const env: LiveEnv = {
    t,
    server,
    get world() {
      return holder.world;
    },
    deps,
    out,
    err,
    outDir,
    logged: () => logged,
    setLlm(choice) {
      current = choice === "none" ? unconfiguredLlm() : fakeModel();
    },
    llmCalls: () => calls,
    resetLlmCalls() {
      calls = 0;
    },
    async newWorld(w = {}) {
      await truncateAll(t.db);
      holder.world = createFakeGitHubWorld({
        owner: SANDBOX_OWNER,
        repo: SANDBOX_REPO,
        appId: config.githubAppId,
        botLogin: slug ? `${slug}[bot]` : "graft-dev[bot]",
        installationId: INSTALLATION_ID,
        users: { actor: ACTOR, ...(w.outsider === false ? {} : { outsider: OUTSIDER }) },
        private: w.private ?? true,
        repoExists: w.repoExists,
        readOnlyRepo: "mmornati/ai-running-coach",
        seedFiles: w.seedFiles ?? (await sandboxSeed()),
        deliver: async (event, body, guid) =>
          (await postRaw(server, event, JSON.stringify(body), guid)).statusCode,
      });
      if (w.omitPerformedViaApp) holder.world.state.omitPerformedViaApp = true;
      if (w.rateLimit) {
        holder.world.state.rateLimit = {
          limit: 5000,
          remaining: 5000,
          reset: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      // On a public sandbox the outsider has no access: it forks.
      if (w.outsider !== false && w.private !== false)
        holder.world.acceptInvitation(OUTSIDER.login);
    },
    async install() {
      const res = await postRaw(
        server,
        "installation",
        JSON.stringify({
          action: "created",
          installation: {
            id: INSTALLATION_ID,
            account: { id: ACTOR.id, login: ACTOR.login, type: "User" },
            repository_selection: "selected",
          },
          repositories: [
            { id: 2_000_001, full_name: `${SANDBOX_OWNER}/${SANDBOX_REPO}`, private: true },
          ],
          sender: { login: ACTOR.login, id: ACTOR.id },
        }),
        `install-${Date.now()}`,
      );
      if (res.statusCode >= 300) throw new Error(`installation.created answered ${res.statusCode}`);
      // Wait for the worker to write the rows.
      for (let i = 0; i < 100; i++) {
        const row = await sql<{ n: string }>`select count(*)::text as n from repositories`.execute(
          t.db,
        );
        if (Number(row.rows[0]?.n) > 0) return;
        await realSleep(50);
      }
      throw new Error("the installation rows did not appear");
    },
    async close() {
      // The schedules persist in the database: remove them so other tests see a clean queue.
      await applyCronSchedules(t.deps.queue, {
        feedbackPollCron: null,
        metricsRollupCron: null,
        modeApplyCron: null,
        permissionsRefreshCron: null,
      });
      await server.close();
      await t.deps.queue.stop();
      // Maintenance timestamps would make the next test file's supervise() a no-op.
      await sql`update pgboss.queue set maintain_on = null, monitor_on = null, monitor_claim_on = null`.execute(
        t.db,
      );
      await t.db.destroy();
      await rm(outDir, { recursive: true, force: true });
    },
  };
  return env;
}
