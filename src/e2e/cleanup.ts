/** `graft e2e cleanup`: close the runner's PRs and issues and delete its branches (T12). */

import type { GitHubClient } from "../github/client-factory.js";
import { classifyGitHubError } from "../github/errors.js";
import { RUN_ID_RE } from "./guard.js";
import { Abort, openSession, type Session } from "./preflight.js";
import { abortCode } from "./run.js";
import { safeIo } from "./secrets.js";
import type { E2eDeps, IoLike } from "./types.js";

export interface CleanupOptions {
  sandbox?: string | undefined;
  runId?: string | undefined;
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  confirm?: string | undefined;
}

const LABEL = "graft-e2e";

export interface CleanupPlan {
  prs: { number: number; open: boolean }[];
  issues: number[];
  /** Refs without the `refs/` prefix: `heads/graft-e2e/<runId>/<scenario>`. */
  refs: string[];
  forkRefs: string[];
}

/** True when a title, label set and head ref all belong to the run (or to any run for `all`). */
export function belongsToRun(
  pr: { title: string; labels: string[]; headRef: string },
  runId: string | "all",
): boolean {
  const labelOk = pr.labels.includes(LABEL);
  if (runId === "all") {
    return (
      labelOk &&
      /^\[graft-e2e e2e-\d{8}-[a-z2-7]{6} /.test(pr.title) &&
      /^graft-e2e\/e2e-\d{8}-[a-z2-7]{6}\//.test(pr.headRef)
    );
  }
  return (
    labelOk &&
    pr.title.startsWith(`[graft-e2e ${runId} `) &&
    pr.headRef.startsWith(`graft-e2e/${runId}/`)
  );
}

async function refsOf(
  octokit: GitHubClient,
  o: { owner: string; repo: string },
  runId: string | "all",
): Promise<string[]> {
  const prefix = runId === "all" ? "heads/graft-e2e/" : `heads/graft-e2e/${runId}/`;
  try {
    const list = await octokit.paginate(octokit.rest.git.listMatchingRefs, {
      owner: o.owner,
      repo: o.repo,
      ref: prefix,
      per_page: 100,
    });
    return list
      .map((r) => r.ref.replace(/^refs\//, ""))
      .filter((r) =>
        runId === "all"
          ? /^heads\/graft-e2e\/e2e-\d{8}-[a-z2-7]{6}\//.test(r)
          : r.startsWith(prefix),
      );
  } catch (e) {
    if (classifyGitHubError(e) === "not_found") return [];
    throw e;
  }
}

export async function planCleanup(s: Session, runId: string | "all"): Promise<CleanupPlan> {
  const { owner, repo } = s;
  const prs = await s.clients.actor.paginate(s.clients.actor.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const matched = prs.filter((p) =>
    belongsToRun(
      { title: p.title, labels: p.labels.map((l) => l.name), headRef: p.head.ref },
      runId,
    ),
  );
  const issues = await s.clients.actor.paginate(s.clients.actor.rest.issues.listForRepo, {
    owner,
    repo,
    labels: LABEL,
    state: "open",
    per_page: 100,
  });
  const runIssues = issues.filter(
    (i) =>
      !i.pull_request &&
      (runId === "all"
        ? /^\[graft-e2e e2e-\d{8}-[a-z2-7]{6}\] /.test(i.title)
        : i.title.startsWith(`[graft-e2e ${runId}] `)),
  );
  const refs = await refsOf(s.clients.actor, { owner, repo }, runId);
  let forkRefs: string[] = [];
  if (s.clients.outsider && s.outsider && s.sandbox.visibility === "public") {
    try {
      const { data } = await s.clients.outsider.rest.repos.get({ owner: s.outsider.login, repo });
      if (
        (data as { parent?: { full_name?: string } }).parent?.full_name?.toLowerCase() ===
        s.sandbox.repo.toLowerCase()
      ) {
        s.guard.forkVerified = true;
        forkRefs = await refsOf(s.clients.outsider, { owner: s.outsider.login, repo }, runId);
      }
    } catch (e) {
      if (classifyGitHubError(e) !== "not_found") throw e;
    }
  }
  return {
    prs: matched.map((p) => ({ number: p.number, open: p.state === "open" })),
    issues: runIssues.map((i) => i.number),
    refs,
    forkRefs,
  };
}

export async function cleanupCommand(
  deps: E2eDeps,
  rawIo: IoLike,
  o: CleanupOptions,
): Promise<number> {
  let session: Session | undefined;
  try {
    const target = o.all ? "all" : o.runId;
    if (target === undefined) throw new Abort(2, "pass --run-id <id> or --all");
    if (target !== "all" && !RUN_ID_RE.test(target))
      throw new Abort(2, "--run-id must look like e2e-YYYYMMDD-xxxxxx");
    session = await openSession(deps, rawIo, {
      command: "cleanup",
      sandboxFlag: o.sandbox,
      confirm: o.confirm,
      deletableRuns: target,
    });
    const s = session;
    const io = safeIo(rawIo, s.secrets);
    const plan = await planCleanup(s, target);
    io.out(
      `plan: close ${plan.prs.length} PRs and ${plan.issues.length} issues, delete ${plan.refs.length} branches` +
        `${plan.forkRefs.length ? ` and ${plan.forkRefs.length} branches in the outsider's fork` : ""}\n`,
    );
    for (const p of plan.prs) io.out(`  PR #${p.number}\n`);
    for (const r of plan.refs) io.out(`  ${r}\n`);
    if (o.dryRun) return 0;
    if (plan.prs.length + plan.issues.length + plan.refs.length + plan.forkRefs.length === 0) {
      io.out("nothing to clean up\n");
      return 0;
    }
    if (!o.yes) {
      if (!deps.isTty) {
        io.err("refusing to clean up without --yes\n");
        return 3;
      }
      const answer = await deps.prompt("Proceed? [y/N] ");
      if (!/^y(es)?$/i.test(answer.trim())) {
        io.err("declined\n");
        return 3;
      }
    }
    const { owner, repo } = s;
    for (const p of plan.prs) {
      await s.clients.actor.rest.pulls.update({
        owner,
        repo,
        pull_number: p.number,
        state: "closed",
      });
    }
    for (const n of plan.issues) {
      await s.clients.actor.rest.issues.update({ owner, repo, issue_number: n, state: "closed" });
    }
    for (const ref of plan.refs) await s.clients.actor.rest.git.deleteRef({ owner, repo, ref });
    if (s.clients.outsider && s.outsider) {
      for (const ref of plan.forkRefs) {
        await s.clients.outsider.rest.git.deleteRef({ owner: s.outsider.login, repo, ref });
      }
    }
    io.out("cleaned up\n");
    return 0;
  } catch (err) {
    return abortCode(err, rawIo, session?.secrets);
  } finally {
    await session?.close();
  }
}
