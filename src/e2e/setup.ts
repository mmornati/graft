/** `graft e2e setup`: create or check the sandbox, label, Actions, outsider, App (T12). */

import path from "node:path";
import { classifyGitHubError } from "../github/errors.js";
import { writeFileAtomic } from "../pilot/atomic-write.js";
import { commitIdentity, readFixture, readSandboxFixtureTree } from "./fixtures.js";
import { assertMarker, GuardRefusal, MARKER_PATH } from "./guard.js";
import { Abort, openSession, type Session } from "./preflight.js";
import { ensurePrivateDir } from "./report.js";
import { abortCode } from "./run.js";
import { readInstallationFacts, scopeMessage, scopeProblems } from "./scope.js";
import { safeIo } from "./secrets.js";
import type { E2eDeps, IoLike } from "./types.js";
import { TIMEOUTS, waitUntil } from "./waiters.js";

export interface SetupOptions {
  sandbox?: string | undefined;
  create: boolean;
  yes: boolean;
  inviteOutsider: boolean;
  dryRun: boolean;
  confirm?: string | undefined;
}

const LABEL = "graft-e2e";
const SOURCE_DROPS = [".github/workflows/", ".circleci/"];

/** The files setup puts in the sandbox: the starter policy and the `graft-e2e/` fixtures. */
export async function sandboxFiles(rootDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set("graft.yaml", await readFixture(rootDir, "graft.yaml"));
  for (const [p, text] of await readSandboxFixtureTree(rootDir)) files.set(p, text);
  return files;
}

async function readFile(s: Session, filePath: string): Promise<string | null> {
  try {
    const { data } = await s.clients.actor.rest.repos.getContent({
      owner: s.owner,
      repo: s.repo,
      path: filePath,
      ref: s.sandbox.defaultBranch,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (e) {
    if (classifyGitHubError(e) === "not_found") return null;
    throw e;
  }
}

export async function setupCommand(deps: E2eDeps, rawIo: IoLike, o: SetupOptions): Promise<number> {
  let session: Session | undefined;
  try {
    session = await openSession(deps, rawIo, {
      command: "setup",
      sandboxFlag: o.sandbox,
      confirm: o.confirm,
      create: o.create,
      allowCreateRepo: o.create && o.yes && !o.dryRun,
    });
    return await doSetup(deps, rawIo, session, o);
  } catch (err) {
    return abortCode(err, rawIo, session?.secrets);
  } finally {
    await session?.close();
  }
}

async function doSetup(deps: E2eDeps, rawIo: IoLike, s: Session, o: SetupOptions): Promise<number> {
  const io = safeIo(rawIo, s.secrets);
  const { owner, repo, sandbox } = s;
  const write = !o.dryRun;
  const files = await sandboxFiles(deps.rootDir);

  // 2. Does the repository exist?
  let exists = true;
  let isPrivate = sandbox.visibility === "private";
  try {
    const { data } = await s.clients.actor.rest.repos.get({ owner, repo });
    if (data.full_name.toLowerCase() !== sandbox.repo.toLowerCase()) {
      throw new Abort(
        3,
        "preflight failed: sandbox_renamed (the sandbox was renamed or moved: GitHub answered under another name; see docs/e2e/runbook.md, section 11)",
      );
    }
    isPrivate = data.private;
    s.guard.allowCreate = false;
  } catch (e) {
    if (classifyGitHubError(e) !== "not_found") throw e;
    exists = false;
  }

  if (!exists) {
    if (!o.create) throw new Abort(3, "sandbox missing; rerun with --create --yes");
    io.out(
      `plan: create ${sandbox.visibility} repository ${sandbox.repo}, copy the files of ${sandbox.source} ` +
        `(no history; ${SOURCE_DROPS.join(", ")} dropped), add the marker, graft.yaml and graft-e2e/\n`,
    );
    if (o.dryRun) return 0;
    if (!o.yes) {
      if (!deps.isTty) throw new Abort(3, "refusing to create the sandbox without --yes");
      const answer = await deps.prompt("Create it? [y/N] ");
      if (!/^y(es)?$/i.test(answer.trim())) throw new Abort(3, "declined");
    }
    s.guard.allowCreate = true;
    let created: Awaited<ReturnType<typeof s.clients.actor.rest.repos.createForAuthenticatedUser>>;
    try {
      created = await s.clients.actor.rest.repos.createForAuthenticatedUser({
        name: repo,
        private: sandbox.visibility === "private",
        auto_init: false,
        has_wiki: false,
        has_projects: false,
        description: `Graft e2e sandbox: files-only copy of ${sandbox.source}. Safe to close PRs.`,
      });
    } finally {
      // Whatever happens next, no further repository may be created.
      s.guard.allowCreate = false;
    }
    // Push to what GitHub created, after checking that it is the sandbox.
    if (created.data.full_name.toLowerCase() !== sandbox.repo.toLowerCase()) {
      throw new Abort(3, "the created repository is not the sandbox; nothing was pushed");
    }
    if (!deps.gitPusher) throw new Abort(2, "no git pusher is configured");
    try {
      const pushed = await deps.gitPusher.copyAndPush({
        sandbox: created.data.full_name,
        source: sandbox.source,
        token: s.actorToken,
        files,
        drop: SOURCE_DROPS,
        message: `Files-only copy of ${sandbox.source} for the Graft e2e sandbox`,
        marker: (sourceCommit) =>
          JSON.stringify({
            graftE2eSandbox: 1,
            repo: sandbox.repo,
            source: sandbox.source,
            sourceCommit,
            createdAt: deps.now().toISOString(),
          }),
      });
      io.out(
        `created ${sandbox.repo} from ${sandbox.source} at ${pushed.sourceCommit.slice(0, 7)}\n`,
      );
    } catch (e) {
      if (e instanceof Error && e.name === "LfsRefused") {
        throw new Abort(3, "the source repository uses Git LFS; the sandbox would hold pointers");
      }
      throw e;
    }
  } else {
    // 3. An existing repository must be a sandbox.
    try {
      assertMarker(await readFile(s, MARKER_PATH), sandbox);
    } catch (e) {
      if (e instanceof GuardRefusal) {
        throw new Abort(3, "the repository exists but is not a Graft e2e sandbox");
      }
      throw e;
    }
    if (isPrivate !== (sandbox.visibility === "private")) {
      throw new Abort(
        3,
        `the sandbox is ${isPrivate ? "private" : "public"} but the config says ${sandbox.visibility}`,
      );
    }
    const drifted: string[] = [];
    for (const [p, text] of files) {
      if ((await readFile(s, p)) !== text) drifted.push(p);
    }
    if (drifted.length === 0) io.out("fixtures: up to date\n");
    else {
      io.out(`fixtures drifted: ${drifted.join(", ")}\n`);
      if (o.yes && write) {
        await restoreFixtures(s, deps, files, drifted);
        io.out("restored with one commit to main\n");
      } else io.out("run setup --yes to restore them\n");
    }
  }

  // 4. Actions off, label present.
  if (o.yes && write) {
    const perm = await s.clients.actor.rest.actions.getGithubActionsPermissionsRepository({
      owner,
      repo,
    });
    if (perm.data.enabled !== false) {
      await s.clients.actor.rest.actions.setGithubActionsPermissionsRepository({
        owner,
        repo,
        enabled: false,
      });
      const again = await s.clients.actor.rest.actions.getGithubActionsPermissionsRepository({
        owner,
        repo,
      });
      if (again.data.enabled !== false) throw new Abort(3, "Actions could not be disabled");
      io.out("Actions: disabled\n");
    } else io.out("Actions: already disabled\n");
    try {
      await s.clients.actor.rest.issues.getLabel({ owner, repo, name: LABEL });
    } catch (e) {
      if (classifyGitHubError(e) !== "not_found") throw e;
      await s.clients.actor.rest.issues.createLabel({
        owner,
        repo,
        name: LABEL,
        color: "ededed",
        description: "Created by the Graft e2e runner",
      });
      io.out(`label ${LABEL}: created\n`);
    }
  }

  // 5. The outsider.
  if (s.outsider && s.clients.outsider) {
    if (sandbox.visibility === "private") {
      const sees = async () => {
        try {
          await s.clients.outsider?.rest.repos.get({ owner, repo });
          return true;
        } catch (e) {
          if (classifyGitHubError(e) === "not_found") return false;
          throw e;
        }
      };
      if (!(await sees())) {
        if (o.inviteOutsider && o.yes && write) {
          const res = await s.clients.actor.rest.repos.addCollaborator({
            owner,
            repo,
            username: s.outsider.login,
            permission: "push",
          });
          const url = (res.data as { html_url?: string } | undefined)?.html_url;
          io.out(`invitation sent to ${s.outsider.login}${url ? `: ${url}` : ""}\n`);
          io.out("the outsider must accept it in the browser; waiting up to 10 minutes\n");
          await waitUntil(
            sees,
            { name: "outsider invitation accepted", timeoutMs: TIMEOUTS.invitation },
            {
              now: () => deps.now().getTime(),
              sleep: deps.sleep,
            },
          );
          io.out("outsider has access\n");
        } else {
          io.out("outsider cannot see the sandbox: rerun with --invite-outsider --yes\n");
        }
      } else io.out("outsider: has access\n");
    } else io.out("outsider: public sandbox, the fork is created by s08\n");
  }

  // 6. The App.
  let installationId = 0;
  try {
    const { data } = await s.clients.app.rest.apps.getRepoInstallation({ owner, repo });
    installationId = data.id;
    s.guard.installationId = data.id;
  } catch (e) {
    if (classifyGitHubError(e) !== "not_found") throw e;
    const slug = s.config.githubAppSlug;
    io.out(
      slug
        ? `install the App on the sandbox (Only select repositories): https://github.com/apps/${slug}/installations/new\n`
        : "install the App on the sandbox (Only select repositories); set GITHUB_APP_SLUG to print the link\n",
    );
    return 3;
  }
  const inst = await s.clients.app.rest.apps.getInstallation({ installation_id: installationId });
  io.out(
    `App installation ${installationId}: repository_selection ${inst.data.repository_selection}, ` +
      `permissions ${Object.keys(inst.data.permissions ?? {}).length}, events ${(inst.data.events ?? []).join(",")}\n`,
  );
  {
    const { data: repoNow } = await s.clients.actor.rest.repos.get({ owner, repo });
    const probe = await s.clients.probe(installationId);
    const facts = await readInstallationFacts(s.clients.app, probe, installationId);
    const problems = scopeProblems(
      facts,
      { repo: sandbox.repo, repositoryId: repoNow.id },
      s.sandboxConfig,
    );
    if (problems.length > 0) {
      throw new Abort(3, `preflight failed: installation_scope (${scopeMessage(problems)})`);
    }
  }
  const row = await s.db
    .selectFrom("installations")
    .select("id")
    .where("id", "=", installationId)
    .executeTakeFirst();
  const repoRow = await s.db
    .selectFrom("repositories")
    .select("id")
    .where("installation_id", "=", installationId)
    .where("full_name", "=", sandbox.repo)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  let code = 0;
  if (!row || !repoRow) {
    io.out(
      "Graft was not running at install: remove and re-add the repository in the App's installation settings\n",
    );
    code = 3;
  }

  // 7. sandbox.json
  if (write) {
    const { data: repoData } = await s.clients.actor.rest.repos.get({ owner, repo });
    await ensurePrivateDir(deps.outDir);
    const file = path.join(deps.outDir, "sandbox.json");
    await writeFileAtomic(
      file,
      `${JSON.stringify(
        {
          repo: sandbox.repo,
          visibility: sandbox.visibility,
          repositoryId: repoData.id,
          installationId,
          actor: s.actor,
          outsider: s.outsider ?? null,
          outsiderMode: !s.outsider
            ? "none"
            : sandbox.visibility === "private"
              ? "collaborator"
              : "fork",
          updatedAt: deps.now().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
  return code;
}

/** One commit to main with the drifted files restored (Git Data API). */
async function restoreFixtures(
  s: Session,
  deps: E2eDeps,
  files: Map<string, string>,
  paths: readonly string[],
): Promise<void> {
  const { owner, repo, sandbox } = s;
  const octokit = s.clients.actor;
  const ref = `heads/${sandbox.defaultBranch}`;
  const tip = (await octokit.rest.git.getRef({ owner, repo, ref })).data.object.sha;
  const base = (await octokit.rest.git.getCommit({ owner, repo, commit_sha: tip })).data.tree.sha;
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const p of paths) {
    const blob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: files.get(p) as string,
      encoding: "utf-8",
    });
    entries.push({ path: p, mode: "100644", type: "blob", sha: blob.data.sha });
  }
  const tree = await octokit.rest.git.createTree({ owner, repo, base_tree: base, tree: entries });
  const who = { ...commitIdentity(s.actor), date: deps.now().toISOString() };
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: "Restore the Graft e2e fixtures",
    tree: tree.data.sha,
    parents: [tip],
    author: who,
    committer: who,
  });
  await octokit.rest.git.updateRef({ owner, repo, ref, sha: commit.data.sha, force: false });
}
