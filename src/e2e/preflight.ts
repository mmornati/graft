/**
 * Preflight for every real-GitHub command (T5). Checks run in a fixed order; each failure aborts
 * with exit 3 and one line that names the check, never a value.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { type Config, ConfigError } from "../config/index.js";
import type { Db } from "../db/client.js";
import { pendingMigrations } from "../db/migrator.js";
import { buildClients, type Clients, type Exchange } from "./clients.js";
import { loadSandboxConfig } from "./config.js";
import { readFixture } from "./fixtures.js";
import {
  assertMarker,
  GuardRefusal,
  MARKER_PATH,
  pickSandbox,
  type SandboxConfig,
  SandboxConfigError,
  type SandboxEntry,
} from "./guard.js";
import { readInstallationFacts, scopeMessage, scopeProblems } from "./scope.js";
import { addIdentityToken, SecretRegistry } from "./secrets.js";
import type { Actor, E2eDeps, IoLike } from "./types.js";

/** An aborted command: `code` 2 is usage/configuration, 3 is a refusal or failed precondition. */
export class Abort extends Error {
  constructor(
    readonly code: 2 | 3,
    readonly line: string,
  ) {
    super(line);
    this.name = "Abort";
  }
}

export const failed = (check: string, detail: string): Abort =>
  new Abort(3, `preflight failed: ${check} (${detail})`);

export type Command = "setup" | "run" | "verify" | "cleanup";

export interface PreflightOptions {
  command: Command;
  sandboxFlag?: string | undefined;
  confirm?: string | undefined;
  /** `setup --create`: the sandbox may not exist yet. */
  create?: boolean | undefined;
  /** Allow `POST /user/repos` (setup --create --yes only). */
  allowCreateRepo?: boolean | undefined;
  /** Refs the write guard lets this process delete: a run id, or "all". */
  deletableRuns?: string | "all" | undefined;
  runId?: string | undefined;
  maxRequests?: number | undefined;
  /** The mutation spacer; tests set it to 0. */
  mutationSpacingMs?: number | undefined;
  /** `run` takes the lock; the other commands only refuse while it is held. */
  acquireLock?: boolean | undefined;
}

export interface Session {
  config: Config;
  sandboxConfig: SandboxConfig;
  sandbox: SandboxEntry;
  owner: string;
  repo: string;
  secrets: SecretRegistry;
  clients: Clients;
  db: Db;
  actorToken: string;
  outsiderToken: string | undefined;
  actor: Actor;
  outsider: Actor | undefined;
  installationId: number;
  repositoryId: number;
  guard: {
    installationId: number | undefined;
    outsiderLogin: string | undefined;
    allowCreate: boolean;
    forkVerified: boolean;
    deletableRuns: string | "all";
    pullRequestIds: Set<string>;
  };
  fixtures: Map<string, string>;
  /** The capture recorder (set by `run --capture`). */
  exchange: { fn: ((ex: Exchange) => void) | undefined };
  releaseLock(): Promise<void>;
  close(): Promise<void>;
}

const lockPath = (outDir: string) => path.join(outDir, ".lock");

async function holdLock(deps: E2eDeps, acquire: boolean): Promise<{ release(): Promise<void> }> {
  const file = lockPath(deps.outDir);
  const pid = deps.pid ?? process.pid;
  const alive =
    deps.isAlive ??
    ((p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
  await mkdir(deps.outDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    let existing: string | null = null;
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = null;
    }
    if (existing !== null) {
      const other = Number(existing.trim());
      if (Number.isInteger(other) && other !== pid && alive(other)) {
        throw failed("lock", "another e2e process holds e2e-runs/.lock");
      }
      if (!acquire) return { release: async () => undefined };
      await rm(file, { force: true });
    } else if (!acquire) return { release: async () => undefined };
    try {
      await writeFile(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return { release: () => rm(file, { force: true }) };
    } catch {
      // lost a race: look again
    }
  }
  throw failed("lock", "cannot take e2e-runs/.lock");
}

export async function readActorToken(deps: E2eDeps, secrets: SecretRegistry): Promise<string> {
  const fromEnv = deps.env.GRAFT_E2E_ACTOR_TOKEN?.trim();
  if (fromEnv) {
    secrets.add(fromEnv);
    return fromEnv;
  }
  let token = "";
  try {
    const res = await deps.spawn("gh", ["auth", "token"]);
    if (res.code === 0) token = res.stdout.trim();
  } catch {
    token = "";
  }
  if (token === "") {
    throw new Abort(
      2,
      "no actor token: set GRAFT_E2E_ACTOR_TOKEN in the shell or log in with gh auth login",
    );
  }
  secrets.add(token);
  return token;
}

export async function openSession(
  deps: E2eDeps,
  _io: IoLike,
  o: PreflightOptions,
): Promise<Session> {
  const secrets = new SecretRegistry();

  // Configuration first (exit 2).
  let config: Config;
  try {
    config = deps.loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) throw new Abort(2, e.message);
    throw e;
  }
  secrets.add(config.githubWebhookSecret);
  secrets.add(config.githubAppPrivateKey);
  secrets.add(config.anthropicApiKey);
  secrets.add(config.anthropicAuthToken);
  secrets.add(config.smeeUrl);
  secrets.add(deps.env.ANTHROPIC_API_KEY);
  secrets.add(deps.env.ANTHROPIC_AUTH_TOKEN);
  secrets.add(deps.env.SMEE_URL);
  await addIdentityToken(secrets, config.anthropicFederation?.identityTokenFile);

  let sandboxConfig: SandboxConfig;
  let sandbox: SandboxEntry;
  try {
    sandboxConfig = await loadSandboxConfig(deps.rootDir);
    sandbox = pickSandbox(sandboxConfig, o.sandboxFlag);
  } catch (e) {
    if (e instanceof SandboxConfigError) throw new Abort(2, e.message);
    if (e instanceof GuardRefusal) throw new Abort(3, e.message);
    throw e;
  }
  const [owner = "", repo = ""] = sandbox.repo.split("/");

  // 1. CI is unset.
  if ((deps.env.CI ?? "") !== "") throw failed("ci", "CI is set; the runner never runs in CI");

  // 2. The human confirms the sandbox.
  if (o.confirm !== undefined) {
    if (o.confirm.toLowerCase() !== sandbox.repo.toLowerCase()) {
      throw failed("confirm", "--confirm does not match the sandbox");
    }
  } else if (deps.isTty) {
    const typed = (
      await deps.prompt(`Type the sandbox name (${sandbox.repo}) to continue: `)
    ).trim();
    if (typed.toLowerCase() !== sandbox.repo.toLowerCase())
      throw failed("confirm", "name not confirmed");
  } else {
    throw failed("confirm", "pass --confirm <owner/repo> when there is no terminal");
  }

  // Tokens.
  const actorToken = await readActorToken(deps, secrets);
  const outsiderToken = deps.env.GRAFT_E2E_OUTSIDER_TOKEN?.trim() || undefined;
  secrets.add(outsiderToken);

  // 3. `.env` holds no GRAFT_E2E_* key and no actor token value (D5).
  const dotenv = deps.readDotEnv();
  if (dotenv) {
    for (const [key, value] of Object.entries(dotenv)) {
      if (key.startsWith("GRAFT_E2E_")) {
        throw failed("env_tokens", `.env contains ${key}; actor tokens belong in the shell only`);
      }
      if (value !== "" && (value === actorToken || value === outsiderToken)) {
        throw failed("env_tokens", `.env value of ${key} equals an actor token`);
      }
    }
  }

  // The write guard and the clients. The guard is mutable so setup/cleanup can open doors.
  const guard = {
    allowCreate: o.allowCreateRepo === true,
    forkVerified: false,
    deletableRuns: o.deletableRuns ?? o.runId ?? "",
    pullRequestIds: new Set<string>(),
    installationId: undefined as number | undefined,
    outsiderLogin: undefined as string | undefined,
  };
  const exchange: { fn: ((ex: Exchange) => void) | undefined } = { fn: undefined };
  const clients = buildClients({
    onExchange: (ex) => exchange.fn?.(ex),
    config,
    fetch: deps.fetch,
    actorToken,
    outsiderToken,
    secrets,
    now: () => deps.now().getTime(),
    sleep: deps.sleep,
    mutationSpacingMs: o.mutationSpacingMs ?? deps.mutationSpacingMs ?? 1000,
    maxRequests: o.maxRequests ?? 3000,
    guard: {
      sandbox: sandbox.repo,
      visibility: sandbox.visibility,
      config: sandboxConfig,
      canDeleteRef: (ref) => {
        const m = /^heads\/graft-e2e\/(e2e-\d{8}-[a-z2-7]{6})\//.exec(ref);
        if (!m) return false;
        return guard.deletableRuns === "all" || guard.deletableRuns === m[1];
      },
      isRunPullRequestId: (id) => guard.pullRequestIds.has(id),
      get installationId() {
        return guard.installationId;
      },
      get outsiderLogin() {
        return guard.outsiderLogin;
      },
      allowCreateRepo: () => guard.allowCreate,
      forkVerified: () => guard.forkVerified,
    },
  });

  // 4. The actor token works.
  let actor: Actor;
  try {
    const { data } = await clients.actor.rest.users.getAuthenticated();
    actor = { login: data.login, id: data.id };
  } catch (e) {
    throw failed("actor_token", `GET /user failed${statusText(e)}`);
  }
  // 5. The actor owns the sandbox.
  if (actor.login.toLowerCase() !== owner.toLowerCase()) {
    throw failed("actor_owner", "the actor login is not the sandbox owner");
  }
  let outsider: Actor | undefined;
  if (clients.outsider) {
    try {
      const { data } = await clients.outsider.rest.users.getAuthenticated();
      outsider = { login: data.login, id: data.id };
      guard.outsiderLogin = data.login;
    } catch (e) {
      throw failed("outsider_token", `GET /user failed for the outsider${statusText(e)}`);
    }
    if (outsider.login.toLowerCase() === actor.login.toLowerCase()) {
      throw failed("outsider_token", "the outsider is the same account as the actor");
    }
  }

  const needsSandbox = !(o.command === "setup" && o.create === true);
  // Only `run` and `verify` depend on a running Graft; `cleanup` needs GitHub alone.
  const needsGraft = o.command === "run" || o.command === "verify";

  // 6. The sandbox exists and holds the marker.
  let repositoryId = 0;
  if (needsSandbox) {
    let reached: { id: number; full_name: string };
    try {
      reached = (await clients.actor.rest.repos.get({ owner, repo })).data;
    } catch (e) {
      if (o.command === "setup") {
        throw new Abort(3, "sandbox missing; rerun with --create --yes");
      }
      throw failed("sandbox_exists", `GET repository failed${statusText(e)}`);
    }
    // A renamed or transferred repository answers under its old name: pin what we reached.
    if (reached.full_name.toLowerCase() !== sandbox.repo.toLowerCase()) {
      throw failed(
        "sandbox_renamed",
        "the sandbox was renamed or moved: GitHub answered under another name; see docs/e2e/runbook.md, section 11",
      );
    }
    repositoryId = reached.id;
    if (o.command !== "setup") {
      const text = await readText(clients, owner, repo, MARKER_PATH, sandbox.defaultBranch);
      try {
        assertMarker(text, sandbox);
      } catch (e) {
        throw failed("sandbox_marker", e instanceof GuardRefusal ? e.reason : "marker");
      }
    }
  }

  // 7. The App is installed on the sandbox.
  let installationId = 0;
  if (needsGraft && needsSandbox) {
    try {
      const { data } = await clients.app.rest.apps.getRepoInstallation({ owner, repo });
      installationId = data.id;
      guard.installationId = data.id;
    } catch (e) {
      throw failed("app_installation", `the App is not installed on the sandbox${statusText(e)}`);
    }
  }

  // 7b. ...and only on the sandbox: "All repositories", or an extra one, would put Graft on the
  // protected source's pull requests.
  if (needsGraft && needsSandbox) {
    const probe = await clients.probe(installationId);
    let facts: Awaited<ReturnType<typeof readInstallationFacts>>;
    try {
      facts = await readInstallationFacts(clients.app, probe, installationId);
    } catch (e) {
      throw failed("installation_scope", `cannot read the installation${statusText(e)}`);
    }
    const problems = scopeProblems(facts, { repo: sandbox.repo, repositoryId }, sandboxConfig);
    if (problems.length > 0) throw failed("installation_scope", scopeMessage(problems));
  }

  // 8. Graft's database.
  const db = deps.openReadOnlyDb(config.databaseUrl);
  const closeAll = async () => {
    await db.destroy().catch(() => undefined);
  };
  try {
    if (o.command !== "cleanup") {
      try {
        await sql`select 1`.execute(db);
      } catch {
        throw failed("database", "Graft's database is not reachable");
      }
      const pending = await pendingMigrations(db).catch(() => ["unreadable"]);
      if (pending.length > 0) throw failed("migrations", "pending migrations: run pnpm db:migrate");
    }

    if (needsGraft && needsSandbox) {
      // 9. installations and repositories rows.
      const inst = await db
        .selectFrom("installations")
        .select("id")
        .where("id", "=", installationId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      const rep = await db
        .selectFrom("repositories")
        .select("id")
        .where("id", "=", repositoryId)
        .where("installation_id", "=", installationId)
        .where("removed_at", "is", null)
        .executeTakeFirst();
      if (!inst || !rep) {
        throw failed(
          "installation_rows",
          "Graft has no rows for the sandbox: remove and re-add the repository in the App's installation settings",
        );
      }
      // 10. The server answers.
      if (!(await deps.readyz())) throw failed("readyz", "GET /readyz did not answer ready");
      // 11. No stale queued job (a stopped worker).
      const stale = await sql<{ n: string }>`
        select count(*)::text as n from ${sql.table(`${config.pgbossSchema}.job`)}
        where state = 'created' and start_after <= now() and created_on < now() - interval '2 minutes'`.execute(
        db,
      );
      if (Number(stale.rows[0]?.n ?? 0) > 0) {
        throw failed("stale_jobs", "queued jobs older than 2 minutes: is the worker running?");
      }
      // 12. graft.yaml on main is the starter.
      const starter = await readFixture(deps.rootDir, "graft.yaml");
      const onMain = await readText(clients, owner, repo, "graft.yaml", sandbox.defaultBranch);
      if (onMain !== starter)
        throw failed("policy_drift", "main:graft.yaml differs; run setup --yes to restore");
    }
    // 13. The actor is not an agent login.
    if (config.agentLogins.includes(actor.login.toLowerCase())) {
      throw failed("actor_agent", "the actor login is in GRAFT_AGENT_LOGINS");
    }
    // 14. Few open run PRs.
    if (o.command === "run" && needsSandbox) {
      const open = await clients.actor.rest.issues.listForRepo({
        owner,
        repo,
        labels: "graft-e2e",
        state: "open",
        per_page: 100,
      });
      if (open.data.filter((i) => i.pull_request).length > 50) {
        throw failed("open_prs", "more than 50 open graft-e2e PRs: run cleanup");
      }
    }
    // 15. The lock.
    const lock = await holdLock(deps, o.acquireLock === true);

    const fixtures = new Map<string, string>();
    for (const name of ["graft.yaml", "graft.s05.yaml", "graft.s09.yaml"]) {
      fixtures.set(name, await readFixture(deps.rootDir, name));
    }
    return {
      config,
      sandboxConfig,
      sandbox,
      owner,
      repo,
      secrets,
      clients,
      db,
      actorToken,
      outsiderToken,
      actor,
      outsider,
      installationId,
      repositoryId,
      guard,
      fixtures,
      exchange,
      releaseLock: () => lock.release(),
      close: closeAll,
    };
  } catch (e) {
    await closeAll();
    throw e;
  }
}

const statusText = (e: unknown): string => {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? `, HTTP ${s}` : "";
};

async function readText(
  clients: Clients,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await clients.actor.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw failed("sandbox_exists", `cannot read ${filePath}${statusText(e)}`);
  }
}
