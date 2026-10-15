/** Performs one `act` of a plan: exactly one GitHub mutation (or a short sequence for a commit). */
import type { GitHubClient } from "../github/client-factory.js";
import { classifyGitHubError } from "../github/errors.js";
import { applyOps, commitIdentity } from "./fixtures.js";
import { GuardRefusal } from "./guard.js";
import type { Act, ActClient, StepCtx } from "./plan.js";
import { TIMEOUTS, waitUntil } from "./waiters.js";

const READY_MUTATION =
  "mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } }";

interface Target {
  octokit: GitHubClient;
  /** Where the commits and the branch live (the outsider's fork in public mode). */
  owner: string;
  repo: string;
  user: { login: string; id: number };
}

function target(sx: StepCtx, client: ActClient): Target {
  const { run } = sx;
  if (client === "actor") {
    return { octokit: run.clients.actor, owner: run.owner, repo: run.repo, user: run.actor };
  }
  if (!run.clients.outsider || !run.outsider) throw new Error("plan error: no outsider configured");
  const fork = run.sandbox.visibility === "public";
  return {
    octokit: run.clients.outsider,
    owner: fork ? run.outsider.login : run.owner,
    repo: run.repo,
    user: run.outsider,
  };
}

async function readText(
  octokit: GitHubClient,
  o: { owner: string; repo: string; path: string; ref: string },
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent(o);
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") return null;
    throw err;
  }
}

async function tipOf(t: Target, branch: string): Promise<string> {
  const { data } = await t.octokit.rest.git.getRef({
    owner: t.owner,
    repo: t.repo,
    ref: `heads/${branch}`,
  });
  return data.object.sha;
}

export interface CommitResult {
  sha: string;
  branch: string;
  tree: string;
}

async function commit(sx: StepCtx, a: Extract<Act, { act: "commit" }>): Promise<CommitResult> {
  const t = target(sx, a.client);
  const { owner, repo, octokit } = t;
  const ref = `heads/${a.branch}`;

  if (a.resetTo) {
    const sha = (sx.scope.resolve(a.resetTo) as unknown as CommitResult).sha;
    await octokit.rest.git.updateRef({ owner, repo, ref, sha, force: true });
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: sha });
    return { sha, branch: a.branch, tree: data.tree.sha };
  }

  const identity = commitIdentity(t.user);
  const author = { ...identity, date: sx.run.deps.now().toISOString() };

  let tree: string;
  let parents: string[];
  if (a.sameTreeAs) {
    const same = sx.scope.resolve(a.sameTreeAs) as unknown as CommitResult;
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: same.sha });
    tree = data.tree.sha;
    parents = data.parents.map((p) => p.sha);
  } else {
    const baseSha = await tipOf(t, a.from === "main" ? "main" : a.branch);
    const { data: baseCommit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseSha,
    });
    const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const change of a.changes) {
      const base = await readText(octokit, { owner, repo, path: change.path, ref: baseSha });
      const text = applyOps(change.path, base, change.ops, (name) => {
        const f = sx.run.fixtures.get(name);
        if (f === undefined) throw new Error(`plan error: unknown fixture ${name}`);
        return f;
      });
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: text,
        encoding: "utf-8",
      });
      entries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }
    const created = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree: entries,
    });
    tree = created.data.sha;
    parents = [baseSha];
  }
  const c = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: a.message,
    tree,
    parents,
    author,
    committer: author,
  });
  if (a.from === "main" && !a.force) {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/${ref}`, sha: c.data.sha });
  } else {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref,
      sha: c.data.sha,
      force: a.force === true,
    });
  }
  return { sha: c.data.sha, branch: a.branch, tree };
}

export interface PrResult {
  number: number;
  nodeId: string;
  headSha: string;
  url: string;
}

export async function performAct(sx: StepCtx, raw: Act): Promise<unknown> {
  const { run } = sx;
  const a = sx.scope.resolve(raw) as Act;
  switch (a.act) {
    case "createIssue": {
      const { data } = await run.clients.actor.rest.issues.create({
        owner: run.owner,
        repo: run.repo,
        title: a.title,
        body: a.body,
        labels: a.labels,
      });
      return { number: data.number };
    }
    case "commit":
      return commit(sx, a);
    case "openPr": {
      const t = target(sx, a.client);
      const fork = run.sandbox.visibility === "public" && a.client === "outsider";
      const { data } = await t.octokit.rest.pulls.create({
        owner: run.owner,
        repo: run.repo,
        head: fork && run.outsider ? `${run.outsider.login}:${a.head}` : a.head,
        base: run.sandbox.defaultBranch,
        title: a.title,
        body: a.body,
        draft: a.draft === true,
      });
      // The PR must be in the repository the preflight pinned.
      if (data.base.repo.id !== run.repositoryId) {
        throw new GuardRefusal(
          "a pull request was created in a repository that is not the sandbox",
        );
      }
      run.pullRequestIds.add(data.node_id);
      // The label is the actor's: a fork author cannot label.
      await run.clients.actor.rest.issues.addLabels({
        owner: run.owner,
        repo: run.repo,
        issue_number: data.number,
        labels: a.labels,
      });
      const result: PrResult = {
        number: data.number,
        nodeId: data.node_id,
        headSha: data.head.sha,
        url: data.html_url,
      };
      return result;
    }
    case "markReady": {
      const pr = a.pr as unknown as PrResult;
      await run.clients.actor.graphql(READY_MUTATION, { pullRequestId: pr.nodeId });
      return { ok: true };
    }
    case "react": {
      const t = target(sx, a.client);
      const { data } = await t.octokit.rest.reactions.createForIssueComment({
        owner: run.owner,
        repo: run.repo,
        comment_id: a.comment as unknown as number,
        content: a.content,
      });
      return { id: data.id };
    }
    case "requestReviewers": {
      const t = target(sx, a.client);
      const pr = a.pr as unknown as PrResult;
      await t.octokit.rest.pulls.requestReviewers({
        owner: run.owner,
        repo: run.repo,
        pull_number: pr.number,
        reviewers: a.reviewers as string[],
      });
      return { ok: true };
    }
    case "review": {
      const t = target(sx, a.client);
      const pr = a.pr as unknown as PrResult;
      const { data } = await t.octokit.rest.pulls.createReview({
        owner: run.owner,
        repo: run.repo,
        pull_number: pr.number,
        event: a.event,
        ...(a.event === "COMMENT" ? { body: "Graft e2e review." } : {}),
      });
      return { id: data.id };
    }
    case "pushMain": {
      const t = target(sx, "actor");
      const text = run.fixtures.get(a.fixture);
      if (text === undefined) throw new Error(`plan error: unknown fixture ${a.fixture}`);
      const before = await tipOf(t, run.sandbox.defaultBranch);
      if (a.skipIfSame) {
        const current = await readText(t.octokit, {
          owner: t.owner,
          repo: t.repo,
          path: "graft.yaml",
          ref: before,
        });
        if (current === text) return { sha: before, before, skipped: true };
      }
      const { data: baseCommit } = await t.octokit.rest.git.getCommit({
        owner: t.owner,
        repo: t.repo,
        commit_sha: before,
      });
      const blob = await t.octokit.rest.git.createBlob({
        owner: t.owner,
        repo: t.repo,
        content: text,
        encoding: "utf-8",
      });
      const tree = await t.octokit.rest.git.createTree({
        owner: t.owner,
        repo: t.repo,
        base_tree: baseCommit.tree.sha,
        tree: [{ path: "graft.yaml", mode: "100644", type: "blob", sha: blob.data.sha }],
      });
      const identity = { ...commitIdentity(t.user), date: run.deps.now().toISOString() };
      const c = await t.octokit.rest.git.createCommit({
        owner: t.owner,
        repo: t.repo,
        message: a.message,
        tree: tree.data.sha,
        parents: [before],
        author: identity,
        committer: identity,
      });
      await t.octokit.rest.git.updateRef({
        owner: t.owner,
        repo: t.repo,
        ref: `heads/${run.sandbox.defaultBranch}`,
        sha: c.data.sha,
        force: false,
      });
      return { sha: c.data.sha, before };
    }
    case "redeliver": {
      const d = a.delivery as unknown as { id: number };
      const res = await run.clients.app.request(
        "POST /app/hook/deliveries/{delivery_id}/attempts",
        { delivery_id: d.id },
      );
      return { status: res.status };
    }
    case "fork": {
      const t = target(sx, "outsider");
      await t.octokit.rest.repos.createFork({ owner: run.owner, repo: run.repo });
      const login = run.outsider?.login ?? "";
      const verified = await waitUntil(
        async () => {
          try {
            const { data } = await t.octokit.rest.repos.get({ owner: login, repo: run.repo });
            return (
              (data as { parent?: { full_name?: string } }).parent?.full_name?.toLowerCase() ===
              run.sandbox.repo.toLowerCase()
            );
          } catch (err) {
            if (classifyGitHubError(err) === "not_found") return false;
            throw err;
          }
        },
        { name: "fork exists", timeoutMs: TIMEOUTS.invitation },
        run.clock,
      );
      run.forkVerified = verified;
      return { fork: `${login}/${run.repo}` };
    }
    case "syncFork": {
      const t = target(sx, "outsider");
      await t.octokit.rest.repos.mergeUpstream({
        owner: t.owner,
        repo: t.repo,
        branch: run.sandbox.defaultBranch,
      });
      return { ok: true };
    }
  }
}
