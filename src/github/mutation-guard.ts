/**
 * The mutation guard (Phase 1 step 1, spec §7). Every installation client refuses, before it
 * sends, any write that is not in the table below. Phase 0 writes always pass; a Phase 1 write
 * needs a client made for a feature (`forInstallation(id, { feature })`) and an effective mode
 * that permits it, read from the database at request time (no cache). Anything else that is not a
 * GET or HEAD is refused in every mode: a new write is added to this table on purpose, together
 * with a test (U-MG).
 *
 * This file imports no database and no module code: the mode lookup arrives as a `MutationGate`.
 */
import { PermanentJobError } from "../queue/errors.js";
import type { GitHubClient } from "./client-factory.js";

export type Feature = "guard" | "mcp";

export type WriteClass =
  | { kind: "read" }
  | { kind: "auth" }
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

/** A gate that allows nothing: for clients that never write (export, e2e, tests). */
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
  kind: "auth" | "phase0" | "phase1";
  features?: readonly Feature[];
}

/** THE write allow-list. Paths are anchored at both ends; `{n}` is digits only. */
const ROUTES: readonly Route[] = [
  { method: "POST", re: /^\/app\/installations\/\d+\/access_tokens$/, kind: "auth" },
  // App-level, with the App JWT: the live e2e runner redelivers a webhook with it (scenario s10).
  // Graft's own code never calls it.
  { method: "POST", re: /^\/app\/hook\/deliveries\/\d+\/attempts$/, kind: "auth" },
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

/** `/repos/{owner}/{repo}/...` with numbers as `{n}`: a template safe to log and to print. */
function routeTemplate(url: string): string {
  const noQuery = url.split("?")[0] ?? "";
  const path = noQuery.replace(/^[a-z]+:\/\/[^/]+/i, "");
  return path
    .replace(/^(\/api\/v3)?\/repos\/[^/{]+\/[^/{]+/, "$1/repos/{owner}/{repo}")
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? "{n}" : seg))
    .join("/")
    .slice(0, 120);
}

export function installMutationGuard(
  octokit: GitHubClient,
  o: {
    /** null for the App-JWT client. */
    installationId: number | null;
    feature: Feature | undefined;
    gate: MutationGate;
    /** Told about every refusal (the factory logs it at error). */
    onRefused?: (e: MutationRefusedError) => void;
  },
): void {
  octokit.hook.before("request", async (options) => {
    const parsed = octokit.request.endpoint.parse(options);
    const method = parsed.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return;

    const base = String(options.baseUrl).replace(/\/+$/, "");
    const rest = parsed.url.startsWith(`${base}/`)
      ? parsed.url.slice(base.length)
      : new URL(parsed.url, base).pathname;
    const cls = classifyWrite(method, rest);
    const refusal = (reason: string): MutationRefusedError => {
      const err = new MutationRefusedError(
        method,
        routeTemplate(String(options.url)),
        o.feature,
        reason,
      );
      o.onRefused?.(err);
      return err;
    };

    switch (cls.kind) {
      case "read":
      case "auth":
        return;
      case "phase0":
        if (o.installationId === null) throw refusal("app_client");
        return;
      case "unknown":
        throw refusal("unknown_route");
      case "phase1": {
        if (o.installationId === null || o.feature === undefined) throw refusal("no_feature");
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
