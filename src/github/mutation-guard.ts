/**
 * The mutation guard (Phase 1 step 1, spec §7). Every installation client refuses, before it
 * sends, any write that is not in the table below. Phase 0 writes always pass; a Phase 1 write
 * needs a client made for a feature (`forInstallation(id, { feature })`) and an effective mode
 * that permits it, read from the database at request time (no cache). Anything else that is not a
 * GET or HEAD is refused in every mode: a new write is added to this table on purpose, together
 * with a test (U-MG).
 *
 * Phase 1 step 2 (D11): the two check-run routes stay `phase0`, but their body is read too. A body
 * whose `status` is not `completed` or whose `conclusion` is not `neutral` is a Phase 1 write: only
 * `graft/policy`, only through a `policy` feature client, only when the gate allows it.
 *
 * Phase 1 step 5 (§12): the guard's routes read their body too. `POST …/git/refs` must create
 * `refs/heads/graft-revert/<uuid>`, a guard client's `POST …/pulls` must have a `graft-revert/<uuid>`
 * head, and its `POST …/issues/{n}/labels` must add exactly `graft:revert`. `POST /graphql` is a
 * guard route only for the exported `ENABLE_AUTO_MERGE_MUTATION` document with a
 * `graft-guard:<owner>/<repo>#<n>` client mutation id; any other GraphQL body is unknown. Its
 * `pullRequestId` must be the node id of pull request `<n>` of that repository, as this client
 * created or read it (step 5 review 1, finding 7).
 *
 * This file imports no database and no module code: the mode lookup arrives as a `MutationGate`.
 */
import { PermanentJobError } from "../queue/errors.js";
import type { GitHubClient } from "./client-factory.js";

export type Feature = "guard" | "mcp" | "policy";

/** The only check run that may be published with a non-neutral body (Phase 1 step 2, D11). */
export const ENFORCEABLE_CHECK = "graft/policy";

/**
 * Phase 1 step 5 (D15): the one GraphQL document a Graft client may send. The mutation guard
 * compares a request's `query` with it character for character.
 */
export const ENABLE_AUTO_MERGE_MUTATION = `mutation GraftGuardEnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $clientMutationId: String!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, clientMutationId: $clientMutationId }) {
    clientMutationId
    pullRequest { number repository { nameWithOwner } }
  }
}`;

/** §12: the ref, head and label a guard write may carry. */
export const REVERT_REF_RE = /^refs\/heads\/graft-revert\/[0-9a-f-]{36}$/;
export const REVERT_HEAD_RE = /^graft-revert\/[0-9a-f-]{36}$/;
export const REVERT_LABEL = "graft:revert";
const CLIENT_MUTATION_ID_RE =
  /^graft-guard:([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,9})$/;

export type WriteClass =
  | { kind: "read" }
  | { kind: "auth" }
  | { kind: "app" }
  | { kind: "phase0" }
  | { kind: "phase1"; features: readonly Feature[]; owner: string; repo: string }
  | { kind: "unknown" };

export type RefusalReason =
  | "unknown_route"
  | "no_feature"
  | "feature_not_allowed"
  | "mode_report"
  | "mode_off"
  | "repository_unknown"
  | "app_client";

export type MutationGate = (q: {
  installationId: number;
  owner: string;
  repo: string;
  feature: Feature;
}) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

/**
 * A gate that allows nothing: for clients that never write (export, e2e, tests). Its refusal
 * reads `repository_unknown` because the reason union is fixed by the spec; it does not mean the
 * repository is missing, it means this client has no gate wired in.
 */
export const refuseAllGate: MutationGate = async () => ({
  allowed: false,
  reason: "repository_unknown",
});

/** Names the method, the route template, the feature and the reason: never a body or a URL. */
export class MutationRefusedError extends PermanentJobError {
  constructor(
    readonly method: string,
    readonly route: string,
    readonly feature: Feature | undefined,
    readonly refusal: string,
  ) {
    super(
      `GitHub write refused by the mutation guard: ${method} ${route} (feature ${feature ?? "none"}): ${refusal}`,
      "mutation_refused",
    );
    this.name = "MutationRefusedError";
  }
}

const NAME = "([A-Za-z0-9_.-]{1,100})";
const OWNER_REPO = `^/repos/${NAME}/${NAME}`;

interface Route {
  method: string;
  re: RegExp;
  kind: "auth" | "app" | "phase0" | "phase1";
  features?: readonly Feature[];
}

/** THE write allow-list. Paths are anchored at both ends; `{n}` is digits only. */
const ROUTES: readonly Route[] = [
  { method: "POST", re: /^\/app\/installations\/\d+\/access_tokens$/, kind: "auth" },
  // App-level, with the App JWT: the live e2e runner redelivers a webhook with it (scenario s10),
  // which is why a production allow-list holds it. Graft's own code never calls it. Only a client
  // without an installation (`forApp`) may send it: an installation client is refused.
  { method: "POST", re: /^\/app\/hook\/deliveries\/\d+\/attempts$/, kind: "app" },
  { method: "POST", re: new RegExp(`${OWNER_REPO}/check-runs$`), kind: "phase0" },
  { method: "PATCH", re: new RegExp(`${OWNER_REPO}/check-runs/\\d+$`), kind: "phase0" },
  { method: "POST", re: new RegExp(`${OWNER_REPO}/issues/\\d+/comments$`), kind: "phase0" },
  { method: "PATCH", re: new RegExp(`${OWNER_REPO}/issues/comments/\\d+$`), kind: "phase0" },
  // Step 5 (guard): the revert PR. Declared here so that they are refused today.
  {
    method: "POST",
    re: new RegExp(`${OWNER_REPO}/git/trees$`),
    kind: "phase1",
    features: ["guard"],
  },
  {
    method: "POST",
    re: new RegExp(`${OWNER_REPO}/git/commits$`),
    kind: "phase1",
    features: ["guard"],
  },
  {
    method: "POST",
    re: new RegExp(`${OWNER_REPO}/git/refs$`),
    kind: "phase1",
    features: ["guard"],
  },
  {
    method: "DELETE",
    // Step 5 review 1, nit 9: only a branch the guard names, `graft-revert/<event uuid>`.
    re: new RegExp(`${OWNER_REPO}/git/refs/heads/graft-revert/[0-9a-f-]{36}$`),
    kind: "phase1",
    features: ["guard"],
  },
  {
    method: "POST",
    re: new RegExp(`${OWNER_REPO}/issues/\\d+/labels$`),
    kind: "phase1",
    features: ["guard"],
  },
  // Step 5 revert PR, step 6 `open_change`.
  {
    method: "POST",
    re: new RegExp(`${OWNER_REPO}/pulls$`),
    kind: "phase1",
    features: ["guard", "mcp"],
  },
];

/**
 * The one path normalisation every rule of this file uses: the query string is dropped, and so is
 * one trailing slash. A path with a fragment (`#`), a percent escape or a backslash, or one that
 * does not start with `/`, is null (step 5 review 1, finding 1: a `#` once classified as a route
 * while its body rule saw another path). Nothing is decoded, so a path cannot be made to look like
 * another route.
 */
function normalisedPath(rawPath: string): string | null {
  const q = rawPath.indexOf("?");
  let path = q >= 0 ? rawPath.slice(0, q) : rawPath;
  if (rawPath.includes("#")) return null;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/") || path.includes("%") || path.includes("\\")) return null;
  return path;
}

/**
 * Classifies a request by method and path (no host; the API base path already removed). A write
 * with a dot segment, an empty segment, a fragment or a percent escape is `unknown`.
 */
export function classifyWrite(method: string, rawPath: string): WriteClass {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return { kind: "read" };
  const path = normalisedPath(rawPath);
  if (path === null) return { kind: "unknown" };
  const segments = path.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return { kind: "unknown" };
  for (const route of ROUTES) {
    if (route.method !== m) continue;
    const hit = route.re.exec(path);
    if (!hit) continue;
    if (route.kind !== "phase1") return { kind: route.kind };
    return {
      kind: "phase1",
      features: route.features ?? [],
      owner: hit[1] as string,
      repo: hit[2] as string,
    };
  }
  return { kind: "unknown" };
}

const CHECK_RUN_WRITES: readonly { method: string; re: RegExp }[] = [
  { method: "POST", re: new RegExp(`${OWNER_REPO}/check-runs$`) },
  { method: "PATCH", re: new RegExp(`${OWNER_REPO}/check-runs/\\d+$`) },
];

/**
 * The owner and repository of a check-run write (`POST …/check-runs`, `PATCH …/check-runs/{n}`),
 * whose body decides whether it is a Phase 0 or a Phase 1 write (D11); null for any other route.
 * Call it only on a path `classifyWrite` accepted.
 */
export function checkRunWrite(
  method: string,
  rawPath: string,
): { owner: string; repo: string } | null {
  const m = method.toUpperCase();
  const path = normalisedPath(rawPath);
  if (path === null) return null;
  for (const w of CHECK_RUN_WRITES) {
    if (w.method !== m) continue;
    const hit = w.re.exec(path);
    if (hit) return { owner: hit[1] as string, repo: hit[2] as string };
  }
  return null;
}

/**
 * The body rule of D11: what a check-run body asks for. A `POST` (create) is `neutral`, a Phase 0
 * write, only when it says `completed` + `neutral`: GitHub creates a run without a `status` as
 * `queued`, which is pending and can block a merge (step 2 review 1, finding 2). A `PATCH`
 * (update) is `neutral` when what it sets is `completed`/`neutral` or absent, since an absent key
 * leaves the stored value alone. Anything else is `enforce`, a Phase 1 write. A body that is not a
 * plain JSON object cannot be read reliably: `unreadable`.
 */
export function checkRunBodyKind(
  body: unknown,
  method: "POST" | "PATCH",
): { kind: "neutral" } | { kind: "enforce"; name: unknown } | { kind: "unreadable" } {
  if (body === undefined || body === null) {
    return method === "POST" ? { kind: "enforce", name: undefined } : { kind: "neutral" };
  }
  if (typeof body !== "object" || Array.isArray(body)) return { kind: "unreadable" };
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return { kind: "unreadable" };
  const b = body as Record<string, unknown>;
  // Own keys only; an `undefined` value is not sent (JSON drops it), so it is absent.
  const own = (k: string): unknown => (Object.hasOwn(b, k) ? b[k] : undefined);
  const status = own("status");
  const conclusion = own("conclusion");
  const neutral =
    method === "POST"
      ? status === "completed" && conclusion === "neutral"
      : (status === undefined || status === "completed") &&
        (conclusion === undefined || conclusion === "neutral");
  return neutral ? { kind: "neutral" } : { kind: "enforce", name: own("name") };
}

/** A plain JSON object (not an array, not a class instance), or null. */
function plainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return null;
  return body as Record<string, unknown>;
}

const ownValue = (b: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(b, k) ? b[k] : undefined;

/** §12: the guard routes that carry no body rule (their body names only SHAs and modes). */
const GUARD_BODILESS: readonly { method: string; re: RegExp }[] = [
  { method: "POST", re: new RegExp(`${OWNER_REPO}/git/trees$`) },
  { method: "POST", re: new RegExp(`${OWNER_REPO}/git/commits$`) },
  { method: "DELETE", re: new RegExp(`${OWNER_REPO}/git/refs/heads/graft-revert/[0-9a-f-]{36}$`) },
];

/** Step 5 review 1, nit 9: a revert PR's base is a plain branch name (no `owner:` form). */
const PLAIN_BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

/**
 * §12: whether the body of a guard route is one the guard may send. It fails closed: a route it
 * does not know is refused, and the three bodiless routes (trees, commits, the ref deletion) are
 * listed by name. The path is normalised as `classifyWrite` does it.
 */
export function guardBodyAllowed(method: string, path: string, body: unknown): boolean {
  const p = normalisedPath(path);
  if (p === null) return false;
  const m = method.toUpperCase();
  if (m === "POST" && new RegExp(`${OWNER_REPO}/git/refs$`).test(p)) {
    const b = plainObject(body);
    const ref = b === null ? undefined : ownValue(b, "ref");
    return typeof ref === "string" && REVERT_REF_RE.test(ref);
  }
  if (m === "POST" && new RegExp(`${OWNER_REPO}/pulls$`).test(p)) {
    const b = plainObject(body);
    if (b === null) return false;
    const head = ownValue(b, "head");
    const base = ownValue(b, "base");
    return (
      typeof head === "string" &&
      REVERT_HEAD_RE.test(head) &&
      typeof base === "string" &&
      PLAIN_BRANCH_RE.test(base)
    );
  }
  if (m === "POST" && new RegExp(`${OWNER_REPO}/issues/\\d+/labels$`).test(p)) {
    const b = plainObject(body);
    if (b === null || Object.keys(b).length !== 1) return false;
    const labels = ownValue(b, "labels");
    return Array.isArray(labels) && labels.length === 1 && labels[0] === REVERT_LABEL;
  }
  return GUARD_BODILESS.some((r) => r.method === m && r.re.test(p));
}

/**
 * §12: a GraphQL body the guard may send, with the repository and pull request number its client
 * mutation id names and the node id it targets; null for anything else (which is an unknown
 * route, refused in every mode).
 */
export function guardGraphqlTarget(
  body: unknown,
): { owner: string; repo: string; number: number; pullRequestId: string } | null {
  const b = plainObject(body);
  if (b === null) return null;
  if (Object.keys(b).some((k) => k !== "query" && k !== "variables")) return null;
  if (ownValue(b, "query") !== ENABLE_AUTO_MERGE_MUTATION) return null;
  const vars = plainObject(ownValue(b, "variables"));
  if (vars === null) return null;
  const id = ownValue(vars, "clientMutationId");
  const pullRequestId = ownValue(vars, "pullRequestId");
  if (typeof id !== "string" || typeof pullRequestId !== "string") return null;
  const hit = CLIENT_MUTATION_ID_RE.exec(id);
  return hit
    ? {
        owner: hit[1] as string,
        repo: hit[2] as string,
        number: Number(hit[3]),
        pullRequestId,
      }
    : null;
}

/** A pull request a guard client read or created: what its GraphQL write may target. */
interface SeenPull {
  owner: string;
  repo: string;
  number: number;
}
const MAX_SEEN_PULLS = 200;
const PULLS_RE = new RegExp(`${OWNER_REPO}/pulls(?:/\\d+)?$`);

/**
 * Step 5 review 1, finding 7: the node ids of the pull requests in a `…/pulls` response (create,
 * get, list) of the client's own repository route, with their number. The GraphQL rule requires
 * the node id it enables auto-merge on to be one of these, for the repository and number its
 * client mutation id names, so the gate's repository is the pull request's.
 */
function recordPulls(seen: Map<string, SeenPull>, path: string | null, data: unknown): void {
  if (path === null) return;
  const hit = PULLS_RE.exec(path);
  if (!hit) return;
  for (const p of Array.isArray(data) ? data : [data]) {
    const v = p as { node_id?: unknown; number?: unknown } | null;
    if (typeof v?.node_id !== "string" || typeof v.number !== "number") continue;
    if (seen.size >= MAX_SEEN_PULLS) return;
    seen.set(v.node_id, { owner: hit[1] as string, repo: hit[2] as string, number: v.number });
  }
}

/** Path words that are part of a route; every other segment (names, branches) is templated. */
const KNOWN_SEGMENTS = new Set([
  "api",
  "v3",
  "app",
  "installations",
  "access_tokens",
  "hook",
  "deliveries",
  "attempts",
  "repos",
  "check-runs",
  "issues",
  "comments",
  "labels",
  "git",
  "trees",
  "commits",
  "refs",
  "heads",
  "pulls",
  "merge",
  "reviews",
  "dismissals",
  "branches",
  "protection",
  "contents",
  "statuses",
  "actions",
  "runs",
  "rerun",
  "graphql",
]);

/** A route template safe to log and print: owner, repo, numbers and any free name are templated. */
function routeTemplate(url: string): string {
  const noQuery = (url.split("?")[0] ?? "").split("#")[0] ?? "";
  const path = noQuery.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === "") out.push(seg);
    else if (/^\d+$/.test(seg)) out.push("{n}");
    else if (KNOWN_SEGMENTS.has(seg) || /^\{[a-z_]+\}$/.test(seg)) out.push(seg);
    else if (segments[i - 1] === "repos") out.push("{owner}");
    else if (segments[i - 2] === "repos") out.push("{repo}");
    else out.push("{x}");
  }
  return out.join("/").slice(0, 120);
}

export function installMutationGuard(
  octokit: GitHubClient,
  o: {
    /** null for the App-JWT client. */
    installationId: number | null;
    feature: Feature | undefined;
    /** The factory's configured API base URL: the only host a write may go to. */
    baseUrl: string;
    gate: MutationGate;
    /** Told about every refusal (the factory logs it at error). */
    onRefused?: (e: MutationRefusedError) => void;
  },
): void {
  const seenPulls = new Map<string, SeenPull>();
  const base = o.baseUrl.replace(/\/+$/, "");
  if (o.feature === "guard") {
    octokit.hook.after("request", (response, options) => {
      const url = octokit.request.endpoint.parse(options).url;
      if (!url.startsWith(`${base}/`)) return;
      recordPulls(seenPulls, normalisedPath(url.slice(base.length)), response.data);
    });
  }
  octokit.hook.before("request", async (options) => {
    const parsed = octokit.request.endpoint.parse(options);
    const method = parsed.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return;

    const refusal = (reason: string, suffix = ""): MutationRefusedError => {
      const err = new MutationRefusedError(
        method,
        `${routeTemplate(String(options.url))}${suffix}`,
        o.feature,
        reason,
      );
      o.onRefused?.(err);
      return err;
    };

    // A write to any host other than the configured API is never legitimate. The comparison is
    // against the factory's base URL, never the request's: a per-request `baseUrl` that differs is
    // refused, and so is any resolved URL that is not under the configured one.
    if (options.baseUrl !== undefined && String(options.baseUrl).replace(/\/+$/, "") !== base) {
      throw refusal("unknown_route");
    }
    // §12: GraphQL is a guard route for one document only. Octokit sends it to `<base>/graphql`,
    // or to `/api/graphql` on GitHub Enterprise Server (base `…/api/v3`).
    const graphqlUrl = /\/api\/v3$/.test(base)
      ? base.replace(/\/api\/v3$/, "/api/graphql")
      : `${base}/graphql`;
    if (parsed.url === graphqlUrl) {
      const target = method === "POST" ? guardGraphqlTarget(parsed.body) : null;
      if (target === null) throw refusal("unknown_route");
      if (o.installationId === null) throw refusal("app_client");
      if (o.feature === undefined) throw refusal("no_feature");
      if (o.feature !== "guard") throw refusal("feature_not_allowed");
      const pull = seenPulls.get(target.pullRequestId);
      if (
        pull === undefined ||
        pull.owner.toLowerCase() !== target.owner.toLowerCase() ||
        pull.repo.toLowerCase() !== target.repo.toLowerCase() ||
        pull.number !== target.number
      ) {
        throw refusal("feature_not_allowed", " (pull request)");
      }
      const verdict = await o.gate({
        installationId: o.installationId,
        owner: target.owner,
        repo: target.repo,
        feature: o.feature,
      });
      if (!verdict.allowed) throw refusal(verdict.reason);
      return;
    }
    if (!parsed.url.startsWith(`${base}/`)) throw refusal("unknown_route");
    const cls = classifyWrite(method, parsed.url.slice(base.length));

    switch (cls.kind) {
      case "read":
      case "auth":
        return;
      case "app":
        if (o.installationId !== null) throw refusal("unknown_route");
        return;
      case "phase0": {
        if (o.installationId === null) throw refusal("app_client");
        // D11: a check-run write is Phase 0 only when its body is neutral. The body read is the
        // one Octokit sends (`data` replaces the other parameters), never the caller's options.
        const target = checkRunWrite(method, parsed.url.slice(base.length));
        if (target === null) return;
        const body = checkRunBodyKind(parsed.body, method === "POST" ? "POST" : "PATCH");
        if (body.kind === "neutral") return;
        const tag = " (non-neutral check run)";
        if (body.kind === "unreadable") throw refusal("unknown_route", tag);
        // A PATCH may carry a new `name`, so this checks the name the body asks for, not the
        // stored name of the run it targets (review 1, nit 8). Only the policy job holds a
        // `policy` client, and it PATCHes only a run id it found as `graft/policy` (its stored id
        // or `listForRef` with `check_name`), so a rename of another run cannot happen in practice.
        if (body.name !== ENFORCEABLE_CHECK) throw refusal("feature_not_allowed", tag);
        if (o.feature === undefined) throw refusal("no_feature", tag);
        if (o.feature !== "policy") throw refusal("feature_not_allowed", tag);
        const verdict = await o.gate({
          installationId: o.installationId,
          owner: target.owner,
          repo: target.repo,
          feature: "policy",
        });
        if (!verdict.allowed) throw refusal(verdict.reason, tag);
        return;
      }
      case "unknown":
        throw refusal("unknown_route");
      case "phase1": {
        if (o.installationId === null) throw refusal("app_client");
        if (o.feature === undefined) throw refusal("no_feature");
        if (!cls.features.includes(o.feature)) throw refusal("feature_not_allowed");
        // §12: the body rules of the guard's routes (the `mcp` feature's pulls are step 6's).
        if (
          o.feature === "guard" &&
          !guardBodyAllowed(method, parsed.url.slice(base.length), parsed.body)
        ) {
          throw refusal("feature_not_allowed", " (body)");
        }
        const verdict = await o.gate({
          installationId: o.installationId,
          owner: cls.owner,
          repo: cls.repo,
          feature: o.feature,
        });
        if (!verdict.allowed) throw refusal(verdict.reason);
      }
    }
  });
}
