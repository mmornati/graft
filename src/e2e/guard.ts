/**
 * The sandbox guard (D4, T6). Two keys: the repository is listed in `e2e/sandboxes.json` AND its
 * default branch holds `.graft-e2e-sandbox` naming it. `PROTECTED_REPOS` plus every configured
 * `source` can never be a write target, whatever the JSON says. Every non-GET request of every
 * runner client passes `checkRequest` (installed as a request hook in clients.ts) which throws
 * `GuardRefusal` before anything is sent.
 */
import { z } from "zod";

/** Repositories that must never be written to. Compared case-insensitively. */
export const PROTECTED_REPOS: readonly string[] = ["mmornati/ai-running-coach"];

export const MARKER_PATH = ".graft-e2e-sandbox";

export type ClientKind = "actor" | "outsider" | "app" | "probe";

/** A request the runner refuses to send (exit 3). Messages hold route templates, never values. */
export class GuardRefusal extends Error {
  constructor(readonly reason: string) {
    super(`guard refused: ${reason}`);
    this.name = "GuardRefusal";
  }
}

/** The sandbox configuration is wrong (exit 2). */
export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

const repoName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);

export const sandboxEntrySchema = z.object({
  repo: repoName,
  source: repoName,
  visibility: z.enum(["private", "public"]),
  defaultBranch: z.string().min(1).max(100),
});
export type SandboxEntry = z.infer<typeof sandboxEntrySchema>;

export const sandboxConfigSchema = z.object({
  version: z.literal(1),
  sandboxes: z.array(sandboxEntrySchema).min(1),
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

const lc = (s: string) => s.toLowerCase();

export function isProtected(repo: string, config?: SandboxConfig): boolean {
  const all = new Set<string>(PROTECTED_REPOS.map(lc));
  for (const s of config?.sandboxes ?? []) all.add(lc(s.source));
  return all.has(lc(repo));
}

export function parseSandboxConfig(text: string): SandboxConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SandboxConfigError("e2e/sandboxes.json is not valid JSON");
  }
  const parsed = sandboxConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new SandboxConfigError(
      `e2e/sandboxes.json is invalid (${parsed.error.issues.map((i) => i.path.join(".") || "root").join(", ")})`,
    );
  }
  const config = parsed.data;
  for (const s of config.sandboxes) {
    if (isProtected(s.repo, config) || lc(s.repo) === lc(s.source)) {
      throw new SandboxConfigError("a sandbox may not be a protected repository or its own source");
    }
  }
  return config;
}

/** `--sandbox` picks an entry; with none given the config must have exactly one. */
export function pickSandbox(config: SandboxConfig, flag: string | undefined): SandboxEntry {
  if (flag === undefined) {
    if (config.sandboxes.length !== 1) {
      throw new SandboxConfigError("several sandboxes are configured: pass --sandbox <owner/repo>");
    }
    return config.sandboxes[0] as SandboxEntry;
  }
  if (isProtected(flag, config)) {
    throw new GuardRefusal("the requested sandbox is a protected repository");
  }
  const hit = config.sandboxes.find((s) => lc(s.repo) === lc(flag));
  if (!hit) throw new GuardRefusal("the requested sandbox is not listed in e2e/sandboxes.json");
  return hit;
}

export const markerSchema = z.object({
  graftE2eSandbox: z.literal(1),
  repo: z.string(),
  source: z.string().optional(),
  sourceCommit: z.string().optional(),
  createdAt: z.string().optional(),
});

/** The second key: the marker file on the default branch must name the sandbox. */
export function assertMarker(markerText: string | null, sandbox: SandboxEntry): void {
  if (markerText === null) throw new GuardRefusal("the repository has no sandbox marker file");
  let json: unknown;
  try {
    json = JSON.parse(markerText);
  } catch {
    throw new GuardRefusal("the sandbox marker file is not valid JSON");
  }
  const m = markerSchema.safeParse(json);
  if (!m.success) throw new GuardRefusal("the sandbox marker file has the wrong shape");
  if (lc(m.data.repo) !== lc(sandbox.repo)) {
    throw new GuardRefusal("the sandbox marker names another repository");
  }
}

// ---------------------------------------------------------------------------------------------
// The write hook
// ---------------------------------------------------------------------------------------------

export interface GuardContext {
  /** `owner/repo`. */
  sandbox: string;
  visibility: "private" | "public";
  /** True for `heads/graft-e2e/<runId>/...` of a run this process may clean up. */
  canDeleteRef(ref: string): boolean;
  config: SandboxConfig;
  /** GraphQL node ids of this run's sandbox PRs (the only ones `markReady` may touch). */
  isRunPullRequestId(id: string): boolean;
  /** True only inside `setup --create --yes`. */
  allowCreateRepo(): boolean;
  /** The run's installation: the only one an installation token may be minted for. */
  installationId?: number | undefined;
  /** The outsider's login (public mode). */
  outsiderLogin?: string | undefined;
  /** True once `GET` of the outsider's fork showed `parent.full_name` equal to the sandbox. */
  forkVerified(): boolean;
}

export interface RequestInfo {
  method: string;
  /** The expanded path, percent-decoded (`/repos/o/r/git/refs/heads/x`). */
  path: string;
  body?: unknown;
}

const READ = new Set(["GET", "HEAD"]);
const MUTATION_FIELD = /\b([A-Za-z_]\w*)\s*\(\s*input\s*:/g;

function repoOfPath(path: string): { owner: string; repo: string; rest: string } | null {
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  return m ? { owner: m[1] as string, repo: m[2] as string, rest: m[3] ?? "" } : null;
}

function checkGraphql(client: ClientKind, body: unknown, ctx: GuardContext): void {
  if (client !== "actor") throw new GuardRefusal("POST /graphql is only allowed for the actor");
  const b = (body ?? {}) as { query?: unknown; variables?: unknown };
  const query = typeof b.query === "string" ? b.query : "";
  const vars = (b.variables ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(b);
  for (const p of [...PROTECTED_REPOS, ...ctx.config.sandboxes.map((s) => s.source)]) {
    if (text.toLowerCase().includes(p.toLowerCase())) {
      throw new GuardRefusal("a GraphQL request mentions a protected repository");
    }
  }
  const fields = [...query.matchAll(MUTATION_FIELD)].map((m) => m[1]);
  const mutations = query.match(/\bmutation\b/g) ?? [];
  if (
    mutations.length !== 1 ||
    /\bsubscription\b/.test(query) ||
    fields.length !== 1 ||
    fields[0] !== "markPullRequestReadyForReview"
  ) {
    throw new GuardRefusal("only the markPullRequestReadyForReview mutation is allowed");
  }
  const keys = Object.keys(vars);
  const id = vars.pullRequestId;
  if (keys.length !== 1 || typeof id !== "string" || !ctx.isRunPullRequestId(id)) {
    throw new GuardRefusal("GraphQL pullRequestId is not a pull request of this run");
  }
}

/** Throws `GuardRefusal` unless this request may be sent. GET and HEAD always pass. */
export function checkRequest(client: ClientKind, req: RequestInfo, ctx: GuardContext): void {
  const method = req.method.toUpperCase();
  if (READ.has(method)) return;
  // Minting an installation token is how an App client authenticates, not a repository write.
  // Only the app and probe clients mint, and only for the run's installation.
  const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.path);
  if (method === "POST" && mint && (client === "app" || client === "probe")) {
    if (ctx.installationId !== undefined && Number(mint[1]) === ctx.installationId) return;
    throw new GuardRefusal("a token for an installation that is not the run's (or not known yet)");
  }
  if (client === "probe") throw new GuardRefusal("the probe client is read-only");
  const path = req.path.split("?")[0] ?? req.path;
  const sandbox = lc(ctx.sandbox);
  const sandboxName = sandbox.split("/")[1] ?? "";

  // 1. Protected repositories: never, from any client, whatever else is true.
  const target = repoOfPath(path);
  if (target && isProtected(`${target.owner}/${target.repo}`, ctx.config)) {
    throw new GuardRefusal(`${method} to a protected repository`);
  }
  if (target && method === "DELETE" && target.rest === "") {
    throw new GuardRefusal("repository deletion is never allowed");
  }

  if (client === "app") {
    if (method === "POST" && /^\/app\/hook\/deliveries\/\d+\/attempts$/.test(path)) return;
    throw new GuardRefusal("the app client may only redeliver webhooks");
  }

  if (path === "/graphql") {
    if (method !== "POST") throw new GuardRefusal("only POST /graphql is allowed");
    checkGraphql(client, req.body, ctx);
    return;
  }

  if (path === "/user/repos") {
    const b = (req.body ?? {}) as { name?: unknown; private?: unknown };
    if (
      client === "actor" &&
      method === "POST" &&
      ctx.allowCreateRepo() &&
      typeof b.name === "string" &&
      lc(b.name) === sandboxName &&
      b.private === (ctx.visibility === "private")
    ) {
      return;
    }
    throw new GuardRefusal("POST /user/repos is only allowed inside setup --create --yes");
  }

  if (!target) throw new GuardRefusal(`${method} outside /repos is not allowed`);
  const full = lc(`${target.owner}/${target.repo}`);
  const rest = target.rest;

  if (full === sandbox) {
    // Never the repository itself (rename, visibility, default branch, transfer).
    if (rest === "" || /^\/transfer(\/|$)/.test(rest)) {
      throw new GuardRefusal(`${method} on the repository itself is never allowed`);
    }
    if (method === "DELETE" && /^\/git\/refs\//.test(rest)) {
      const ref = rest.slice("/git/refs/".length);
      if (!ctx.canDeleteRef(ref)) {
        throw new GuardRefusal("a ref deletion outside this run's branches");
      }
    }
    if (client === "actor") return;
    if (outsiderMayUse(method, rest, req.body, ctx, "sandbox")) return;
    throw new GuardRefusal("the outsider may not use this route");
  }

  // Outsider's fork in public mode.
  if (
    client === "outsider" &&
    ctx.visibility === "public" &&
    ctx.outsiderLogin !== undefined &&
    lc(target.owner) === lc(ctx.outsiderLogin) &&
    lc(target.repo) === sandboxName &&
    ctx.forkVerified() &&
    outsiderMayUse(method, rest, req.body, ctx, "fork")
  ) {
    return;
  }
  throw new GuardRefusal(`${method} ${path} is not a route the plan uses`);
}

/**
 * What the outsider's plan uses, and nothing more: reactions; pull requests are created (never
 * merged or closed); reviewers requested; blobs, trees and commits created; branches of the run
 * created and moved. In public mode it also forks and syncs its fork.
 */
function outsiderMayUse(
  method: string,
  rest: string,
  body: unknown,
  ctx: GuardContext,
  where: "sandbox" | "fork",
): boolean {
  const refOk = (ref: unknown) =>
    typeof ref === "string" && ctx.canDeleteRef(ref.replace(/^refs\//, ""));
  if (where === "sandbox") {
    if (method === "POST" && /^\/issues\/comments\/\d+\/reactions$/.test(rest)) return true;
    if (method === "POST" && rest === "/pulls") return true;
    if (ctx.visibility === "public") return method === "POST" && rest === "/forks";
    if (method === "POST" && /^\/pulls\/\d+\/requested_reviewers$/.test(rest)) return true;
  }
  if (where === "fork" && method === "POST" && rest === "/merge-upstream") return true;
  if (where === "fork" || ctx.visibility === "private") {
    if (method === "POST" && /^\/git\/(blobs|trees|commits)$/.test(rest)) return true;
    if (method === "POST" && rest === "/git/refs") return refOk((body as { ref?: unknown })?.ref);
    const upd = /^\/git\/refs\/(.+)$/.exec(rest);
    if (method === "PATCH" && upd) return refOk(upd[1]);
    if (method === "DELETE" && upd) return refOk(upd[1]);
  }
  return false;
}

export const RUN_ID_RE = /^e2e-\d{8}-[a-z2-7]{6}$/;

/** A `canDeleteRef` for one run id. */
export const refDeletableForRun =
  (runId: string) =>
  (ref: string): boolean =>
    RUN_ID_RE.test(runId) && ref.startsWith(`heads/graft-e2e/${runId}/`) && !ref.includes("..");
