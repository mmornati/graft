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
 * This file imports no database and no module code: the mode lookup arrives as a `MutationGate`.
 */
import { PermanentJobError } from "../queue/errors.js";
import type { GitHubClient } from "./client-factory.js";

export type Feature = "guard" | "mcp" | "policy";

/** The only check run that may be published with a non-neutral body (Phase 1 step 2, D11). */
export const ENFORCEABLE_CHECK = "graft/policy";

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
    re: new RegExp(`${OWNER_REPO}/git/refs/heads/graft-revert/[A-Za-z0-9_./-]+$`),
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
 * Classifies a request by method and path (no host; the API base path already removed). A write
 * with a dot segment, an empty segment or a percent escape is `unknown`: nothing is decoded or
 * normalised, so a path cannot be made to look like another route.
 */
export function classifyWrite(method: string, rawPath: string): WriteClass {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return { kind: "read" };
  const q = rawPath.indexOf("?");
  let path = q >= 0 ? rawPath.slice(0, q) : rawPath;
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/") || path.includes("%") || path.includes("\\")) {
    return { kind: "unknown" };
  }
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
  const path = (rawPath.split("?")[0] ?? "").split("#")[0]?.replace(/(.)\/$/, "$1") ?? "";
  for (const w of CHECK_RUN_WRITES) {
    if (w.method !== m) continue;
    const hit = w.re.exec(path);
    if (hit) return { owner: hit[1] as string, repo: hit[2] as string };
  }
  return null;
}

/**
 * The body rule of D11: what a check-run body asks for. `neutral` (completed + neutral, or no
 * status or conclusion at all) stays a Phase 0 write; anything else is `enforce`, a Phase 1
 * write. A body that is not a plain JSON object cannot be read reliably: `unreadable`.
 */
export function checkRunBodyKind(
  body: unknown,
): { kind: "neutral" } | { kind: "enforce"; name: unknown } | { kind: "unreadable" } {
  if (body === undefined || body === null) return { kind: "neutral" };
  if (typeof body !== "object" || Array.isArray(body)) return { kind: "unreadable" };
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return { kind: "unreadable" };
  const b = body as Record<string, unknown>;
  // Own keys only; an `undefined` value is not sent (JSON drops it), so it is absent.
  const own = (k: string): unknown => (Object.hasOwn(b, k) ? b[k] : undefined);
  const status = own("status");
  const conclusion = own("conclusion");
  if (
    (status !== undefined && status !== "completed") ||
    (conclusion !== undefined && conclusion !== "neutral")
  ) {
    return { kind: "enforce", name: own("name") };
  }
  return { kind: "neutral" };
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
  octokit.hook.before("request", async (options) => {
    const parsed = octokit.request.endpoint.parse(options);
    const method = parsed.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return;

    const base = o.baseUrl.replace(/\/+$/, "");
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
        const body = checkRunBodyKind(parsed.body);
        if (body.kind === "neutral") return;
        const tag = " (non-neutral check run)";
        if (body.kind === "unreadable") throw refusal("unknown_route", tag);
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
