/**
 * Who counts (Phase 1 step 2, spec §5, D2, D4, D5, D17). Turns the reviews' approval count into
 * `ApproverFacts`: role checks (write or above), team lookups and memberships, within fixed
 * bounds. Runs outside the change lock, in every mode. Nothing here is stored: team slugs and
 * memberships live only for the job (Phase 0 D19).
 *
 * Fail closed: a user whose role cannot be read does not count; a team that does not exist, that
 * Graft cannot read, that belongs to a user account or that the App has no `members: read` for is
 * unverified and contributes nobody. Rate limits and 5xx throw (through `toJobError`) so the job
 * retries.
 */
import type { GitHubClient } from "../../github/client-factory.js";
import { atLeast, classifiedErrors, collaboratorRole } from "../../github/collaborator.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import { hasMembersRead } from "../../modes/index.js";
import type { ApproverFacts, Unverified } from "../../policy/enforce.js";
import type { ApprovalCount, PolicyVerdict } from "../../policy/evaluate.js";

export type { ApproverFacts, Unverified } from "../../policy/enforce.js";

/** D17. */
export const MAX_ROLE_CHECKS = 20;
export const MAX_TEAMS = 20;
export const MAX_MEMBERSHIP_CHECKS = 100;

export interface ResolveInput {
  owner: string;
  repo: string;
  approvals: ApprovalCount;
  verdict: PolicyVerdict;
  /** `installations.account_type`. */
  accountType: "User" | "Organization" | "Enterprise";
  /** The stored installation permissions; null when they were never read. */
  permissions: Readonly<Record<string, string>> | null;
  /**
   * Each reviewer's `author_association` (user id → value). It only orders the role checks, so
   * that outsiders on a public repository cannot use up the D17 bound ahead of the people who
   * hold access (step 2 review 1, finding 4). It is never proof of access: everyone checked still
   * gets a role check, and anyone left unchecked keeps the fail-closed rules.
   */
  associations?: ReadonlyMap<number, string>;
}

/** Check order: the associations that usually mean access first, then everyone else. */
const ASSOCIATION_RANK: Readonly<Record<string, number>> = {
  OWNER: 0,
  MEMBER: 1,
  COLLABORATOR: 2,
};

/** Stable: the login order of `users` is kept within each association rank. */
function checkOrder<T extends { id: number }>(
  users: readonly T[],
  associations: ReadonlyMap<number, string> | undefined,
): T[] {
  const rank = (u: T): number => {
    const a = associations?.get(u.id);
    return a !== undefined && Object.hasOwn(ASSOCIATION_RANK, a)
      ? (ASSOCIATION_RANK[a] as number)
      : 3;
  };
  return [...users].sort((a, b) => rank(a) - rank(b));
}

const rethrow = (err: unknown, what: string): never => {
  if (err instanceof Error && classifiedErrors.has(err)) throw err;
  throw toJobError(err, what);
};

export async function resolveApprovers(
  octokit: GitHubClient,
  i: ResolveInput,
): Promise<ApproverFacts> {
  const roles = new Map<number, "write" | "below" | 403 | 404>();
  const role = async (u: { id: number; login: string }) => {
    let r = roles.get(u.id);
    if (r === undefined) {
      const answer = await collaboratorRole(octokit, { owner: i.owner, repo: i.repo, user: u });
      r = answer.denied ?? (atLeast(answer.role, "write") ? "write" : "below");
      roles.set(u.id, r);
    }
    return r;
  };

  // Approvers: at most MAX_ROLE_CHECKS checked, by association then login; the rest do not count.
  const counted: ApproverFacts["counted"] = [];
  const notCounted: ApproverFacts["notCounted"] = [];
  for (const [n, u] of checkOrder(i.approvals.currentApprovers, i.associations).entries()) {
    if (n >= MAX_ROLE_CHECKS) {
      notCounted.push({ login: u.login, why: "check_limit" });
      continue;
    }
    const r = await role(u);
    if (r === "write") counted.push(u);
    else {
      notCounted.push({
        login: u.login,
        why: r === "below" ? "no_write_access" : "permission_denied",
      });
    }
  }

  // Change requesters (D5): a writer's request blocks; a reader's, or a non-collaborator's (404),
  // does not. A request Graft cannot judge blocks (fail closed): a 403 on the role check, or a
  // requester past the bound (at most MAX_ROLE_CHECKS checks for requesters).
  const changesRequestedBy: string[] = [];
  for (const [n, u] of checkOrder(i.approvals.changesRequested, i.associations).entries()) {
    const r = n < MAX_ROLE_CHECKS ? await role(u) : "unchecked";
    if (r === "write" || r === 403 || r === "unchecked") changesRequestedBy.push(u.login);
  }

  return {
    counted,
    notCounted,
    changesRequestedBy,
    teams: await resolveTeams(octokit, i, counted),
    reviewsTruncated: i.approvals.truncated,
  };
}

async function resolveTeams(
  octokit: GitHubClient,
  i: ResolveInput,
  counted: readonly { id: number; login: string }[],
): Promise<ApproverFacts["teams"]> {
  const teams: ApproverFacts["teams"] = {};
  if (i.verdict.outcome !== "would_require") return teams;
  const constraints = i.verdict.constraints.filter((c) => c.teams.length > 0);
  const named = [...new Set(constraints.flatMap((c) => c.teams))];
  if (named.length === 0) return teams;
  const all = (why: Unverified) => {
    for (const t of named) teams[t] = { unverified: why };
    return teams;
  };
  if (i.accountType !== "Organization") return all("owner_not_org");
  if (!hasMembersRead(i.permissions)) return all("no_permission");

  // One lookup per team, at most MAX_TEAMS of them.
  const readable: string[] = [];
  for (const [n, slug] of named.entries()) {
    if (n >= MAX_TEAMS) {
      teams[slug] = { unverified: "check_limit" };
      continue;
    }
    try {
      await octokit.rest.teams.getByName({ org: i.owner, team_slug: slug });
      teams[slug] = { members: [] };
      readable.push(slug);
    } catch (err) {
      const cls = classifyGitHubError(err);
      if (cls === "not_found") teams[slug] = { unverified: "team_not_found" };
      else if (cls === "forbidden") teams[slug] = { unverified: "team_unreadable" };
      else rethrow(err, "team lookup");
    }
  }

  // Memberships of counted approvers only, stopping as soon as each constraint is met.
  const membership = new Map<string, boolean>();
  const cut = new Set<string>();
  let requests = 0;
  const isMember = async (slug: string, login: string): Promise<boolean | "cut"> => {
    const entry = teams[slug];
    if (entry === undefined || !("members" in entry)) return false;
    const key = `${slug}\u0000${login.toLowerCase()}`;
    const known = membership.get(key);
    if (known !== undefined) return known;
    if (requests >= MAX_MEMBERSHIP_CHECKS) return "cut";
    requests++;
    let active = false;
    try {
      const res = await octokit.rest.teams.getMembershipForUserInOrg({
        org: i.owner,
        team_slug: slug,
        username: login,
      });
      active = res.data.state === "active";
    } catch (err) {
      const cls = classifyGitHubError(err);
      if (cls === "forbidden") {
        teams[slug] = { unverified: "team_unreadable" };
        return false;
      }
      if (cls !== "not_found") rethrow(err, "team membership");
    }
    membership.set(key, active);
    if (active) {
      const now = teams[slug];
      if (now !== undefined && "members" in now && !now.members.includes(login)) {
        now.members.push(login);
      }
    }
    return active;
  };

  for (const c of constraints) {
    let qualifying = 0;
    for (const u of counted) {
      if (qualifying >= c.humans) break;
      let qualifies = false;
      for (const slug of c.teams) {
        const answer = await isMember(slug, u.login);
        if (answer === "cut") {
          cut.add(slug);
          continue;
        }
        if (answer) {
          qualifies = true;
          break;
        }
      }
      if (qualifies) qualifying++;
    }
  }
  // A team whose checks were cut by the bound is unverified: its partial list is not trusted.
  for (const slug of cut) {
    const entry = teams[slug];
    if (entry !== undefined && "members" in entry) teams[slug] = { unverified: "check_limit" };
  }
  for (const entry of Object.values(teams)) {
    if ("members" in entry) entry.members.sort(byLowerLogin);
  }
  return teams;
}

function byLowerLogin(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}
