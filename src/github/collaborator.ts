/**
 * The collaborator role check (Phase 1 step 2, D16): the one implementation of a subtle call.
 * Reviewer eligibility (step 6) needs "triage or above", approvals (step 2) "write or above", and
 * break-glass (step 3) "maintain or above".
 *
 * `role_name` is read first: the legacy `permission` field maps maintain to write and triage to
 * read, so only the role name tells them apart. A custom role is judged by its base permission
 * (`admin` → admin, `write` → write, anything else → read). A 403 or 404 fails closed (`none`, and
 * `denied` says which); rate limits and 5xx throw a retryable job error. A response whose user id
 * differs from the one asked about means the login was recycled: `none`, and so does a response
 * with no user.
 */
import type { GitHubClient } from "./client-factory.js";
import { classifyGitHubError, toJobError } from "./errors.js";

export type CollaboratorRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface RoleAnswer {
  role: CollaboratorRole;
  denied: 403 | 404 | null;
}

const RANK: Record<CollaboratorRole, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/** Whether `role` is at least `min` (none < read < triage < write < maintain < admin). */
export function atLeast(role: CollaboratorRole, min: Exclude<CollaboratorRole, "none">): boolean {
  return RANK[role] >= RANK[min];
}

const NAMED: ReadonlySet<string> = new Set(["admin", "maintain", "write", "triage", "read"]);

/** The role GitHub reports, from `role_name` first, then the base `permission`. */
export function roleFrom(data: { role_name?: unknown; permission?: unknown }): CollaboratorRole {
  const name = typeof data.role_name === "string" ? data.role_name : "";
  if (NAMED.has(name)) return name as CollaboratorRole;
  // A custom role (or no role name): its base permission decides.
  const base = typeof data.permission === "string" ? data.permission : "";
  if (base === "admin") return "admin";
  if (base === "write") return "write";
  if (base === "read") return "read";
  return "none";
}

/** Thrown errors are already job errors (`toJobError`): callers must not classify them again. */
export const classifiedErrors = new WeakSet<object>();

export async function collaboratorRole(
  octokit: GitHubClient,
  o: { owner: string; repo: string; user: { id: number; login: string } },
): Promise<RoleAnswer> {
  try {
    const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: o.owner,
      repo: o.repo,
      username: o.user.login,
    });
    // The login came from the same API a moment ago; a different id means it was recycled. A
    // response with no user cannot be matched to the one asked about: none (fail closed).
    if (!res.data.user || res.data.user.id !== o.user.id) return { role: "none", denied: null };
    return { role: roleFrom(res.data), denied: null };
  } catch (err) {
    const cls = classifyGitHubError(err);
    if (cls === "not_found") return { role: "none", denied: 404 };
    if (cls === "forbidden") return { role: "none", denied: 403 };
    const jobError = toJobError(err, "permission check");
    classifiedErrors.add(jobError);
    throw jobError;
  }
}
